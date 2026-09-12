'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ShellSession, defaultDataDir } = require('./shell');
const { Store } = require('./store');
const { WebSocketServer } = require('./ws');
const { extractCommand, inspectCommand, truncateOutput, formatTerminalReply, stripAnsi } = require('./parser');
const { buildSystemPrompt } = require('./prompt');
const { streamChat, demoAssistant } = require('./llm');

const VERSION = require('../package.json').version;
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

class Bridge {
  constructor(options = {}) {
    this.dataDir = options.dataDir || defaultDataDir();
    this.store = new Store(this.dataDir);
    if (options.config) this.store.update(options.config);
    if (options.token) {
      this.store.config.token = options.token;
    }

    this.shell = new ShellSession({
      cwd: this.store.config.cwd || options.cwd || process.cwd(),
      timeoutMs: this.store.config.commandTimeoutMs,
    });
    this.shell.on('output', (e) => this.broadcast({ type: 'output', ...e }));
    this.shell.on('command-start', (e) => this.broadcast({ type: 'command-start', ...e }));
    this.shell.on('command-end', (e) => this.broadcast({ type: 'command-end', ...e }));
    this.shell.on('restart', (e) => this.broadcast({ type: 'restart', ...e }));
    this.shell.on('exit', (e) => this.broadcast({ type: 'shell-exit', ...e }));
    this.shell.on('error', (e) => this.broadcast({ type: 'error', message: String(e && e.message) }));

    this.wss = new WebSocketServer();
    this.pending = new Map(); // id -> {id, command, createdAt, decision, result, waiters}
    this.results = new Map(); // id -> result
    this.server = null;
    this.stats = { startedAt: Date.now(), executed: 0, denied: 0 };
  }

  get token() {
    return this.store.config.token;
  }

  broadcast(msg) {
    this.wss.broadcast({ ...msg, t: Date.now() });
  }

  systemPrompt() {
    return buildSystemPrompt({
      osLabel: this.shell.label,
      shell: this.shell.shell,
      cwd: this.shell.cwd,
    });
  }

  state() {
    return {
      version: VERSION,
      config: this.store.publicConfig(),
      shell: this.shell.info(),
      stats: { ...this.store.stats(), ...this.stats },
      history: this.store.history.slice(0, 60),
      pending: [...this.pending.values()].map((p) => ({
        id: p.id,
        command: p.command,
        createdAt: p.createdAt,
        reasons: p.reasons,
      })),
      clients: this.wss.size,
    };
  }

  start() {
    this.shell.start();
    return this;
  }

  /**
   * Основная точка входа: расширение присылает команду, мы её выполняем.
   * В режиме confirm команда ждёт подтверждения из панели.
   */
  async execute(command, meta = {}) {
    const clean = String(command || '').trim();
    if (!clean) {
      const err = new Error('Пустая команда');
      err.code = 'EMPTY';
      throw err;
    }
    const inspection = inspectCommand(clean);
    const id = crypto.randomBytes(8).toString('hex');
    const mode = meta.mode || this.store.config.approvalMode;
    const needsApproval = mode === 'confirm' || (inspection.dangerous && mode !== 'off');

    const entry = {
      id,
      command: clean,
      createdAt: Date.now(),
      status: 'queued',
      reasons: inspection.reasons,
      approvalRequired: needsApproval,
      source: meta.source || 'api',
      decision: null,
      result: null,
      waiters: [],
    };
    this.pending.set(id, entry);
    this.results.set(id, entry);
    this.broadcast({ type: 'request', ...this._publicEntry(entry) });

    if (needsApproval) {
      entry.status = 'awaiting-approval';
      this.broadcast({ type: 'approval-needed', ...this._publicEntry(entry) });
    } else {
      setImmediate(() => this._runEntry(entry));
    }
    return entry;
  }

