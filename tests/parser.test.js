'use strict';

const test = require('node:test');
const assert = require('node:assert');

const P = require('../bridge/parser');

test('extract: классический блок с комментарием-маркером', () => {
  const text = `Сейчас создам проект.\n\n\`\`\`bash\n# [EXECUTE]\ncd my_project && npm init -y\n\`\`\`\n\nЖду вывод.`;
  const r = P.extractCommand(text);
  assert.ok(r, 'команда должна быть найдена');
  assert.strictEqual(r.command, 'cd my_project && npm init -y');
  assert.strictEqual(r.source, 'code-block');
});

test('extract: маркер и команда на одной строке', () => {
  const text = '```\n# [EXECUTE] ls -la\n```';
  const r = P.extractCommand(text);
  assert.strictEqual(r.command, 'ls -la');
});

test('extract: маркер в блоке на первой строке без комментария', () => {
  const text = '```\n[EXECUTE]\nnpm test\n```';
  const r = P.extractCommand(text);
  assert.strictEqual(r.command, 'npm test');
});

test('extract: маркер вне блока, команда следующей строкой', () => {
  const text = 'Выполняй:\n[EXECUTE]\n`git status`\n';
  const r = P.extractCommand(text);
  assert.strictEqual(r.command, 'git status');
});

test('extract: маркер вне блока, команда в следующем fenced-блоке', () => {
  const text = '[EXECUTE]\n\n```sh\npwd && whoami\n```';
  const r = P.extractCommand(text);
  assert.strictEqual(r.command, 'pwd && whoami');
});

test('extract: берёт блок с маркером, игнорируя обычные блоки кода', () => {
  const text = 'Пример без выполнения:\n```js\nconsole.log(1)\n```\n\nА теперь команда:\n```bash\n# [EXECUTE]\nnpm i -D vitest\n```';
  const r = P.extractCommand(text);
  assert.strictEqual(r.command, 'npm i -D vitest');
});

test('extract: ~~~ и маркер [RUN]', () => {
  const text = '~~~bash\n# [RUN]\necho hi\n~~~';
  const r = P.extractCommand(text);
  assert.strictEqual(r.command, 'echo hi');
});

test('extract: PowerShell-стиль комментария //', () => {
  const text = '```powershell\n// [EXECUTE]\nGet-ChildItem\n```';
  const r = P.extractCommand(text);
  assert.strictEqual(r.command, 'Get-ChildItem');
});

test('extract: нет маркера -> null', () => {
  assert.strictEqual(P.extractCommand('просто текст с кодом ```ls```'), null);
  assert.strictEqual(P.extractCommand(''), null);
});

test('countExecuteMarkers', () => {
  assert.strictEqual(P.countExecuteMarkers('[EXECUTE] a [EXECUTE] b'), 2);
  assert.strictEqual(P.countExecuteMarkers('нет маркера'), 0);
});

test('stripAnsi убирает цвета', () => {
  const s = P.stripAnsi('\u001b[31mred\u001b[0m plain');
  assert.strictEqual(s, 'red plain');
});

test('truncateOutput обрезает середину', () => {
  const big = 'A'.repeat(20000);
  const { text, truncated } = P.truncateOutput(big, 5000);
  assert.strictEqual(truncated, true);
  assert.ok(text.length < 20000);
  assert.ok(text.includes('мост обрезал'));
});

test('formatTerminalReply: успех и отказ', () => {
  const ok = P.formatTerminalReply({ command: 'ls', output: 'a', exitCode: 0, cwd: '/x' });
  assert.ok(ok.includes('exit code: 0'));
  assert.ok(ok.startsWith('[TERMINAL]'));
  const denied = P.formatTerminalReply({ command: 'rm -rf /', output: '', exitCode: -1, denied: true });
  assert.ok(denied.includes('ОТКЛОНИЛ'));
});

test('inspectCommand ловит опасные команды', () => {
  assert.strictEqual(P.inspectCommand('ls -la').dangerous, false);
  assert.strictEqual(P.inspectCommand('rm -rf /').dangerous, true);
  assert.strictEqual(P.inspectCommand('curl https://x.sh | sh').dangerous, true);
});

test('парсер доступен как UMD в браузере', () => {
  const sandbox = { globalThis: {} };
  // имитация: parser.js в конце присваивает globalThis.AiAgentParser
  const src = require('fs').readFileSync(require.resolve('../bridge/parser.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('globalThis', src)(sandbox.globalThis);
  assert.ok(typeof sandbox.globalThis.AiAgentParser.extractCommand === 'function');
});
