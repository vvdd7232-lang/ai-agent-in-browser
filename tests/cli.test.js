'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs } = require('../bin/cli');

test('CLI: двойное и одинарное тире равнозначны (PowerShell переписывает -- в -)', () => {
  assert.strictEqual(parseArgs(['--insecure']).insecure, true);
  assert.strictEqual(parseArgs(['-insecure']).insecure, true);

  assert.strictEqual(parseArgs(['--no-open']).open, false);
  assert.strictEqual(parseArgs(['-no-open']).open, false);

  assert.strictEqual(parseArgs(['--preview']).preview, true);
  assert.strictEqual(parseArgs(['-preview']).preview, true);

  assert.strictEqual(parseArgs(['--port', '7791']).port, 7791);
  assert.strictEqual(parseArgs(['-port', '7791']).port, 7791);

  assert.strictEqual(parseArgs(['--cwd', '/tmp']).cwd, require('node:path').resolve('/tmp'));
  assert.strictEqual(parseArgs(['-cwd', '/tmp']).cwd, require('node:path').resolve('/tmp'));
});

test('CLI: по умолчанию автооткрытие браузера включено, insecure выключен', () => {
  const a = parseArgs([]);
  assert.strictEqual(a.open, true);
  assert.strictEqual(a.insecure, undefined);
});

/* -- запуск настоящего процесса: parseArgs молча пропустит сломанный вход -- */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const CLI = require('node:path').join(__dirname, '..', 'bin', 'cli.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
  });
}

test('CLI: node bin/cli.js реально поднимает мост и отдаёт панель', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'aib-cli-'));
  const child = spawn(process.execPath, [CLI, '--port', String(port), '--no-open', '--data-dir', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let exited = null;
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.on('exit', (code) => (exited = code));

  try {
    // ждём баннер — он печатается после listen()
    const deadline = Date.now() + 20000;
    while (!/Панель/.test(out) && exited === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(exited, null, 'процесс умер на старте:\n' + out);
    assert.ok(/Панель/.test(out), 'нет баннера:\n' + out);
    assert.ok(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=`).test(out), 'в баннере нет ссылки с токеном:\n' + out);

    const health = await get(port, '/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).ok, true);

    const panel = await get(port, '/');
    assert.strictEqual(panel.status, 200);
    assert.ok(panel.body.includes('AI Agent in Browser'), 'панель не отдалась');
  } finally {
    child.kill('SIGKILL');
  }
});