  _publicEntry(e) {
    return {
      id: e.id,
      command: e.command,
      status: e.status,
      reasons: e.reasons,
      approvalRequired: e.approvalRequired,
      createdAt: e.createdAt,
      source: e.source,
      result: e.result
        ? {
            exitCode: e.result.exitCode,
            output: e.result.output,
            timedOut: e.result.timedOut,
            durationMs: e.result.durationMs,
            cwd: e.result.cwd,
            denied: !!e.result.denied,
          }
        : null,
    };
  }

  async _runEntry(entry) {
    entry.status = 'running';
    this.broadcast({ type: 'status', id: entry.id, status: 'running' });
    let res;
    try {
      res = await this.shell.run(entry.command, { timeoutMs: this.store.config.commandTimeoutMs });
    } catch (err) {
      res = { output: String(err && err.message), exitCode: -1, cwd: this.shell.cwd, durationMs: 0 };
    }
    entry.status = 'done';
    entry.result = {
      ...res,
      output: res.output,
      raw: undefined,
    };
    this.stats.executed += 1;
    this.store.push({
      id: entry.id,
      command: entry.command,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      timedOut: !!res.timedOut,
      cwd: res.cwd,
      at: Date.now(),
    });
    this.broadcast({ type: 'result', ...this._publicEntry(entry) });
    this._wakeWaiters(entry);
  }

  decide(id, approve, reason = '') {
    const entry = this.pending.get(id) || this.results.get(id);
    if (!entry) {
      const err = new Error('Запрос не найден');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (entry.status !== 'awaiting-approval') return entry;
    entry.decision = approve ? 'approved' : 'denied';

    if (!approve) {
      entry.status = 'denied';
      entry.result = {
        exitCode: -1,
        output: '',
        denied: true,
        reason,
        cwd: this.shell.cwd,
        durationMs: 0,
      };
      this.stats.denied += 1;
      this.store.push({
        id: entry.id,
        command: entry.command,
        exitCode: -1,
        denied: true,
        durationMs: 0,
        at: Date.now(),
      });
      this.broadcast({ type: 'result', ...this._publicEntry(entry) });
      this._wakeWaiters(entry);
      return entry;
    }

    setImmediate(() => this._runEntry(entry));
    return entry;
  }

  _wakeWaiters(entry) {
    for (const w of entry.waiters) {
      clearTimeout(w.timer);
      w.resolve(this._publicEntry(entry));
    }
    entry.waiters.length = 0;
    this.pending.delete(entry.id);
    if (this.results.size > 500) {
      const oldest = [...this.results.keys()].slice(0, this.results.size - 500);
      for (const k of oldest) this.results.delete(k);
    }
  }

  waitFor(id, waitMs = 25000) {
    const entry = this.pending.get(id) || this.results.get(id);
    if (!entry) {
      const err = new Error('Запрос не найден');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (entry.status === 'done' || entry.status === 'denied') return Promise.resolve(this._publicEntry(entry));
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = entry.waiters.indexOf(waiter);
        if (i >= 0) entry.waiters.splice(i, 1);
        resolve({ ...this._publicEntry(entry), timedOutWait: true });
      }, waitMs);
      waiter.timer.unref?.();
      entry.waiters.push(waiter);
    });
  }

  /** Собирает сообщение, которое расширение вставит в чат вместо пользователя. */
  replyFor(entry) {
    const r = entry.result || {};
    return formatTerminalReply({
      command: entry.command,
      output: r.denied ? '' : r.output || '',
      exitCode: r.denied ? -1 : (r.exitCode ?? -1),
      cwd: r.cwd,
      truncated: !!r.truncated,
      timedOut: !!r.timedOut,
      denied: !!r.denied,
    });
  }

  async close() {
    this.wss.close();
    this.shell.close();
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}

