'use strict';

/**
 * Адаптеры сайтов: как найти поле ввода и кнопку отправки.
 *
 * Поиск самой команды селекторов НЕ требует — content.js ищет маркер
 * [EXECUTE] прямо в DOM, поэтому работает и на сайтах, которых тут нет.
 * Адаптер нужен только для обратного действия: вставить вывод терминала
 * в поле ввода и нажать «отправить».
 *
 * `input`  — список CSS-селекторов поля ввода, по порядку приоритета.
 * `send`   — список CSS-селекторов кнопки отправки (если не найдена — жмём Enter).
 * `ready`  — признак, что модель закончила печатать (нет спиннера/курсора).
 */

const AGENT_ADAPTERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    input: ['div#prompt-textarea[contenteditable="true"]', 'div[contenteditable="true"][data-testid="text-input"]', 'textarea#prompt-textarea'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Отправить"]'],
    stop: ['button[data-testid="stop-button"]'],
    streaming: ['button[data-testid="stop-button"]'],
    // у ChatGPT поле ввода — ProseMirror, текст кладём через textContent
    inputKind: 'prosemirror',
  },
  {
    id: 'claude',
    name: 'Claude',
    hosts: ['claude.ai'],
    input: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
    send: ['button[aria-label="Send Message"]', 'button[aria-label="Отправить сообщение"]', 'button[aria-label="Send"]'],
    streaming: ['button[aria-label="Stop response"]'],
    inputKind: 'prosemirror',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    hosts: ['gemini.google.com', 'aistudio.google.com'],
    input: ['div.ql-editor[contenteditable="true"]', 'rich-textarea div[contenteditable="true"]', 'textarea[aria-label="Введите запрос"]'],
    send: ['button[aria-label="Send message"]', 'button[aria-label="Отправить сообщение"]', 'send-button button'],
    streaming: ['button[aria-label="Stop response"]'],
    inputKind: 'prosemirror',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hosts: ['chat.deepseek.com'],
    input: ['textarea#chat-input', 'textarea'],
    send: ['button[data-testid="send-button"]', 'div.ds-button[type="primary"]'],
    inputKind: 'textarea',
  },
  {
    id: 'copilot',
    name: 'Microsoft Copilot',
    hosts: ['copilot.microsoft.com'],
    input: ['div#codex-companion-textarea[contenteditable="true"]', 'textarea#copilot-text-area'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Отправить"]'],
    inputKind: 'prosemirror',
  },
  {
    id: 'mistral',
    name: 'Le Chat (Mistral)',
    hosts: ['chat.mistral.ai'],
    input: ['textarea[placeholder]', 'div[contenteditable="true"]'],
    send: ['button[aria-label="Send message"]', 'button[type="submit"]'],
    inputKind: 'textarea',
  },
  {
    id: 'bridge',
    name: 'Панель моста (демо)',
    hosts: ['127.0.0.1', 'localhost'],
    input: ['textarea#chat-text'],
    send: ['button#btn-send'],
    inputKind: 'textarea',
  },
];

/** Совпадение по hostname, включая поддомены. */
function matchAdapter(hostname) {
  const host = String(hostname || '').toLowerCase();
  for (const a of AGENT_ADAPTERS) {
    for (const h of a.hosts) {
      if (host === h || host.endsWith('.' + h)) return a;
    }
  }
  return null;
}

/** Универсальный адаптер для любого сайта: последнее видимое поле ввода. */
const GENERIC_ADAPTER = {
  id: 'generic',
  name: 'Другой сайт',
  hosts: [],
  input: ['textarea:not([readonly])', 'div[contenteditable="true"]'],
  send: [],
  inputKind: 'auto',
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AGENT_ADAPTERS, matchAdapter, GENERIC_ADAPTER };
}
if (typeof globalThis !== 'undefined') {
  globalThis.AGENT_ADAPTERS = AGENT_ADAPTERS;
  globalThis.matchAdapter = matchAdapter;
  globalThis.GENERIC_ADAPTER = GENERIC_ADAPTER;
}
