'use strict';

/**
 * Тесты клиентского кода панели (web/app.js).
 *
 * app.js — обычный браузерный скрипт без экспортов, поэтому нужная секция
 * вырезается из файла и выполняется как есть: проверяется ровно тот код,
 * который отдаётся браузеру, а не его копия.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app.js');

function loadPanelAnsi() {
  const src = fs.readFileSync(APP, 'utf8');
  const start = src.indexOf('const ANSI_SPLIT');
  const end = src.indexOf('/* -------------------------------------------------------------- elements -- */');
  assert.ok(start > 0 && end > start, 'в web/app.js не найдена секция с ANSI-рендером');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}\nreturn { ansiToHtml };`)();
}

function balance(html) {
  return {
    open: (html.match(/<span/g) || []).length,
    close: (html.match(/<\/span>/g) || []).length,
  };
}

test('панель: ansiToHtml выдаёт сбалансированный HTML', () => {
  const { ansiToHtml } = loadPanelAnsi();
  const samples = [
    '\u001b[31mred\u001b[0m plain \u001b[1mbold\u001b[0m',
    'текст без ansi-кодов',
    '\u001b[1;32mok\u001b[0m',
    '\u001b[0m\u001b[0mсброс в начале',
    '\u001b[38;5;196m256 цветов\u001b[39m',
    '\u001b[48;5;17mфон\u001b[49m',
  ];
  for (const input of samples) {
    const html = ansiToHtml(input);
    const { open, close } = balance(html);
    assert.strictEqual(open, close, `теги не сбалансированы для ${JSON.stringify(input)}: ${html}`);
  }
});

test('панель: ansiToHtml красит цвет и экранирует HTML из вывода', () => {
  const { ansiToHtml } = loadPanelAnsi();
  const html = ansiToHtml('\u001b[31m<b>x</b>\u001b[0m');
  assert.ok(html.includes('a-fg-1'), 'ожидался класс цвета: ' + html);
  assert.ok(html.includes('&lt;b&gt;'), 'HTML в выводе терминала должен экранироваться: ' + html);
});

test('панель: терминал получает сырой chunk с ANSI, а не вычищенный clean', () => {
  // мост шлёт оба поля; если рисовать clean, конвертер цветов остаётся без работы
  const src = fs.readFileSync(APP, 'utf8');
  assert.ok(src.includes('msg.chunk'), 'handleEvent должен брать msg.chunk (с ANSI-кодами)');
  assert.ok(!/case 'output':\s*\n\s*if \(msg\.clean\)/.test(src), 'старая ветка на msg.clean должна быть убрана');
});
