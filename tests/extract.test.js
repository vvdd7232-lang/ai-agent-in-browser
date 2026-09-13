'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractExtension } = require('../bridge/extract');

test('extract: распаковывает расширение в каталог данных', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-ext-'));
  const { dir, changed } = extractExtension(dataDir);
  assert.strictEqual(dir, path.join(dataDir, 'extension'));
  assert.ok(changed, 'первый запуск должен что-то записать');

  for (const f of [
    'manifest.json',
    'background.js',
    'content.js',
    'adapters.js',
    'popup.html',
    'popup.js',
    'popup.css',
    'parser.js',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, f)), 'нет файла: ' + f);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.manifest_version, 3);

  const parser = fs.readFileSync(path.join(dir, 'parser.js'), 'utf8');
  assert.ok(parser.startsWith('// СГЕНЕРИРОВАННЫЙ ФАЙЛ'));
  assert.ok(parser.includes('extractCommand'));

  // парсер в расширении обязан совпадать с bridge/parser.js (после заголовка)
  const bridgeParser = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'parser.js'), 'utf8');
  assert.ok(parser.endsWith(bridgeParser));

  // повторный запуск — без перезаписи
  const second = extractExtension(dataDir);
  assert.strictEqual(second.changed, false);
});
