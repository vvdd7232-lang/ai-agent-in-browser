'use strict';

/* Панель моста: чат + терминал + настройки. Без сборки, без зависимостей. */

/* Версия JS панели. Висит в диагностике на экране-замке: если там версия
   не совпадает с кодом в репозитории — браузер держит протухшую страницу.
   Дублируем в заголовок вкладки, чтобы протухший таб был виден с порога. */
const APP_JS_VERSION = 'g4-diag';
document.title = `${document.title} · ${APP_JS_VERSION}`;

const P = window.AiAgentParser;
const $ = (sel) => document.querySelector(sel);

const boot = window.__AGENT_BOOT__ || {};
const state = {
  token: boot.token || localStorage.getItem('agent-token') || '',
  ws: null,
  reconnect: 0,
  chat: [],
  running: false,
  steps: 0,
  maxSteps: 24,
  pendingApproval: null,
  abortLoop: false,
  termBuf: '',
};

/* ------------------------------------------------------------------ api -- */

function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers['x-agent-token'] = state.token;
  if (opts.body && typeof opts.body === 'object') {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(path, { ...opts, headers }).then(async (res) => {
    if (res.status === 401) {
      showGate('Токен неверный или устарел');
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });
}

/* ---------------------------------------------------------------- ansi ---- */

const ANSI_SPLIT = /\u001b\[([0-9;]*)m/;

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ansiToHtml(raw) {
  const st = { fg: null, bg: false, b: false, i: false, u: false, dim: false };
  let out = '';
  let rest = String(raw);

  const openTags = () => {
    let cls = '';
    if (st.fg !== null) cls += ` a-fg-${st.fg}`;
    if (st.bg) cls += ' a-bg';
    if (st.b) cls += ' a-b';
    if (st.i) cls += ' a-i';
    if (st.u) cls += ' a-u';
    if (st.dim) cls += ' a-dim';
    return cls.trim();
  };

  let openClass = openTags();
  let opened = false;
  if (openClass) {
    out += `<span class="${openClass}">`;
    opened = true;
  }

  while (rest.length) {
    const m = ANSI_SPLIT.exec(rest);
    if (!m) {
      out += esc(rest);
      break;
    }
    out += esc(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);

    const codes = (m[1] === '' ? [0] : m[1].split(';')).map((c) => parseInt(c, 10) || 0);
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 0) Object.assign(st, { fg: null, bg: false, b: false, i: false, u: false, dim: false });
      else if (c === 1) st.b = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.i = true;
      else if (c === 4) st.u = true;
      else if (c === 22) { st.b = false; st.dim = false; }
      else if (c === 23) st.i = false;
      else if (c === 24) st.u = false;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c === 38) {
        if (codes[i + 1] === 5) { st.fg = map256(codes[i + 2]); i += 2; }
        else if (codes[i + 1] === 2) { st.fg = mapRgb(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4; }
      } else if (c === 39) st.fg = null;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c === 49) st.bg = false;
      else if (c === 48) { st.bg = true; i += codes[i + 1] === 5 ? 2 : 4; }
      else if (c >= 40 && c <= 47) st.bg = true;
    }

    // закрывающий тег — только если действительно есть что закрывать,
    // иначе в innerHTML уезжали лишние </span>
    if (opened) out += '</span>';
    openClass = openTags();
    if (openClass) {
      out += `<span class="${openClass}">`;
      opened = true;
    } else {
      opened = false;
    }
  }
  if (opened) out += '</span>';
  return out;
}

function map256(n) {
  if (n === undefined) return null;
  if (n < 16) return n; // 0..15 — базовая и яркая палитры, классы a-fg-0…a-fg-15
  return 7; // остальные 240 цветов — в ближайший «обычный» белый
}
function mapRgb(r, g, b) {
  if (r === undefined) return null;
  const lum = (r * 299 + g * 587 + b * 114) / 1000;
  return lum > 128 ? 15 : 0;
}

