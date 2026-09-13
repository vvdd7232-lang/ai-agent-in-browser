'use strict';

/**
 * Загрузка ресурсов (панель web/, расширение extension/, bridge/parser.js).
 *
 * Работает и в обычном node/bun (файлы читаются прямо из репозитория —
 * всегда свежие), и в собранном .exe, где файлов на диске нет: тогда они
 * берутся из встроенного манифеста build/assets.generated.cjs, который
 * генерирует scripts/build-exe.js перед `bun build --compile`.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let embedded = null;
try {
  // В .exe этот require инлайнится бандлером; в dev без манифеста — catch.
  // Расширение .cjs указываем явно: require без расширения его не найдёт.
  const m = require('../build/assets.generated.cjs');
  if (m && m.assets) embedded = m.assets;
} catch {
  embedded = null;
}

const normKey = (rel) => String(rel).replace(/\\/g, '/').replace(/^\/+/, '');

/** Есть ли ключ во встроенном манифесте. */
function embeddedHas(key) {
  return !!(embedded && Object.prototype.hasOwnProperty.call(embedded, normKey(key)));
}

/** Взять ресурс из встроенного манифеста (Buffer или null). */
function getEmbedded(key) {
  const k = normKey(key);
  if (!embedded || !Object.prototype.hasOwnProperty.call(embedded, k)) return null;
  return Buffer.from(embedded[k], 'base64');
}

/**
 * Прочитать ресурс по пути относительно корня проекта ('web/index.html',
 * 'extension/manifest.json', 'bridge/parser.js').
 * Приоритет: файл на диске (dev) → встроенный манифест (.exe).
 */
function readAsset(rel) {
  const key = normKey(rel);
  if (key.split('/').some((s) => !s || s === '.' || s === '..')) {
    throw new Error('Недопустимый путь ресурса: ' + rel);
  }
  const disk = path.join(ROOT, key);
  try {
    if (fs.existsSync(disk)) return fs.readFileSync(disk);
  } catch {
    /* в .exe файлов на диске нет — дальше по манифесту */
  }
  const fromEmbedded = getEmbedded(key);
  if (fromEmbedded) return fromEmbedded;
  const err = new Error('Ресурс не найден: ' + key);
  err.code = 'ENOENT';
  throw err;
}

module.exports = { readAsset, getEmbedded, embeddedHas, ROOT };
