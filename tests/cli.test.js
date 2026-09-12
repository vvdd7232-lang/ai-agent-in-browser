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