/* -------------------------------------------------------------- elements -- */

const chatLog = $('#chat-log');
const term = $('#term');
const statusText = $('#status-text');

function setPill(id, cls, text) {
  const el = $(id);
  el.className = `pill ${cls}` + (el.classList.contains('mono') ? ' mono' : '');
  el.querySelector('span').textContent = text;
}

function setStatus(text) {
  statusText.textContent = text;
}

/* ---------------------------------------------------------------- terminal - */

function termAppend(html, cls = '') {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.innerHTML = html;
  term.appendChild(div);
  while (term.childElementCount > 1500) term.removeChild(term.firstChild);
  term.scrollTop = term.scrollHeight;
}

function termCommand(cmd, cwd) {
  termAppend(
    `<span class="t-cmd"><span class="sign">${esc(shortPrompt(cwd))}</span>${esc(cmd)}</span>`
  );
}

function termOutput(clean) {
  if (!clean) return;
  const div = document.createElement('div');
  div.className = 't-out';
  div.innerHTML = ansiToHtml(clean);
  term.appendChild(div);
  while (term.childElementCount > 1500) term.removeChild(term.firstChild);
  term.scrollTop = term.scrollHeight;
}

function shortPrompt(cwd) {
  if (!cwd) return '$';
  const home = cwd.match(/^\/(?:home|Users)\/[^/]+/);
  const short = home ? '~' + cwd.slice(home[0].length) : cwd;
  return short.length > 42 ? '…' + short.slice(-40) : short;
}

/* ------------------------------------------------------------------- chat -- */

function addMessage(role, text, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent =
    opts.who ||
    (role === 'user'
      ? 'ты'
      : role === 'assistant'
        ? 'ИИ-агент'
        : role === 'terminal'
          ? 'мост · терминал'
          : role === 'error'
            ? 'ошибка'
            : 'система');
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  wrap.append(who, body);
  chatLog.appendChild(wrap);
  chatLog.scrollTop = chatLog.scrollHeight;
  return body;
}

function addCommandChip(command, statusTextChip, failed) {
  const chip = document.createElement('div');
  chip.className = 'cmd-chip' + (failed ? ' failed' : '') + (statusTextChip === 'ждём' ? ' wait' : '');
  chip.innerHTML = `<span class="badge">${esc(statusTextChip)}</span><span></span>`;
  chip.lastElementChild.textContent = command;
  chatLog.appendChild(chip);
  chatLog.scrollTop = chatLog.scrollHeight;
  return chip;
}

function updateChip(chip, label, failed) {
  if (!chip) return;
  chip.classList.toggle('failed', !!failed);
  chip.classList.toggle('wait', label === 'ждём');
  chip.querySelector('.badge').textContent = label;
}

async function streamChat(messages, onDelta) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': state.token },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final = null;
  let engine = 'demo-assistant';
  let errMsg = null;

  while (final === null && errMsg === null) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const frame of frames) {
      const lines = frame.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const json = JSON.parse(data);
      if (event === 'delta') onDelta(json.text || '');
      else if (event === 'done') {
        final = json.text;
        engine = json.engine;
      } else if (event === 'error') errMsg = json.message;
    }
  }
  if (errMsg) throw new Error(errMsg);
  return { text: final || '', engine };
}

