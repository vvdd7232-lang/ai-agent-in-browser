'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { openBrowser, openCommand } = require('../bridge/open');

test('win32 открывает через cmd.exe, а не через несуществующий start', () => {
  const [cmd, args] = openCommand('win32', 'http://127.0.0.1:7788/?token=x');
  assert.strictEqual(cmd, 'cmd.exe');
  assert.strictEqual(args[0], '/c');
  assert.strictEqual(args[1], 'start');
  assert.ok(args.includes('http://127.0.0.1:7788/?token=x'));
});

test('darwin и linux используют open / xdg-open', () => {
  assert.strictEqual(openCommand('darwin', 'u')[0], 'open');
  assert.strictEqual(openCommand('linux', 'u')[0], 'xdg-open');
});

test('openBrowser не бросает исключение даже если браузера нет', () => {
  assert.doesNotThrow(() => openBrowser('http://127.0.0.1:1/'));
});
