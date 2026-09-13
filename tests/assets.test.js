'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { isPacked, readProject, diskRoot } = require('../bridge/assets');

test('assets: под node мы не «упакованы», а файлы читаются с диска', () => {
  assert.strictEqual(isPacked(), false);
  assert.strictEqual(diskRoot(), path.resolve(__dirname, '..'));

  const html = readProject('web/index.html');
  assert.ok(Buffer.isBuffer(html), 'readProject обязан возвращать Buffer');
  assert.ok(html.toString('utf8').includes('AI Agent in Browser'));

  const app = readProject('web/app.js');
  assert.ok(app.toString('utf8').includes('function ansiToHtml'));

  const parser = readProject('bridge/parser.js');
  assert.ok(parser.toString('utf8').includes('extractCommand'));
});

test('assets: путь наружу проекта не отдаётся', () => {
  assert.strictEqual(readProject('../../etc/passwd'), null);
  assert.strictEqual(readProject('/../../etc/passwd'), null);
  assert.strictEqual(readProject('web/../../etc/passwd'), null);
  assert.strictEqual(readProject('web'), null, 'каталог не должен читаться как файл');
  assert.strictEqual(readProject('web/нет-такого-файла.js'), null);
  assert.strictEqual(readProject(''), null);
});

test('assets: сервер отдаёт панель и статику через readProject', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const http = require('node:http');
  const { Bridge, createServer } = require('../bridge/server');

  const bridge = new Bridge({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aib-assets-')), cwd: os.tmpdir(), token: 't' });
  bridge.start();
  const server = createServer(bridge);
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  const get = (p) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out, type: res.headers['content-type'] }));
      }).on('error', reject);
    });

  try {
    const page = await get('/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('AI Agent in Browser'), 'панель не отдалась');
    assert.ok(!page.body.includes('[object ArrayBuffer]'), 'файл панели отдан как текст');

    for (const [p, marker] of [['/assets/app.js', 'ansiToHtml'], ['/assets/styles.css', '.term'], ['/assets/parser.js', 'extractCommand']]) {
      const r = await get(p);
      assert.strictEqual(r.status, 200, p + ' -> ' + r.status);
      assert.ok(r.body.includes(marker), p + ': нет ожидаемого содержимого');
    }

    // `/../` схлопывается ещё HTTP-слоем: путь превращается в /package.json
    // и упирается в проверку токена. Проверяем, что файл в любом случае не отдан.
    const dots = await get('/assets/../../package.json');
    assert.strictEqual(dots.status, 401);
    assert.ok(!dots.body.includes('"ai-agent-in-browser"'), 'package.json не должен отдаваться');

    // процент-кодирование URL-парсер не раскрывает, поэтому тут работает
    // уже собственная защита readProject()
    const encoded = await get('/assets/%2e%2e%2fpackage.json');
    assert.strictEqual(encoded.status, 404);
  } finally {
    await bridge.close();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