/** Один полный цикл: спросили модель → нашли [EXECUTE] → выполнили → вернули вывод. */
async function runAgentLoop(userText) {
  if (state.running) return;
  state.running = true;
  state.abortLoop = false;
  $('#btn-send').disabled = true;
  setStatus('агент работает…');

  state.chat.push({ role: 'user', content: userText });

  try {
    let hitLimit = false;
    while (!state.abortLoop) {
      if (state.steps >= state.maxSteps) {
        hitLimit = true;
        break;
      }
      state.steps += 1;

      // 1) ответ модели
      let acc = '';
      const body = addMessage('assistant', '');
      const { text, engine } = await streamChat(state.chat, (delta) => {
        acc += delta;
        body.textContent = acc;
        chatLog.scrollTop = chatLog.scrollHeight;
      });
      const assistantText = text || acc;
      body.textContent = assistantText;
      $('#engine-label').textContent = 'движок: ' + engine;
      state.chat.push({ role: 'assistant', content: assistantText });

      // 2) ищем блок [EXECUTE] — тем же парсером, что и расширение
      const found = P.extractCommand(assistantText);
      if (!found) {
        setStatus('агент завершил задачу');
        break;
      }

      const markers = P.countExecuteMarkers(assistantText);
      if (markers > 1) {
        addMessage('system', `В ответе ${markers} блока [EXECUTE] — беру только первый, как требует промпт.`);
      }

      // 3) выполняем
      const chip = addCommandChip(found.command, 'ждём', false);
      const inspection = P.inspectCommand(found.command);

      let approvedByUser = false;
      if (!$('#chk-autorun').checked || inspection.dangerous) {
        approvedByUser = await askApproval(found.command, inspection.reasons);
        if (!approvedByUser) {
          updateChip(chip, 'отклонено', true);
          const denial = P.formatTerminalReply({ command: found.command, output: '', exitCode: -1, cwd: null, denied: true });
          addMessage('terminal', denial);
          state.chat.push({ role: 'user', content: denial });
          continue;
        }
      }

      // Пользователь уже разрешил команду здесь, в чате — мосту повторно
      // спрашивать нечего. Раньше уходило mode:'auto', мост держал опасную
      // команду в awaiting-approval, панель весь long-poll ждала, а потом
      // рапортовала модели об «ошибке» команды, которая даже не запускалась.
      const started = await api('/api/execute', {
        method: 'POST',
        body: {
          command: found.command,
          source: 'panel-chat',
          mode: approvedByUser ? 'off' : 'auto',
        },
      });
      updateChip(chip, 'выполняется', false);

      let entry = await api(`/api/result/${started.id}?wait=55000`);
      if (entry.status === 'awaiting-approval') {
        // мост всё равно ждёт решения (например, в настройках включён confirm) —
        // согласие пользователя у нас уже есть, отдаём его мосту
        await api('/api/decision', { method: 'POST', body: { id: started.id, approve: true } });
        entry = await api(`/api/result/${started.id}?wait=55000`);
      }

      if (!entry.result) {
        // результата нет — честно сообщаем модели, а не выдумываем exit code
        updateChip(chip, entry.status || 'нет результата', true);
        const stalled = P.formatTerminalReply({
          command: found.command,
          output: `Мост не вернул результат (статус: ${entry.status || 'неизвестен'}). Команда не выполнена.`,
          exitCode: -1,
          cwd: null,
        });
        addMessage('terminal', stalled);
        state.chat.push({ role: 'user', content: stalled });
        continue;
      }

      const r = entry.result;
      const failed = !!r.denied || r.exitCode !== 0;
      updateChip(chip, failed ? `exit ${r.exitCode}` : `ok · ${r.durationMs}мс`, failed);

      // 4) подставляем вывод обратно в диалог — ровно как это делает расширение
      const reply = entry.reply || P.formatTerminalReply({ command: found.command, output: r.output || '', exitCode: r.exitCode ?? -1, cwd: r.cwd });
      addMessage('terminal', reply);
      state.chat.push({ role: 'user', content: reply });
    }

    if (hitLimit) {
      addMessage('system', `Достигнут лимит в ${state.maxSteps} шагов — цикл остановлен.`);
    }
  } catch (err) {
    addMessage('error', String(err && err.message ? err.message : err));
    setStatus('ошибка');
  } finally {
    state.running = false;
    state.steps = 0;
    $('#btn-send').disabled = false;
    if (statusText.textContent === 'агент работает…') setStatus('готов');
  }
}

