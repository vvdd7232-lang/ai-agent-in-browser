'use strict';

/**
 * Content script: замыкает цикл «ответ ИИ → терминал → ответ ИИ».
 *
 * Как находим команду. Мы НЕ пытаемся угадать селекторы «сообщений ассистента»
 * на каждом сайте — они меняются каждый месяц. Вместо этого ищем в DOM сам
 * маркер [EXECUTE]: он уникален и появляется ровно тогда, когда модель
 * действительно просит выполнить команду. Поэтому расширение работает и на
 * ChatGPT, и на Claude, и на любом самописном чате.
 *
 * Второй важный момент — стабильность. Модель печатает ответ потоково, и
 * блок кода существует ещё до того, как команда дописана. Поэтому команду
 * выполняем только если её текст не менялся STABLE_MS миллисекунд.
 */

(() => {
  if (window.__aiAgentBridgeLoaded) return;
  window.__aiAgentBridgeLoaded = true;

  const P = window.AiAgentParser;
  if (!P) {
    console.warn('[ai-agent] parser.js не загрузился — расширение не работает');
    return;
  }

  const STABLE_MS = 900;
  const SCAN_DEBOUNCE_MS = 350;
  const MAX_PROCESSED = 200;

  const MARKER_RE = /\[\s*(?:EXECUTE|EXEC|RUN)\s*\]/i;

  const S = {
    config: null,
    active: false,
    paused: false,
    busy: false,
    observer: null,
    scanTimer: null,
    stableTimer: null,
    lastSignature: '',
    lastChangeAt: 0,
    processed: new Set(),
    lastReply: '',
    log: [],
  };

  /* -------------------------------------------------------------- утилиты */

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function log(kind, text) {
    S.log.unshift({ t: Date.now(), kind, text });
    if (S.log.length > 40) S.log.length = 40;
    hud.render();
  }

  /* ------------------------------------------------- поиск блоков кода -- */

  function textOf(el) {
    return (el.textContent || '').replace(/\u00a0/g, ' ');
  }

  /** Кандидаты: блоки кода, а если их нет — самые глубокие узлы с маркером. */
  function collectCandidates() {
    const gate = (document.body && document.body.textContent) || '';
    if (!MARKER_RE.test(gate)) return [];

    const found = [];
    const seen = new Set();

    const push = (el, text) => {
      const t = String(text || '').trim();
      if (t.length < 6 || t.length > 8000) return;
      if (!MARKER_RE.test(t)) return;
      const key = hash(t);
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ el, text: t });
    };

    // 1) fenced-блоки кода — основной случай
    for (const el of document.querySelectorAll('pre code, pre, code')) {
      if (!el.isConnected) continue;
      push(el, textOf(el));
    }

    // 2) запасной вариант: модель написала маркер обычным текстом
    if (!found.length) {
      const all = document.querySelectorAll('p, li, div, span');
      for (const el of all) {
        if (el.children.length > 3) continue;
        const t = el.innerText || el.textContent || '';
        if (!MARKER_RE.test(t)) continue;
        // берём только «листовые» держатели, чтобы не задвоить
        let nested = false;
        for (const child of el.querySelectorAll('*')) {
          if ((child.innerText || '').match(MARKER_RE)) {
            nested = true;
            break;
          }
        }
        if (!nested) push(el, t);
      }
    }

    return found;
  }

  /** Текст «дописан»? Сравниваем сигнатуру всех кандидатов с предыдущей. */
  function signatureOf(candidates) {
    return candidates.map((c) => hash(c.text)).join('|');
  }

  /* ------------------------------------------------------------ цикл ---- */

  function scheduleScan() {
    if (S.scanTimer) clearTimeout(S.scanTimer);
    S.scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  function scan() {
    if (!S.active || S.paused || S.busy) return;

    const candidates = collectCandidates();
    const signature = signatureOf(candidates);

    if (signature !== S.lastSignature) {
      S.lastSignature = signature;
      S.lastChangeAt = Date.now();
      // текст меняется — модель ещё печатает, вернёмся позже
      if (S.stableTimer) clearTimeout(S.stableTimer);
      S.stableTimer = setTimeout(scan, STABLE_MS + 120);
      return;
    }

    if (!candidates.length) return;
    if (Date.now() - S.lastChangeAt < STABLE_MS) {
      if (S.stableTimer) clearTimeout(S.stableTimer);
      S.stableTimer = setTimeout(scan, STABLE_MS);
      return;
    }

    // берём самый последний необработанный кандидат
    const fresh = candidates.filter((c) => !S.processed.has(hash(c.text)));
    if (!fresh.length) return;
    const candidate = fresh[fresh.length - 1];
    handleCandidate(candidate);
  }

  async function handleCandidate(candidate) {
    const parsed = P.extractCommand(candidate.text);
    if (!parsed) {
      S.processed.add(hash(candidate.text));
      return;
    }

    const command = parsed.command;
    const key = hash(candidate.text);
    S.processed.add(key);
    if (S.processed.size > MAX_PROCESSED) {
      S.processed = new Set([...S.processed].slice(-MAX_PROCESSED / 2));
    }

    if (!command) return;

    S.busy = true;
    hud.setStatus('busy', 'выполняю команду');
    hud.setCommand(command);
    log('cmd', command);

    try {
      const entry = await send('execute', { command, meta: { source: 'extension', url: location.href } });
      if (entry && entry.error) throw new Error(entry.error);

      const reply = entry.reply || '';
      S.lastReply = reply;
      const r = entry.result || {};
      const ok = !r.denied && r.exitCode === 0;
      hud.setStatus(ok ? 'ok' : 'err', ok ? `готово · exit ${r.exitCode}` : r.denied ? 'отклонено' : `ошибка · exit ${r.exitCode}`);
      log(ok ? 'ok' : 'err', `${command.split('\n')[0]} → exit ${r.exitCode}`);

      const injected = await injectReply(reply);
      if (injected) log('ok', 'вывод вставлен в чат и отправлен');
      else log('warn', 'вывод вставлен, но отправить автоматически не вышло — нажми Enter');
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      hud.setStatus('err', 'ошибка: ' + message.slice(0, 60));
      log('err', message);
    } finally {
      S.busy = false;
    }
  }

  /* ------------------------------------------------ вставка ответа ----- */

  function currentAdapter() {
    return window.matchAdapter(location.hostname) || window.GENERIC_ADAPTER;
  }

  function findInput(adapter) {
    for (const sel of adapter.input || []) {
      const el = document.querySelector(sel);
      if (visible(el)) return { el, kind: adapter.inputKind === 'auto' ? guessKind(el) : adapter.inputKind };
    }
    // универсальный поиск: самое нижнее видимое поле ввода на странице
    const pool = [...document.querySelectorAll('textarea:not([readonly]), div[contenteditable="true"], [role="textbox"]')].filter(visible);
    if (!pool.length) return null;
    pool.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const el = pool[0];
    return { el, kind: guessKind(el) };
  }

  function guessKind(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return 'textarea';
    return 'prosemirror';
  }

  function findSendButton(adapter) {
    for (const sel of adapter.send || []) {
      const el = document.querySelector(sel);
      if (visible(el) && !el.disabled) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setEditableText(el, value) {
    el.focus();
    // выделяем всё и заменяем — так ProseMirror/Slate получают нормальное событие
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    let done = false;
    try {
      done = document.execCommand('insertText', false, value);
    } catch {
      done = false;
    }
    if (!done || (el.textContent || '').trim() === '') {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function injectReply(reply) {
    const adapter = currentAdapter();
    const target = findInput(adapter);
    if (!target) {
      log('warn', 'не нашёл поле ввода — вывод скопирован в буфер обмена');
      copyToClipboard(reply);
      return false;
    }

    const { el, kind } = target;
    if (kind === 'textarea') setNativeValue(el, reply);
    else setEditableText(el, reply);

    await wait(160);

    if (!S.config || S.config.autoSubmit === false) {
      log('info', 'автоотправка выключена — текст в поле ввода');
      return false;
    }

    const before = kind === 'textarea' ? el.value : el.textContent || '';
    const btn = findSendButton(adapter);
    if (btn) {
      btn.click();
    } else {
      pressEnter(el);
    }

    await wait(900);
    const after = kind === 'textarea' ? el.value : el.textContent || '';
    const cleared = (after || '').trim().length < (before || '').trim().length;

    if (!cleared) {
      // кнопка не сработала — пробуем Enter, потом оставляем на откуп пользователю
      pressEnter(el);
      await wait(700);
      const after2 = kind === 'textarea' ? el.value : el.textContent || '';
      return (after2 || '').trim().length < (before || '').trim().length;
    }
    return true;
  }

  function copyToClipboard(text) {
    try {
      navigator.clipboard.writeText(text).catch(() => {});
    } catch {}
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ------------------------------------------------------------- HUD ---- */

  const hud = {
    root: null,
    el: {},
    open: false,

    ensure() {
      if (this.root) return;
      const host = document.createElement('div');
      host.id = 'ai-agent-hud-host';
      host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
          .box {
            width: 286px; background: rgba(12,16,24,.97); color: #dbe3ef;
            border: 1px solid #26314a; border-radius: 12px; overflow: hidden;
            box-shadow: 0 12px 40px rgba(0,0,0,.5); font-size: 12px;
            backdrop-filter: blur(10px);
          }
          .head { display:flex; align-items:center; gap:8px; padding:9px 11px; cursor:move;
                  background: linear-gradient(180deg,#161d2b,#101725); border-bottom:1px solid #212a3a; }
          .head b { font-size: 12px; letter-spacing:.2px; }
          .dot { width:8px; height:8px; border-radius:50%; background:#7d8aa0; flex:none; }
          .dot.ok { background:#4ade80; box-shadow:0 0 8px #4ade80; }
          .dot.err { background:#f87171; box-shadow:0 0 8px #f87171; }
          .dot.busy { background:#fbbf24; box-shadow:0 0 8px #fbbf24; animation:p 1s infinite; }
          @keyframes p { 50% { opacity:.3 } }
          .st { flex:1; color:#9fb0c6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .body { padding: 10px 11px; display:none; }
          .box.open .body { display:block; }
          .cmd { background:#080d15; border:1px solid #1c2740; border-radius:8px; padding:7px 8px;
                 font-family: ui-monospace, Menlo, Consolas, monospace; font-size:10.5px; color:#9fd3f5;
                 white-space:pre-wrap; word-break:break-word; max-height:110px; overflow:auto; }
          .row { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
          button { flex:1; background:#182132; color:#dbe3ef; border:1px solid #28344d; border-radius:7px;
                   padding:6px 8px; font-size:11px; cursor:pointer; }
          button:hover { background:#1f2b40; }
          button.x { flex:none; padding:2px 7px; background:transparent; border-color:transparent; color:#7d8aa0; }
          .log { margin-top:8px; max-height:150px; overflow:auto; font-family: ui-monospace, Menlo, monospace;
                 font-size:10px; color:#7d8aa0; line-height:1.5; }
          .log div { border-top:1px dashed #1c2740; padding:3px 0; word-break:break-word; }
          .log .ok { color:#86efac } .log .err { color:#fca5a5 } .log .warn { color:#fcd34d }
          .log .cmd { border:none; background:none; padding:0; color:#93a3b8; max-height:none; }
          .foot { padding:6px 11px; border-top:1px solid #1b2334; color:#5d6b82; font-size:10px; }
        </style>
        <div class="box" id="box">
          <div class="head" id="head">
            <span class="dot" id="dot"></span>
            <b>AI Agent</b>
            <span class="st" id="st">инициализация</span>
            <button class="x" id="toggle">▾</button>
            <button class="x" id="close">✕</button>
          </div>
          <div class="body">
            <div class="cmd" id="cmd">—</div>
            <div class="row">
              <button id="pause">⏸ пауза</button>
              <button id="resend">⤓ вывод в поле</button>
              <button id="clear">очистить</button>
            </div>
            <div class="log" id="log"></div>
          </div>
          <div class="foot" id="foot"></div>
        </div>
      `;
      (document.body || document.documentElement).appendChild(host);
      this.root = shadow;
      this.el = {
        box: shadow.getElementById('box'),
        dot: shadow.getElementById('dot'),
        st: shadow.getElementById('st'),
        cmd: shadow.getElementById('cmd'),
        log: shadow.getElementById('log'),
        foot: shadow.getElementById('foot'),
      };

      shadow.getElementById('toggle').addEventListener('click', () => {
        this.open = !this.open;
        this.el.box.classList.toggle('open', this.open);
        shadow.getElementById('toggle').textContent = this.open ? '▴' : '▾';
      });
      shadow.getElementById('close').addEventListener('click', () => host.remove());
      shadow.getElementById('pause').addEventListener('click', (e) => {
        S.paused = !S.paused;
        e.target.textContent = S.paused ? '▶ продолжить' : '⏸ пауза';
        this.setStatus(S.paused ? 'err' : 'ok', S.paused ? 'на паузе' : 'слушаю чат');
      });
      shadow.getElementById('resend').addEventListener('click', async () => {
        if (!S.lastReply) return log('warn', 'нет последнего вывода');
        await injectReply(S.lastReply);
      });
      shadow.getElementById('clear').addEventListener('click', () => {
        S.processed.clear();
        log('info', 'кэш обработанных блоков очищен');
      });

      this.makeDraggable(host, shadow.getElementById('head'));
      this.open = true;
      this.el.box.classList.add('open');
    },

    makeDraggable(host, handle) {
      let sx = 0;
      let sy = 0;
      let ox = 0;
      let oy = 0;
      let dragging = false;
      handle.addEventListener('mousedown', (e) => {
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        const rect = host.getBoundingClientRect();
        ox = rect.left;
        oy = rect.top;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        host.style.left = ox + e.clientX - sx + 'px';
        host.style.top = oy + e.clientY - sy + 'px';
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
      });
    },

    setStatus(kind, text) {
      this.ensure();
      this.el.dot.className = 'dot ' + kind;
      this.el.st.textContent = text;
    },

    setCommand(cmd) {
      this.ensure();
      this.el.cmd.textContent = cmd;
    },

    render() {
      if (!this.root) return;
      this.el.log.innerHTML = '';
      for (const item of S.log.slice(0, 14)) {
        const div = document.createElement('div');
        if (item.kind !== 'info') div.className = item.kind;
        div.textContent = `${new Date(item.t).toLocaleTimeString()} · ${item.text}`;
        this.el.log.appendChild(div);
      }
      const adapter = currentAdapter();
      this.el.foot.textContent = `${adapter.name} · ${S.active ? (S.paused ? 'пауза' : 'слушаю') : 'выключено'} · обработано ${S.processed.size}`;
    },
  };

  /* ------------------------------------------------- связь с background -- */

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || {});
        });
      } catch (err) {
        resolve({ error: String(err && err.message) });
      }
    });
  }

  async function bootstrap() {
    const res = await send('bootstrap', { origin: location.origin });
    if (!res || res.error) {
      if (res && res.error) console.debug('[ai-agent]', res.error);
      return;
    }
    S.config = res.config;
    S.active = !!res.active;

    if (S.active) {
      hud.ensure();
      const ok = res.status && res.status.ok;
      hud.setStatus(
        ok && res.status.authorized ? 'ok' : 'err',
        !ok ? 'мост не запущен' : !res.status.authorized ? 'неверный токен' : `слушаю · ${res.status.shell ? res.status.shell.kind : ''}`
      );
      hud.render();
      startObserving();
    } else {
      stopObserving();
      if (hud.root) hud.setStatus('err', 'выключено на этом сайте');
    }
  }

  function startObserving() {
    if (S.observer) return;
    S.observer = new MutationObserver(scheduleScan);
    S.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scheduleScan();
  }

  function stopObserving() {
    if (S.observer) {
      S.observer.disconnect();
      S.observer = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'broadcast' && msg.payload && msg.payload.type === 'status') {
      hud.setStatus('busy', msg.payload.text);
      return;
    }
    if (msg.type === 'config-changed' || msg.type === 'rebootstrap') {
      S.processed.clear();
      bootstrap();
    }
    if (msg.type === 'rescan') {
      S.processed.clear();
      scan();
    }
  });

  // страница может перерисоваться целиком — периодически перепроверяем
  setInterval(() => {
    if (S.active && !S.busy) scan();
  }, 2500);

  bootstrap();
})();
