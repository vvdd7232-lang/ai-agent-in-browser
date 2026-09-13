'use strict';

/**
 * Доступ к файлам проекта: панель (web/) и копия парсера.
 *
 * При обычном запуске (`node bin/cli.js`) они лежат на диске рядом с кодом.
 * В собранном исполняемом файле (Node SEA) диска нет — весь проект зашит внутрь
 * одного бинарника, и файлы отдаются как SEA-ассеты. Оба варианта закрывает
 * readProject(), поэтому остальному коду всё равно, чем именно запущен мост.
 */

const fs = require('node:fs');
const path = require('node:path');

let sea = null;
try {
  sea = require('node:sea');
} catch {
  sea = null;
}

/** Запущены ли мы как собранный бинарник (а не как `node bin/cli.js`). */
function isPacked() {
  return !!(sea && typeof sea.isSea === 'function' && sea.isSea());
}

/** Корень проекта на диске. В SEA не вызывается. */
function diskRoot() {
  const dir = typeof __dirname === 'string' ? __dirname : process.cwd();
  return path.resolve(dir, '..');
}

/**
 * Читает файл проекта по пути от корня (`web/index.html`, `bridge/parser.js`).
 * Возвращает Buffer или null, если файла нет.
 *
 * В дисковом режиме путь нормализуется и проверяется на выход за корень —
 * иначе `GET /assets/../../config.json` отдал бы чужой файл.
 */
function readProject(rel) {
  const name = String(rel || '').replace(/^\/+/, '');
  if (!name) return null;

  if (isPacked()) {
    try {
      // getAsset() без кодировки отдаёт ArrayBuffer — приводим к Buffer,
      // иначе res.end() падает, а toString('utf8') печатает «[object ArrayBuffer]»
      return Buffer.from(sea.getAsset(name));
    } catch {
      return null;
    }
  }

  const root = fs.realpathSync(diskRoot());
  const full = path.resolve(root, '.' + path.posix.normalize('/' + name));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try {
    if (fs.statSync(full).isDirectory()) return null;
    return fs.readFileSync(full);
  } catch {
    return null;
  }
}

module.exports = { isPacked, readProject, diskRoot };