function askApproval(command, reasons) {
  return new Promise((resolve) => {
    const box = $('#chat-approve');
    $('#approve-cmd').textContent = (reasons && reasons.length ? `⚠ ${reasons.join(', ')}\n` : '') + command;
    box.hidden = false;
    const ok = () => cleanup(true);
    const no = () => cleanup(false);
    function cleanup(v) {
      box.hidden = true;
      $('#btn-approve').removeEventListener('click', ok);
      $('#btn-deny').removeEventListener('click', no);
      resolve(v);
    }
    $('#btn-approve').addEventListener('click', ok);
    $('#btn-deny').addEventListener('click', no);
  });
}

/* ------------------------------------------------------------- websocket -- */

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.onopen = () => {
    state.reconnect = 0;
    setPill('#pill-bridge', 'ok', 'мост подключён');
    setStatus('готов');
  };
  ws.onclose = () => {
    setPill('#pill-bridge', 'err', 'мост недоступен');
    setStatus('переподключение…');
    state.reconnect += 1;
    setTimeout(connectWs, Math.min(5000, 500 * state.reconnect));
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(msg);
  };
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'command-start':
      termCommand(msg.command, msg.cwd);
      $('#term-state').textContent = 'выполняется';
      setPill('#pill-shell', 'busy', 'shell занят');
      break;
    case 'output': {
      // chunk — сырой вывод вместе с ANSI-кодами, ansiToHtml их раскрашивает;
      // clean (текст без кодов) мост отправляет модели. Раньше терминал
      // рисовал clean, и весь конвертер цветов просто не получал работу.
      const text = msg.chunk == null ? msg.clean : msg.chunk;
      if (text) termOutput(text);
      break;
    }
    case 'command-end': {
      const cls = msg.exitCode === 0 ? 't-ok' : 't-err';
      const label = msg.timedOut ? 'ПРЕВЫШЕН ТАЙМАУТ' : `exit ${msg.exitCode}`;
      termAppend(`<span class="t-meta ${cls}">↳ ${esc(label)} · ${msg.durationMs}мс · ${esc(msg.cwd || '')}</span>`);
      $('#term-state').textContent = 'ожидание';
      setPill('#pill-shell', 'ok', msg.cwd ? msg.cwd.split('/').pop() : 'shell');
      $('#pill-cwd').textContent = msg.cwd || '';
      refreshState();
      break;
    }
    case 'cwd':
      $('#pill-cwd').textContent = msg.cwd;
      $('#term-prompt').textContent = shortPrompt(msg.cwd);
      break;
    case 'restart':
      termAppend(`<span class="t-info">⟳ shell перезапущен (${esc(msg.reason || '')})</span>`);
      break;
    case 'approval-needed':
      termAppend(`<span class="t-warn">⚠ требуется подтверждение: ${esc(msg.command.slice(0, 120))}</span>`);
      break;
    case 'config':
      applyConfig(msg.config);
      break;
    case 'ping':
      break;
    default:
      break;
  }
}

/* ---------------------------------------------------------------- state --- */

async function refreshState() {
  try {
    const s = await api('/api/state');
    $('#pill-cwd').textContent = s.shell.cwd;
    $('#term-prompt').textContent = shortPrompt(s.shell.cwd);
    $('#pill-count').textContent = `${s.stats.total} cmd · ${s.stats.failed} err`;
    setPill('#pill-shell', s.shell.busy ? 'busy' : 'ok', `${s.shell.kind} · ${s.shell.label}`);
    applyConfig(s.config);
    $('#status-token').textContent = boot.open
      ? `режим без токена (--insecure) · клиентов: ${s.clients}`
      : `token ••••${state.token.slice(-4)} · клиентов: ${s.clients}`;
    return s;
  } catch {
    return null;
  }
}

