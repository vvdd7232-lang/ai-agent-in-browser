'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const { Bridge, createServer } = require('../bridge/server');

const TOKEN = 'test-token-123';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aib-srv-'));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port, method, path: p, agent: false, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let json = null;
          try {
            json = out ? JSON.parse(out) : null;
          } catch {}
          resolve({ status: res.statusCode, json, raw: out });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function mk() {
  const bridge = new Bridge({ dataDir: tmpDir(), cwd: tmpDir(), token: TOKEN, config: { approvalMode: 'auto' } });
  bridge.start();
  const server = createServer(bridge);
  return { bridge, server };
}

async function stop(bridge, server) {
  await bridge.close();
  if (server.closeAllConnections) server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

test('server: health открыт без токена, state закрыт', async () => {
  const { bridge, server } = mk();
  const port = await listen(server);

  const health = await req(port, 'GET', '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.json.ok, true);

  const state = await req(port, 'GET', '/api/state');
  assert.strictEqual(state.status, 401);

  await stop(bridge, server);
});

test('server: execute -> result, cwd сохраняется, reply сформирован', async () => {
  const { bridge, server } = mk();
  const port = await listen(server);
  const H = { 'x-agent-token': TOKEN };

  const ex = await req(port, 'POST', '/api/execute', { command: 'mkdir -p p && cd p && echo hi > f && pwd' }, H);
  assert.strictEqual(ex.status, 200);
  assert.ok(ex.json.id);

  const res = await req(port, 'GET', `/api/result/${ex.json.id}?wait=8000`, null, H);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.status, 'done');
  assert.strictEqual(res.json.result.exitCode, 0);
  assert.ok(res.json.result.cwd.endsWith('/p'));
  assert.ok(res.json.reply.startsWith('[TERMINAL]'));

  // следующая команда выполняется уже в /p
  const ex2 = await req(port, 'POST', '/api/execute', { command: 'ls' }, H);
  const res2 = await req(port, 'GET', `/api/result/${ex2.json.id}?wait=8000`, null, H);
  assert.strictEqual(res2.json.result.output.trim(), 'f');

  await stop(bridge, server);
});

test('server: confirm-режим держит команду до решения', async () => {
  const { bridge, server } = mk();
  bridge.store.update({ approvalMode: 'confirm' });
  const port = await listen(server);
  const H = { 'x-agent-token': TOKEN };

  const ex = await req(port, 'POST', '/api/execute', { command: 'echo secret' }, H);
  assert.strictEqual(ex.json.status, 'awaiting-approval');

  // результат ещё не готов
  const early = await req(port, 'GET', `/api/result/${ex.json.id}?wait=300`, null, H);
  assert.notStrictEqual(early.json.status, 'done');

  const dec = await req(port, 'POST', '/api/decision', { id: ex.json.id, approve: true }, H);
  assert.strictEqual(dec.status, 200);

  const res = await req(port, 'GET', `/api/result/${ex.json.id}?wait=8000`, null, H);
  assert.strictEqual(res.json.status, 'done');
  assert.strictEqual(res.json.result.output.trim(), 'secret');

  await stop(bridge, server);
});

test('server: отказ помечает результат denied и даёт подсказку модели', async () => {
  const { bridge, server } = mk();
  bridge.store.update({ approvalMode: 'confirm' });
  const port = await listen(server);
  const H = { 'x-agent-token': TOKEN };

  const ex = await req(port, 'POST', '/api/execute', { command: 'rm -rf /' }, H);
  await req(port, 'POST', '/api/decision', { id: ex.json.id, approve: false }, H);
  const res = await req(port, 'GET', `/api/result/${ex.json.id}?wait=4000`, null, H);
  assert.strictEqual(res.json.status, 'denied');
  assert.ok(res.json.reply.includes('ОТКЛОНИЛ'));

  await stop(bridge, server);
});

test('server: опасная команда требует подтверждения даже в auto-режиме', async () => {
  const { bridge, server } = mk();
  const port = await listen(server);
  const H = { 'x-agent-token': TOKEN };
  const ex = await req(port, 'POST', '/api/execute', { command: 'rm -rf /' }, H);
  assert.strictEqual(ex.json.status, 'awaiting-approval');
  assert.strictEqual(ex.json.approvalRequired, true);
  await req(port, 'POST', '/api/decision', { id: ex.json.id, approve: false }, H);
  await stop(bridge, server);
});

test('server: /api/prompt подставляет ОС', async () => {
  const { bridge, server } = mk();
  const port = await listen(server);
  const r = await req(port, 'GET', '/api/prompt', null, { 'x-agent-token': TOKEN });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.text.includes('продвинутый ИИ-агент'));
  assert.ok(!r.json.text.includes('{{OS_LABEL}}'), 'плейсхолдеры должны быть подставлены');
  await stop(bridge, server);
});

test('server: /api/parse находит команду в ответе модели', async () => {
  const { bridge, server } = mk();
  const port = await listen(server);
  const r = await req(
    port,
    'POST',
    '/api/parse',
    { text: '```bash\n# [EXECUTE]\nnpm test\n```' },
    { 'x-agent-token': TOKEN }
  );
  assert.strictEqual(r.json.found, true);
  assert.strictEqual(r.json.command, 'npm test');
  await stop(bridge, server);
});

test('server: панель отдаётся и принимает токен в query', async () => {
  const { bridge, server } = mk();
  const port = await listen(server);
  const page = await req(port, 'GET', `/?token=${TOKEN}`);
  assert.strictEqual(page.status, 200);
  assert.ok(page.raw.includes('AI Agent in Browser'));
  // токен должен быть проброшен в bootstrap
  assert.ok(page.raw.includes(TOKEN));
  await stop(bridge, server);
});

test('ext: extension/parser.js синхронизирован с bridge/parser.js', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'parser.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'extension', 'parser.js'), 'utf8');
  assert.ok(b.includes(a), 'расширение должно содержать актуальную копию парсера');
});
