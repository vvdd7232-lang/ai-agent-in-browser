#!/usr/bin/env node
'use strict';

/**
 * Собирает каталог расширения:
 *  • копирует bridge/parser.js → extension/parser.js
 *    (один и тот же парсер должен работать и в Node, и в content script —
 *     поэтому он UMD, а копия создаётся здесь, а не ведётся руками);
 *  • генерирует иконки.
 *
 * Запускается из `npm run build:ext` и автоматически при старте моста.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { main: makeIcons } = require('./make-icons');

function syncParser(verbose = true) {
  const src = path.join(ROOT, 'bridge', 'parser.js');
  const dst = path.join(ROOT, 'extension', 'parser.js');
  const from = fs.readFileSync(src);
  const current = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (current && current.equals(from)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const header = Buffer.from(
    '// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактируй.\n' +
      '// Копия bridge/parser.js, делается скриптом scripts/build-extension.js\n' +
      '// (или автоматически при запуске `node bin/cli.js`).\n\n',
    'utf8'
  );
  fs.writeFileSync(dst, Buffer.concat([header, from]));
  if (verbose) console.log('  ✓ extension/parser.js обновлён из bridge/parser.js');
  return true;
}

function main() {
  console.log('Сборка расширения:');
  syncParser();
  makeIcons();
}

if (require.main === module) main();

module.exports = { syncParser, main };