function applyConfig(cfg) {
  if (!cfg) return;
  $('#set-approval').value = cfg.approvalMode;
  $('#set-maxout').value = cfg.maxOutputChars;
  $('#set-timeout').value = cfg.commandTimeoutMs;
  $('#set-llm-url').value = cfg.llm.baseUrl || '';
  $('#set-llm-model').value = cfg.llm.model || '';
  $('#set-llm-key').placeholder = cfg.llm.apiKey ? `задан (${cfg.llm.apiKey})` : 'sk-...';
  $('#set-llm-key').value = '';
}

async function loadPrompt() {
  try {
    const { text, nudge } = await api('/api/prompt');
    $('#prompt-preview').textContent = text;
    state.prompt = text;
    state.nudge = nudge;
  } catch (err) {
    $('#prompt-preview').textContent = 'не удалось загрузить промпт: ' + err.message;
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ скопировано';
  setTimeout(() => {
    btn.textContent = old;
  }, 1400);
}

/* ----------------------------------------------------------------- gate --- */

/**
 * Диагностика прямо на замке: какая версия JS в браузере, какой режим у
 * сервера, жив ли shell. По этим строкам любой спор «кто протух» решается
 * одним скриншотом.
 */
async function fillGateDiag(extra) {
  const diag = $('#gate-diag');
  if (!diag) return;
  const lines = [];
  lines.push(`страница: app.js ${APP_JS_VERSION} · парсер ${window.AiAgentParser ? 'ok' : 'НЕ ЗАГРУЗИЛСЯ'}`);
  lines.push(`bootstrap: open=${!!boot.open} · token=${boot.token ? 'есть' : 'нет'} · server v${boot.version || '?'}`);
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    lines.push(
      `сервер: v${h.version} · insecure=${!!h.insecure} · shell ${h.shell ? h.shell.kind : '?'} ${h.shell && h.shell.alive ? '(жив)' : '(мёртв)'}`
    );
    if (h.insecure) $('#btn-open-login').hidden = false;
  } catch (err) {
    lines.push('сервер: /api/health не отвечает (' + ((err && err.message) || err) + ')');
  }
  if (extra) lines.push(extra);
  diag.textContent = lines.join('\n');
}

function showGate(msg) {
  $('#token-gate').hidden = false;
  if (msg) $('#token-error').textContent = msg;
  fillGateDiag();
}

/* ----------------------------------------------------------------- init --- */

