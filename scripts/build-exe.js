#!/usr/bin/env node
'use strict';

/**
 * Сборка моста в ОДИН исполняемый файл (Node SEA — single executable application).
 *
 *   npm run build:exe          ->  dist/ai-agent-in-browser.exe    (Windows x64)
 *   npm run build:exe:linux    ->  dist/ai-agent-in-browser-linux  (Linux x64)
 *
 * Шаги:
 *   1. esbuild собирает весь CommonJS-проект в один бандл;
 *   2. `node --experimental-sea-config` превращает бандл в SEA-блоб и зашивает
 *      туда же файлы панели (web/) и копию парсера — в .exe диска с ними нет;
 *   3. блоб внедряется в копию node-бинарника (postject) — получается один файл,
 *      которому не нужен установленный Node.
 *
 * Бинарник Node берётся из npm-пакетов node-win-x64 / node-linux-x64, поэтому
 * .exe собирается из-под любой ОС — Windows для сборки не нужен. Версия
 * бинарника всегда равна версии Node, которой собирается блоб (иначе SEA
 * отказывается запускаться).
 *
 * Нужны dev-зависимости:  npm i -D esbuild postject
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Версия Node без префикса v — в npm версии публикуются без него. */
const NODE_VERSION = process.version.replace(/^v/, '');

/** Что зашиваем внутрь бинарника: читается через bridge/assets.js. */
const ASSETS = ['web/index.html', 'web/styles.css', 'web/app.js', 'bridge/parser.js'];

const TARGETS = {
  win: { pkg: 'node-win-x64', bin: 'node.exe', out: 'ai-agent-in-browser.exe' },
  linux: { pkg: 'node-linux-x64', bin: 'node', out: 'ai-agent-in-browser-linux' },
};

function log(msg) {
  console.log('  ' + msg);
}

/** 1) весь проект -> один CommonJS-бандл. */
async function bundle() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    throw new Error('нет esbuild: выполни `npm i -D esbuild postject`');
  }
  const outfile = path.join(DIST, 'bundle.cjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'scripts', 'sea-entry.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node' + process.versions.node.split('.')[0],
    outfile,
    legalComments: 'none',
    logLevel: 'warning',
  });
  log('бандл: dist/bundle.cjs (' + (fs.statSync(outfile).size / 1024).toFixed(0) + ' КБ)');
  return outfile;
}

/** 2) бандл + файлы панели -> SEA-блоб. */
function makeBlob(mainFile) {
  const blob = path.join(DIST, 'sea-prep.blob');
  const assets = {};
  for (const rel of ASSETS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error('нет файла для упаковки: ' + rel);
    assets[rel] = abs;
  }
  const cfg = path.join(DIST, 'sea-config.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify(
      { main: mainFile, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true, assets },
      null,
      2
    )
  );
  const r = spawnSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('не удалось собрать SEA-блоб');
  log('SEA-блоб: ' + (fs.statSync(blob).size / 1024).toFixed(0) + ' КБ');
  return blob;
}

/** 3) скачиваем node-бинарник нужной версии из npm (кэш в dist/.cache). */
async function fetchNodeBin(target) {
  const t = TARGETS[target];
  const cached = path.join(CACHE, `${t.pkg}-${NODE_VERSION}-${t.bin}`);
  if (fs.existsSync(cached)) {
    log('бинарник Node из кэша: ' + path.basename(cached));
    return cached;
  }

  const metaRes = await fetch(`https://registry.npmjs.org/${t.pkg}/${NODE_VERSION}`);
  if (!metaRes.ok) throw new Error(`в npm нет ${t.pkg}@${NODE_VERSION} (HTTP ${metaRes.status})`);
  const meta = await metaRes.json();

  log('качаю ' + t.pkg + '@' + NODE_VERSION + ' …');
  const res = await fetch(meta.dist.tarball);
  if (!res.ok) throw new Error('не удалось скачать ' + meta.dist.tarball);
  fs.mkdirSync(CACHE, { recursive: true });
  const tgz = path.join(CACHE, t.pkg + '.tgz');
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

  const dir = path.join(CACHE, 'unpack-' + t.pkg);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', tgz, '-C', dir], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('tar не смог распаковать архив');

  const bin = path.join(dir, 'package', 'bin', t.bin);
  if (!fs.existsSync(bin)) throw new Error('в архиве не оказалось ' + t.bin);
  fs.copyFileSync(bin, cached);
  return cached;
}

/**
 * Снимает Authenticode-подпись с копии node.exe — аналог `signtool remove-signature`,
 * который документация Node требует выполнить ДО внедрения SEA-блоба.
 *
 * Зачем: официальный node.exe подписан, и таблица сертификатов лежит хвостом
 * в самом конце файла. postject дописывает свою секцию туда же, запись о
 * подписи начинает указывать на мусор, и Windows видит битую подпись —
 * такой файл может вообще не запуститься. Возвращает true, если подпись была.
 */
function stripSignature(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.readUInt16LE(0) !== 0x5a4d) return false; // не PE
    const peOff = head.readUInt32LE(0x3c);
    if (head.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') return false;
    const opt = peOff + 4 + 20;
    const magic = head.readUInt16LE(opt);
    const dd = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
    if (dd < 0) return false;

    const at = dd + 4 * 8; // DataDirectory[4] — Certificate Table
    const offset = head.readUInt32LE(at);
    const size = head.readUInt32LE(at + 4);
    if (!offset || !size) return false; // подписи нет

    head.writeUInt32LE(0, at);
    head.writeUInt32LE(0, at + 4);
    fs.writeSync(fd, head, at, 8, at); // обнуляем запись в заголовке
    fs.ftruncateSync(fd, offset); // отрезаем сам сертификат в конце файла
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--target='));
  const target = arg ? arg.split('=')[1] : 'win';
  if (!TARGETS[target]) {
    console.error('Неизвестный --target. Бывает: ' + Object.keys(TARGETS).join(', '));
    process.exit(2);
  }

  fs.mkdirSync(DIST, { recursive: true });
  console.log(`Сборка ${target} x64 (Node ${NODE_VERSION}):`);

  const mainFile = await bundle();
  const blob = makeBlob(mainFile);
  const base = await fetchNodeBin(target);

  let postject;
  try {
    postject = require('postject');
  } catch {
    throw new Error('нет postject: выполни `npm i -D esbuild postject`');
  }

  const out = path.join(DIST, TARGETS[target].out);
  fs.copyFileSync(base, out);
  if (stripSignature(out)) log('подпись node.exe снята — иначе Windows увидел бы битую');
  await postject.inject(out, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: FUSE });
  if (target !== 'win') fs.chmodSync(out, 0o755);

  log('готово: ' + path.relative(ROOT, out) + ' (' + (fs.statSync(out).size / 1024 / 1024).toFixed(1) + ' МБ)');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nСборка не удалась: ' + (err && err.message));
    process.exit(1);
  });
}

module.exports = { main, bundle, makeBlob, fetchNodeBin, stripSignature, TARGETS, ASSETS };
