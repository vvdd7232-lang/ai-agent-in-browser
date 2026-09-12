'use strict';

/**
 * Service worker расширения.
 *
 * Зачем он нужен: fetch из content script идёт с origin страницы чата
 * (https://chatgpt.com), а мост живёт на http://127.0.0.1 — это заблокировал бы
 * CORS. Запрос из service worker с выданным host_permissions проходит свободно.
 */

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:7788',
  token: '',
  enabled: false,
  autoSubmit: true,
  approvalMode: 'auto',
  siteEnabled: {}, // origin -> bool, переопределяет глобальный выключатель
  maxWaitMs: 240000,
};

async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function setConfig(patch) {
  await chrome.storage.local.set(patch || {});
  return getConfig();
}

function apiUrl(cfg, path) {
  return String(cfg.bridgeUrl || DEFAULTS.bridgeUrl).replace(/\/+$/, '') + path;
}

async function bridgeFetch(cfg, path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30000);
  try {
    const res = await fetch(apiUrl(cfg, path), {
      ...options,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-agent-token': cfg.token || '',
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function ping() {
  const cfg = await getConfig();
  if (!cfg.bridgeUrl) return { ok: false, error: 'не указан адрес моста' };
  try {
    const health = await bridgeFetch(cfg, '/api/health', { timeoutMs: 4000 });
    const authed = cfg.token
      ? await bridgeFetch(cfg, '/api/whoami', { timeoutMs: 4000 }).catch(() => ({ authorized: false }))
      : { authorized: false };
    return {
      ok: true,
      authorized: !!authed.authorized,
      version: health.version,
      shell: health.shell,
      approvalMode: health.approvalMode,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Полный цикл: отправляем команду мосту и ждём результат.
 * В режиме confirm мост держит запрос до подтверждения в панели,
 * поэтому ждём long-poll'ом столько, сколько разрешил пользователь.
 */
async function executeCommand(command, meta = {}) {
  const cfg = await getConfig();
  if (!cfg.token) throw new Error('не задан токен моста');

  const started = await bridgeFetch(cfg, '/api/execute', {
    method: 'POST',
    body: JSON.stringify({ command, source: meta.source || 'extension', mode: cfg.approvalMode }),
    timeoutMs: 15000,
  });

  const deadline = Date.now() + (cfg.maxWaitMs || DEFAULTS.maxWaitMs);
  let entry = started;
  while (Date.now() < deadline) {
    entry = await bridgeFetch(cfg, `/api/result/${started.id}?wait=25000`, { timeoutMs: 40000 });
    if (entry.status === 'done' || entry.status === 'denied') return entry;
    notify({ type: 'status', text: entry.status === 'awaiting-approval' ? 'жду подтверждения в панели' : 'выполняется…' });
  }
  const err = new Error('мост не вернул результат вовремя');
  err.entry = entry;
  throw err;
}

/** Отдаём вкладке свежий конфиг + результат проверки моста. */
async function bootstrap(origin) {
  const cfg = await getConfig();
  const site = origin ? cfg.siteEnabled[origin] : undefined;
  const active = site === undefined ? cfg.enabled : !!site;
  const status = await ping();
  return {
    config: cfg,
    active,
    siteOverridden: site !== undefined,
    status,
  };
}

function notify(msg) {
  chrome.runtime.sendMessage({ type: 'broadcast', payload: msg }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'ping':
          return sendResponse(await ping());
        case 'getConfig':
          return sendResponse(await getConfig());
        case 'setConfig':
          return sendResponse(await setConfig(msg.patch));
        case 'bootstrap':
          return sendResponse(await bootstrap(msg.origin || (sender.tab && sender.tab.url && new URL(sender.tab.url).origin)));
        case 'execute':
          return sendResponse(await executeCommand(msg.command, msg.meta || {}));
        case 'prompt': {
          const cfg = await getConfig();
          const data = await bridgeFetch(cfg, '/api/prompt', { timeoutMs: 8000 });
          return sendResponse(data);
        }
        default:
          return sendResponse({ error: 'unknown message type' });
      }
    } catch (err) {
      return sendResponse({ error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // ответ придёт асинхронно
});

chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await getConfig();
  if (!cfg.bridgeUrl) await setConfig({ bridgeUrl: DEFAULTS.bridgeUrl });
});
