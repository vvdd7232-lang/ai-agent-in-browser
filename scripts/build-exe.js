#!/usr/bin/env node
'use strict';

/**
 * Сборка «одного файла» (bun build --compile).
 *
 * 1. Шинкует ресурсы (web/, extension/, bridge/parser.js) в
 *    build/assets.generated.cjs — бандлер Bun включит его внутрь .exe.
 * 2. Запускает bun build bin/cli.js --compile --target=... --outfile=dist/...
 *
 * Использование:
 *   node scripts/build-exe.js [win|linux|mac]     (по умолчанию win)
 *
 * Bun берётся из PATH или из node_modules/@oven/bun-<plat>-<arch>
 * (пакеты Bun лежат в optionalDependencies — ставятся только под
 * текущую платформу).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}

function buildManifest() {
  // держим extension/parser.js свежим (копия bridge/parser.js с заголовком)
  const { syncParser } = require('./build-extension');
  syncParser(false);

  const assets = {};
  for (const rel of [...walk(path.join(ROOT, 'web')), ...walk(path.join(ROOT, 'extension')), 'bridge/parser.js']) {
    assets[rel] = fs.readFileSync(path.join(ROOT, rel)).toString('base64');
  }

  const out = path.join(ROOT, 'build', 'assets.generated.cjs');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const banner =
    '// СГЕНЕРИРОВАННЫЙ ФАЙЛ (scripts/build-exe.js) — НЕ РЕДАКТИРУЙ.\n' +
    '// Ресурсы для собранного .exe: web/, extension/, bridge/parser.js.\n\n';
  fs.writeFileSync(out, banner + 'module.exports = { assets: ' + JSON.stringify(assets) + ' };\n');

  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`  ✓ build/assets.generated.cjs — ${Object.keys(assets).length} файлов, ${kb} KB`);
}

function findBun() {
  const isWin = process.platform === 'win32';
  const ext = isWin ? '.exe' : '';
  const local = path.join(ROOT, 'node_modules', '@oven', `bun-${process.platform}-${process.arch}`, 'bin', 'bun' + ext);
  if (fs.existsSync(local)) return local;
  const probe = spawnSync(isWin ? 'where' : 'which', ['bun'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

const TARGETS = {
  win: { target: 'bun-windows-x64', out: 'AI-Agent-Bridge.exe' },
  linux: { target: 'bun-linux-x64', out: 'AI-Agent-Bridge-linux' },
  mac: {
    target: `bun-macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
    out: 'AI-Agent-Bridge-mac',
  },
};

function main() {
  const platform = (process.argv[2] || 'win').toLowerCase();
  const spec = TARGETS[platform];
  if (!spec) {
    console.error(`Неизвестная цель: ${platform}. Есть: win, linux, mac.`);
    process.exit(2);
  }

  console.log(`Сборка: dist/${spec.out}  (${spec.target})`);
  buildManifest();

  const bun = findBun();
  if (!bun) {
    console.error('');
    console.error('Bun не найден. Варианты:');
    console.error('  1) npm install            (поставит bun под твою платформу)');
    console.error('  2) поставить bun вручную: https://bun.sh');
    process.exit(1);
  }

  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const outFile = path.join(ROOT, 'dist', spec.out);
  const args = [
    'build',
    path.join(ROOT, 'bin', 'cli.js'),
    '--compile',
    `--target=${spec.target}`,
    `--outfile=${outFile}`,
    // БЕЗ --minify: минификатор bun ломает require сгенерированного
    // манифеста ресурсов (build/assets.generated.cjs) в собранном бинарнике.
    // Код приложения маленький — выигрыш от minify нулевой, риск реальный.
  ];
  console.log('  $ ' + [bun, ...args].join(' '));
  const r = spawnSync(bun, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) process.exit(r.status || 1);

  const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ dist/${spec.out}  (${sizeMb} MB)`);
  console.log('');
  console.log('Как запустить: двойной клик по exe. Консоль напечатает ссылку');
  console.log('на панель, токен и папку расширения для Chrome.');
}

main();
