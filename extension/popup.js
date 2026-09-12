'use strict';

const $ = (id) => document.getElementById(id);

let currentOrigin = '';
let cachedConfig = null;

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || {});
    });
  });
}

function setStatus(kind, text) {
  $('dot').className = 'dot ' + kind;
  $('status-text').textContent = text;
}

async function currentTabOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return new URL(tab.url).origin;
  } catch {
    return '';
  }
}

async function refresh() {
  currentOrigin = await currentTabOrigin();
  const boot = await send('bootstrap', { origin: currentOrigin });
  if (boot.error) {
    setStatus('err', boot.error);
    return;
  }
  cachedConfig = boot.config;

  $('url').value = boot.config.bridgeUrl || '';
  $('token').value = boot.config.token || '';
  $('approval').value = boot.config.approvalMode === 'confirm' ? 'confirm' : 'auto';
  $('enabled').checked = !!boot.active;
  $('autosubmit').checked = boot.config.autoSubmit !== false;
  $('version').textContent = 'v' + (chrome.runtime.getManifest().version || '');

  const s = boot.status || {};
  if (!s.ok) {
    setStatus('err', 'мост не отвечает: ' + (s.error || 'нет связи'));
    $('shell-info').textContent = 'Запусти: node bin/cli.js';
  } else if (!s.authorized) {
    setStatus('err', 'мост найден, но токен не подошёл');
    $('shell-info').textContent = 'Токен напечатан в консоли моста.';
  } else {
    setStatus('ok', `мост v${s.version} · ${s.shell ? s.shell.kind : ''} · ${s.approvalMode}`);
    $('shell-info').textContent = s.shell ? `${s.shell.label}\n${s.shell.cwd}\nкоманд выполнено: ${s.shell.commandCount}` : '';
  }

  const adapter = matchAdapterLabel(currentOrigin);
  $('adapter').textContent = adapter;
}

function matchAdapterLabel(origin) {
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    host = '';
  }
  const a = (window.AGENT_ADAPTERS || []).find((x) => x.hosts.some((h) => host === h || host.endsWith('.' + h)));
  return a ? `адаптер: ${a.name}` : 'адаптер: универсальный';
}

async function save(patch, message) {
  const res = await send('setConfig', { patch });
  cachedConfig = res;
  if (message) setStatus('ok', message);
  await refresh();
}

async function init() {
  await refresh();

  $('save').addEventListener('click', async () => {
    const patch = {
      bridgeUrl: $('url').value.trim().replace(/\/+$/, ''),
      token: $('token').value.trim(),
      approvalMode: $('approval').value,
      autoSubmit: $('autosubmit').checked,
    };
    await save(patch, 'сохранено');
    await tellTab('config-changed');
  });

  $('check').addEventListener('click', async () => {
    setStatus('', 'проверяю…');
    const res = await send('ping');
    if (res.ok && res.authorized) setStatus('ok', `мост v${res.version} · токен верный`);
    else if (res.ok) setStatus('err', 'мост отвечает, токен неверный');
    else setStatus('err', res.error || 'мост не отвечает');
  });

  $('enabled').addEventListener('change', async (e) => {
    const siteEnabled = { ...(cachedConfig.siteEnabled || {}), [currentOrigin]: e.target.checked };
    await save({ siteEnabled }, e.target.checked ? 'включено на этом сайте' : 'выключено на этом сайте');
    await tellTab('config-changed');
  });

  $('autosubmit').addEventListener('change', async (e) => {
    await save({ autoSubmit: e.target.checked }, e.target.checked ? 'автоотправка вкл' : 'автоотправка выкл');
    await tellTab('config-changed');
  });

  $('copy-prompt').addEventListener('click', async (e) => {
    const res = await send('prompt');
    if (res.error) return setStatus('err', res.error);
    await navigator.clipboard.writeText(res.text || '');
    flash(e.target, '✓ промпт скопирован');
  });

  $('copy-nudge').addEventListener('click', async (e) => {
    const res = await send('prompt');
    if (res.error) return setStatus('err', res.error);
    await navigator.clipboard.writeText(res.nudge || '');
    flash(e.target, '✓ скопировано');
  });

  $('rescan').addEventListener('click', async () => {
    await tellTab('rescan');
    setStatus('ok', 'страница пересканирована');
  });

  $('panel').addEventListener('click', async () => {
    const url = (cachedConfig && cachedConfig.bridgeUrl ? cachedConfig.bridgeUrl : 'http://127.0.0.1:7788') + '/';
    const full = cachedConfig && cachedConfig.token ? `${url}?token=${encodeURIComponent(cachedConfig.token)}` : url;
    chrome.tabs.create({ url: full });
  });
}

async function tellTab(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id !== undefined) {
    chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
  }
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = old;
  }, 1500);
}

init();
