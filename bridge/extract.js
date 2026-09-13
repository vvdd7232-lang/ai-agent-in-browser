'use strict';

/**
 * Распаковывает браузерное расширение из бандла моста в каталог данных.
 *
 * Зачем: в готовом .exe (сборка через bun --compile) вся программа живёт
 * внутри одного исполняемого файла, а Chrome для «Load unpacked» нужен
 * обычный каталог с manifest.json. Поэтому при старте exe раскладывается
 * расширение в каталог данных (рядом с config.json) и держит его
 * синхронным с версией программы.
 */

const fs = require('node:fs');
const path = require('node:path');

const { readAsset } = require('./assets');

/** Все файлы расширения, кроме parser.js (он генерируется, см. ниже). */
const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'adapters.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

/**
 * Копия bridge/parser.js с заголовком — ровно то, что делает
 * scripts/build-extension.js. Парсер один и тот же и в мосте, и в расширении.
 */
function generatedParser() {
  const src = readAsset('bridge/parser.js');
  const header = Buffer.from(
    '// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактируй.\n' +
      '// Копия bridge/parser.js, создаётся при запуске моста (bridge/extract.js)\n' +
      '// или скриптом scripts/build-extension.js.\n\n',
    'utf8'
  );
  return Buffer.concat([header, src]);
}

/**
 * Раскладывает расширение в <dataDir>/extension, обновляя изменившиеся файлы.
 * @param {string} dataDir каталог данных моста (обычно ~/.ai-agent-in-browser)
 * @returns {{dir: string, changed: boolean}}
 */
function extractExtension(dataDir) {
  const dir = path.join(dataDir, 'extension');
  fs.mkdirSync(dir, { recursive: true });
  let changed = false;

  const writeIfChanged = (rel, data) => {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const current = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
    if (!current || !current.equals(data)) {
      fs.writeFileSync(dst, data);
      changed = true;
    }
  };

  for (const rel of EXTENSION_FILES) {
    writeIfChanged(rel, readAsset('extension/' + rel));
  }
  writeIfChanged('parser.js', generatedParser());

  return { dir, changed };
}

module.exports = { extractExtension, generatedParser, EXTENSION_FILES };
