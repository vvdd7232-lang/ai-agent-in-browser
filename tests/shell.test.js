'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { ShellSession } = require('../bridge/shell');

if (process.platform === 'win32') {
  // эти тесты написаны под POSIX-семантику (cd, pwd)
  console.log('shell.test: пропуск на win32');
  process.exit(0);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aib-test-'));
}

test('shell: выполняет команду и возвращает exit code', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const r = await s.run('echo hello');
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(r.output.trim(), 'hello');
  s.close();
});

test('shell: cd сохраняется между командами (живая сессия)', async () => {
  const dir = tmpDir();
  const s = new ShellSession({ cwd: dir });
  s.start();
  await s.run('mkdir sub && cd sub');
  const r = await s.run('pwd');
  assert.ok(r.output.trim().endsWith('/sub'), 'pwd должен быть внутри sub, получил: ' + r.output);
  s.close();
});

test('shell: ненулевой exit code не убивает сессию', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const bad = await s.run('exit 3');
  assert.notStrictEqual(bad.exitCode, 0);
  const good = await s.run('echo alive');
  assert.strictEqual(good.exitCode, 0);
  assert.strictEqual(good.output.trim(), 'alive');
  s.close();
});

test('shell: stderr попадает в output', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const r = await s.run('ls /this/does/not/exist 2>&1');
  assert.notStrictEqual(r.exitCode, 0);
  assert.ok(/No such file/i.test(r.output));
  s.close();
});

test('shell: ANSI-коды вычищаются из output', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const r = await s.run('printf "\\033[31mRED\\033[0m"');
  assert.strictEqual(r.output, 'RED');
  s.close();
});

test('shell: таймаут прерывает зависшую команду и оставляет сессию живой', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const t0 = Date.now();
  const r = await s.run('sleep 60', { timeoutMs: 700 });
  assert.ok(r.timedOut, 'должен быть флаг timedOut');
  assert.ok(Date.now() - t0 < 15000, 'не должно висеть');
  const after = await s.run('echo ok');
  assert.strictEqual(after.exitCode, 0);
  assert.strictEqual(after.output.trim(), 'ok');
  s.close();
});

test('shell: фоновый процесс тоже убивается по таймауту', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const r = await s.run('sleep 90 & sleep 91', { timeoutMs: 600 });
  assert.ok(r.timedOut);
  assert.ok(r.killed >= 1, 'убит хотя бы один процесс, killed=' + r.killed);
  s.close();
});

test('shell: changeDir валидирует путь', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  await assert.rejects(() => s.changeDir('/definitely/not/there'), /не найден/);
  s.close();
});