function bind() {
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ta = $('#chat-text');
    const text = ta.value.trim();
    if (!text || state.running) return;
    ta.value = '';
    addMessage('user', text);
    runAgentLoop(text);
  });

  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });

  $('#btn-clear-chat').addEventListener('click', () => {
    state.chat = [];
    chatLog.querySelectorAll('.msg:not(.system), .cmd-chip').forEach((n) => n.remove());
  });

  $('#btn-clear-term').addEventListener('click', () => {
    term.innerHTML = '';
  });

  $('#btn-abort').addEventListener('click', async () => {
    state.abortLoop = true;
    try {
      const r = await api('/api/abort', { method: 'POST' });
      termAppend(`<span class="t-warn">■ прервано (убито процессов: ${r.killed})</span>`);
    } catch (err) {
      termAppend(`<span class="t-err">${esc(err.message)}</span>`);
    }
  });

  $('#term-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#term-text');
    const cmd = input.value.trim();
    if (!cmd) return;
    input.value = '';
    try {
      const started = await api('/api/execute', { method: 'POST', body: { command: cmd, source: 'panel-manual', mode: 'off' } });
      await api(`/api/result/${started.id}?wait=55000`);
    } catch (err) {
      termAppend(`<span class="t-err">${esc(err.message)}</span>`);
    }
  });

  $('#btn-copy-prompt').addEventListener('click', (e) => copyText(state.prompt || '', e.currentTarget));
  $('#btn-copy-nudge').addEventListener('click', (e) => copyText(state.nudge || '', e.currentTarget));

  $('#btn-save-config').addEventListener('click', async () => {
    try {
      const r = await api('/api/config', {
        method: 'POST',
        body: {
          approvalMode: $('#set-approval').value,
          maxOutputChars: parseInt($('#set-maxout').value, 10),
          commandTimeoutMs: parseInt($('#set-timeout').value, 10),
        },
      });
      applyConfig(r.config);
      setStatus('настройки сохранены');
    } catch (err) {
      setStatus('ошибка: ' + err.message);
    }
  });

  $('#btn-save-llm').addEventListener('click', async () => {
    try {
      const patch = {
        llm: {
          baseUrl: $('#set-llm-url').value.trim(),
          model: $('#set-llm-model').value.trim(),
        },
      };
      const key = $('#set-llm-key').value.trim();
      if (key) patch.llm.apiKey = key;
      const r = await api('/api/config', { method: 'POST', body: patch });
      applyConfig(r.config);
      setStatus(key ? 'LLM сохранён' : 'LLM обновлён');
    } catch (err) {
      setStatus('ошибка: ' + err.message);
    }
  });

  $('#btn-reset').addEventListener('click', async () => {
    await api('/api/reset', { method: 'POST' });
    term.innerHTML = '';
    termAppend('<span class="t-info">⟳ новая shell-сессия</span>');
    refreshState();
  });

  $('#token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const v = $('#token-input').value.trim();
    if (!v) {
      $('#token-error').textContent = 'Вставь токен — он в чёрном окне моста, строка «● Токен».';
      return;
    }
    // клик всегда должен давать заметную реакцию, иначе кажется, что «ничего не происходит»
    const old = btn.textContent;
    btn.textContent = 'Проверяю…';
    btn.disabled = true;
    $('#token-error').textContent = '';
    state.token = v;
    localStorage.setItem('agent-token', v);
    const ok = await api('/api/state').then(() => true).catch(() => false);
    btn.disabled = false;
    btn.textContent = old;
    if (ok) {
      $('#token-gate').hidden = true;
      boot0();
    } else {
      $('#token-error').textContent =
        'Токен не подошёл. Скопируй его заново из чёрного окна моста (строка «● Токен») — при каждом запуске моста он может быть новым.';
      fillGateDiag();
      $('#token-input').select();
    }
  });

  $('#btn-open-login').addEventListener('click', () => {
    boot.open = true;
    $('#insecure-banner').hidden = false;
    $('#token-gate').hidden = true;
    boot0();
  });
}

async function boot0() {
  await Promise.all([refreshState(), loadPrompt()]);
  connectWs();
}

async function tryPreviewToken() {
  // В режиме --preview сервер отдаёт токен сам, чтобы панель в песочнице
  // логинилась без ручного ввода. Без флага эндпоинт возвращает 404.
  try {
    const res = await fetch('/api/preview-token');
    if (!res.ok) return false;
    const data = await res.json();
    if (data && data.token) {
      state.token = data.token;
      localStorage.setItem('agent-token', data.token);
      return true;
    }
  } catch {}
  return false;
}

(async function init() {
  bind();

  // Режим сервера спрашиваем ДО любых решений: даже если браузер прислал
  // протухший bootstrap, открытый режим виден по публичному /api/health.
  let serverOpen = !!boot.open;
  try {
    const h = await (await fetch('/api/health')).json();
    if (h && h.insecure) serverOpen = true;
  } catch {}

  if (serverOpen) {
    boot.open = true;
    $('#insecure-banner').hidden = false;
  }

  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) {
    state.token = urlToken;
    localStorage.setItem('agent-token', urlToken);
    history.replaceState(null, '', location.pathname);
  }
  if (!state.token && !serverOpen) {
    const ok = await tryPreviewToken();
    if (!ok) {
      showGate();
      return;
    }
  }
  boot0().catch(() => showGate('Токен неверный'));
})();