/** HTTP-слой поверх Bridge. */
function createServer(bridge, opts = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isUpgrade = false;

    // CORS: расширению нужно ходить на 127.0.0.1 со страницы https-чата.
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-agent-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    // Chrome Private Network Access: https-страница → 127.0.0.1
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      await route(req, res, url, bridge, opts);
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_REQUEST' ? 400 : err.code === 'UNAUTHORIZED' ? 401 : 500;
      sendJson(res, status, { error: String(err && err.message), code: err.code });
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    if (!authorized(url, req, bridge)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    bridge.wss.handleUpgrade(req, socket);
    socket.on('error', () => {});
  });

  return server;
}

function authorized(url, req, bridge) {
  const token = req.headers['x-agent-token'] || url.searchParams.get('token');
  return timingSafeEqualStr(token, bridge.token);
}

function requireAuth(url, req, bridge) {
  if (!authorized(url, req, bridge)) {
    const err = new Error('Требуется токен моста (x-agent-token)');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const err = new Error('Слишком большое тело запроса');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Тело запроса не является JSON');
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

function safeStatic(target) {
  const root = fs.realpathSync(WEB_DIR);
  const full = path.resolve(root, '.' + path.posix.normalize('/' + target.replace(/^\/+/, '')));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function route(req, res, url, bridge, opts) {
  const p = url.pathname;

  // ---- публичные (без токена) -------------------------------------------
  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      shell: bridge.shell.info(),
      approvalMode: bridge.store.config.approvalMode,
    });
  }

  if (p === '/api/whoami') {
    return sendJson(res, 200, { authorized: authorized(url, req, bridge), tokenHint: bridge.token.slice(-4) });
  }

  // ---- панель -----------------------------------------------------------
  if (p === '/' || p === '/index.html') {
    const file = path.join(WEB_DIR, 'index.html');
    let html = fs.readFileSync(file, 'utf8');
    // --preview: для песочниц/демо пробрасываем токен в страницу без query.
    // По умолчанию выключено — панель требует токен.
    const ok = authorized(url, req, bridge) || !!(opts && opts.preview);
    const bootstrap = {
      token: ok ? bridge.token : null,
      host: req.headers.host,
      secure: !!req.socket.encrypted,
      version: VERSION,
      approvalMode: bridge.store.config.approvalMode,
      demoMode: !!opts.demoMode,
    };
    html = html.replace('<!--BOOTSTRAP-->', `<script>window.__AGENT_BOOT__=${JSON.stringify(bootstrap)};</script>`);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (p.startsWith('/assets/')) {
    // парсер отдаём прямо из bridge/, чтобы браузер и расширение использовали
    // ровно тот же код, что и сервер
    if (p === '/assets/parser.js') {
      const parserFile = path.join(__dirname, 'parser.js');
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(parserFile));
    }
    const file = safeStatic(p.replace('/assets/', ''));
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return res.end(fs.readFileSync(file));
  }

  // ---- API --------------------------------------------------------------
  requireAuth(url, req, bridge);

  if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, bridge.state());

  if (p === '/api/prompt' && req.method === 'GET') {
    const text = bridge.systemPrompt();
    if (url.searchParams.get('format') === 'raw') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    return sendJson(res, 200, { text, nudge: require('./prompt').NUDGE });
  }

  if (p === '/api/execute' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.command) {
      const err = new Error('Нужно поле command');
      err.code = 'BAD_REQUEST';
      throw err;
    }
    const entry = await bridge.execute(body.command, { source: body.source || 'api', mode: body.mode });
    return sendJson(res, 200, bridge._publicEntry(entry));
  }

  const resultMatch = /^\/api\/result\/([a-f0-9]+)$/.exec(p);
  if (resultMatch && req.method === 'GET') {
    const waitMs = Math.min(60000, Math.max(0, parseInt(url.searchParams.get('wait') || '25000', 10)));
    const entry = await bridge.waitFor(resultMatch[1], waitMs);
    const payload = { ...entry };
    if (entry.result || entry.status === 'denied') {
      const truncated = truncateOutput(entry.result.output || '', bridge.store.config.maxOutputChars);
      payload.reply = bridge.replyFor({ ...entry, result: { ...entry.result, output: truncated.text, truncated: truncated.truncated } });
      payload.result = { ...entry.result, truncated: truncated.truncated };
    }
    return sendJson(res, 200, payload);
  }

  if (p === '/api/decision' && req.method === 'POST') {
    const body = await readJson(req);
    const entry = bridge.decide(body.id, !!body.approve, body.reason || '');
    return sendJson(res, 200, bridge._publicEntry(entry));
  }

  if (p === '/api/abort' && req.method === 'POST') {
    const killed = await bridge.shell.abort({ force: true });
    return sendJson(res, 200, { ok: true, killed });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    const cwd = bridge.shell.cwd;
    bridge.shell.close();
    bridge.shell = new ShellSession({ cwd, timeoutMs: bridge.store.config.commandTimeoutMs });
    bridge.shell.on('output', (e) => bridge.broadcast({ type: 'output', ...e }));
    bridge.shell.on('command-start', (e) => bridge.broadcast({ type: 'command-start', ...e }));
    bridge.shell.on('command-end', (e) => bridge.broadcast({ type: 'command-end', ...e }));
    bridge.shell.on('restart', (e) => bridge.broadcast({ type: 'restart', ...e }));
    bridge.shell.start();
    bridge.broadcast({ type: 'restart', reason: 'manual', ...bridge.shell.info() });
    return sendJson(res, 200, { ok: true, shell: bridge.shell.info() });
  }

  if (p === '/api/cd' && req.method === 'POST') {
    const body = await readJson(req);
    const cwd = await bridge.shell.changeDir(body.path);
    bridge.broadcast({ type: 'cwd', cwd });
    return sendJson(res, 200, { ok: true, cwd });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const body = await readJson(req);
    const cfg = bridge.store.update(body);
    bridge.shell.defaultTimeoutMs = bridge.store.config.commandTimeoutMs;
    bridge.broadcast({ type: 'config', config: cfg });
    return sendJson(res, 200, { ok: true, config: cfg });
  }

  if (p === '/api/token/rotate' && req.method === 'POST') {
    const token = bridge.store.rotateToken();
    return sendJson(res, 200, { ok: true, token });
  }

  /** Разбор сырого ответа модели — удобно для отладки адаптеров. */
  if (p === '/api/parse' && req.method === 'POST') {
    const body = await readJson(req);
    const found = extractCommand(body.text || '');
    return sendJson(res, 200, {
      found: !!found,
      command: found ? found.command : null,
      source: found ? found.source : null,
      inspection: found ? inspectCommand(found.command) : null,
      reply: found
        ? formatTerminalReply({
            command: found.command,
            output: 'Wrote 1 file\nDone in 1.2s',
            exitCode: 0,
            cwd: bridge.shell.cwd,
          })
        : null,
    });
  }

  /**
   * Чат панели. Stream (SSE): события `delta`, `done`, `error`.
   * Если API-ключ не задан — работает демо-ассистент (терминал при этом настоящий).
   */
  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const { llm } = bridge.store.config;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      let text;
      if (llm.apiKey) {
        const full = [{ role: 'system', content: bridge.systemPrompt() }, ...messages];
        text = await streamChat({
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          messages: full,
          onDelta: (d) => send('delta', { text: d }),
        });
        send('done', { text, engine: llm.model });
      } else {
        text = demoAssistant(messages);
        // имитируем потоковый вывод, чтобы UI вёл себя так же, как с настоящей моделью
        for (const ch of text) {
          send('delta', { text: ch });
          await new Promise((r) => setTimeout(r, 4));
        }
        send('done', { text, engine: 'demo-assistant' });
      }
    } catch (err) {
      send('error', { message: String(err && err.message) });
    }
    return res.end();
  }

  if (p === '/api/history' && req.method === 'GET') return sendJson(res, 200, { history: bridge.store.history });

  return sendJson(res, 404, { error: 'not found', path: p });
}

module.exports = { Bridge, createServer, VERSION };
