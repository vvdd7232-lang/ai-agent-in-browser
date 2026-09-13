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

test('shell: служебный сентинел не утекает в live-лог (событие output)', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const seen = [];
  s.on('output', (e) => seen.push(e.clean));
  const r = await s.run('echo marker-check');
  assert.strictEqual(r.output.trim(), 'marker-check');
  assert.ok(seen.length > 0, 'события output должны приходить');
  assert.ok(
    !seen.some((t) => String(t).includes('__AIAGENT_BRIDGE_')),
    'внутренний маркер моста не должен попадать в терминал: ' + JSON.stringify(seen)
  );
  s.close();
});

test('shell: abort считает каждый убитый процесс один раз', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  // процесс игнорирует SIGTERM — его приходится добивать SIGKILL;
  // раньше он попадал в счётчик и за TERM, и за KILL (killed = 2 вместо 1)
  const stubborn = 'bash -c \'trap "" TERM; while :; do :; done\'';
  const r = await s.run(stubborn, { timeoutMs: 600 });
  assert.ok(r.timedOut);
  assert.strictEqual(r.killed, 1, 'запущен один процесс, killed=' + r.killed);
  s.close();
});

test('shell: close() завершает текущую команду и очередь, а не вешает обещания', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  const current = s.run('sleep 5');
  const queued = s.run('echo never');
  setTimeout(() => s.close(), 200);

  const res = await current; // до фикса это обещание не разрешалось никогда
  assert.strictEqual(res.interrupted, true);
  assert.strictEqual(res.exitCode, -1);
  await assert.rejects(() => queued, /закрыта/i);
});

test('shell: changeDir валидирует путь', async () => {
  const s = new ShellSession({ cwd: tmpDir() });
  s.start();
  await assert.rejects(() => s.changeDir('/definitely/not/there'), /не найден/);
  s.close();
});
