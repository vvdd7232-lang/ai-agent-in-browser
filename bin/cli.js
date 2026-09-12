#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { Bridge, createServer } = require('../bridge/server');
const { defaultDataDir, detectPlatform } = require('../bridge/shell');
const { syncParser } = require('../scripts/build-extension');
const { openBrowser } = require('../bridge/open');

// чтобы папку extension/ можно было грузить в Chrome «как есть»,
// держим её копию парсера свежей на каждый запуск моста
try {
  syncParser(false);
} catch {}

const HELP = `
ai-agent-in-browser — мост между ИИ-чатом в браузере и твоим терминалом

Использование:
  ai-agent-in-browser [опции]

Опции:
  --port <n>            порт моста                    (по умолчанию 7788)
  --host <addr>         адрес для прослушивания       (по умолчанию 127.0.0.1)
  --cwd <path>          стартовый каталог терминала   (по умолчанию текущий)
  --token <secret>      задать токен вручную
  --approval <mode>     auto | confirm | off          (по умолчанию auto)
  --data-dir <path>     где хранить конфиг и историю  (по умолчанию ${defaultDataDir()})
  --preview             пробросить токен в панель без query (для песочниц/демо;
                        по умолчанию панель требует токен)
  --insecure            РЕЖИМ НА СВОЙ СТРАХ И РИСК: открыть мост БЕЗ токена.
                        Любой, кто достучится до адреса, сможет выполнять команды.
                        Только для песочниц и локальных экспериментов!
  --no-open             не открывать панель в браузере
  -h, --help            эта справка

Порядок работы:
  1. Запусти мост:      node bin/cli.js
  2. Открой панель по ссылке из вывода и скопируй системный промпт.
  3. Вставь промпт первым сообщением в чат ИИ (ChatGPT / Claude / Gemini).
  4. Включи расширение и нажми «Подключить» — дальше цикл замкнётся сам.
`;

function parseArgs(argv) {
  const out = { open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--port':
        out.port = parseInt(next(), 10);
        break;
      case '--host':
        out.host = next();
        break;
      case '--cwd':
        out.cwd = path.resolve(next());
        break;
      case '--token':
        out.token = next();
        break;
      case '--approval':
        out.approval = next();
        break;
      case '--data-dir':
        out.dataDir = path.resolve(next());
        break;
      case '--no-open':
        out.open = false;
        break;
      case '--preview':
        out.preview = true;
        break;
      case '--insecure':
      case '--open-access':
        out.insecure = true;
        break;
      default:
        if (a.startsWith('--port=')) out.port = parseInt(a.split('=')[1], 10);
        else if (a.startsWith('--host=')) out.host = a.split('=')[1];
        else if (a.startsWith('--cwd=')) out.cwd = path.resolve(a.split('=')[1]);
        else if (a.startsWith('--approval=')) out.approval = a.split('=')[1];
        else if (a === '--open') out.open = true;
        else {
          console.error(`Неизвестная опция: ${a}`);
          process.exit(2);
        }
    }
  }
  return out;
}

const C = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const platform = detectPlatform();
  const bridge = new Bridge({
    dataDir: args.dataDir,
    cwd: args.cwd,
    token: args.token,
    insecure: !!args.insecure,
    config: {
      ...(args.port ? { port: args.port } : {}),
      ...(args.host ? { host: args.host } : {}),
      ...(args.approval ? { approvalMode: args.approval } : {}),
    },
  });

  const host = bridge.store.config.host;
  const port = bridge.store.config.port;
  bridge.start();

  const server = createServer(bridge, { preview: !!args.preview });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  bridge.server = server;

  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const panelUrl = `http://${shownHost}:${port}/?token=${bridge.token}`;

  console.log('');
  console.log(C.bold('  AI AGENT IN BROWSER') + C.dim(`  v${require('../package.json').version}`));
  console.log(C.dim('  ─────────────────────────────────────────────────'));
  console.log(`  ${C.green('●')} Панель        ${C.cyan(panelUrl)}`);
  console.log(`  ${C.green('●')} API           http://${shownHost}:${port}/api/health`);
  console.log(`  ${C.green('●')} WebSocket     ws://${shownHost}:${port}/api/ws`);
  console.log(`  ${C.green('●')} Система       ${platform.label}  ${C.dim(platform.shell)}`);
  console.log(`  ${C.green('●')} Каталог       ${bridge.shell.cwd}`);
  console.log(`  ${C.green('●')} Подтверждение ${bridge.store.config.approvalMode === 'auto' ? C.yellow('auto (выполнять сразу)') : bridge.store.config.approvalMode === 'confirm' ? C.yellow('confirm (спрашивать)') : C.red('off (без проверок)')}`);
  console.log(`  ${C.green('●')} Токен         ${bridge.token}`);
  console.log(`  ${C.green('●')} Конфиг        ${bridge.dataDir}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log('');
    console.log(C.red('  ! Мост слушает не только loopback: любой, кто достучится до этого'));
    console.log(C.red('    адреса и узнает токен, сможет выполнять команды на этой машине.'));
  }
  if (bridge.insecure) {
    console.log('');
    console.log(C.red('  !!! РЕЖИМ НА СВОЙ СТРАХ И РИСК: токен ОТКЛЮЧЕН (--insecure).'));
    console.log(C.red('  !!! Любой, кто откроет панель, сможет выполнять команды на этой машине.'));
    console.log(C.red('  !!! Не используй этот режим вне песочницы.'));
  }
  console.log('');
  console.log(C.dim('  Ctrl+C — остановить'));
  console.log('');

  if (args.open && process.stdout.isTTY) {
    // не может уронить мост: все ошибки открытия глотаются внутри
    openBrowser(panelUrl);
  }

  bridge.shell.on('command-end', (r) => {
    const tag = r.exitCode === 0 ? C.green('ok ') : C.red(`x${r.exitCode}`);
    const first = r.command.split('\n')[0].slice(0, 78);
    console.log(`  ${C.dim(new Date().toLocaleTimeString())}  ${tag} ${C.dim((r.durationMs + 'ms').padStart(7))}  ${first}`);
  });

  const shutdown = async () => {
    console.log(C.dim('\n  Останавливаю мост...'));
    try {
      await bridge.close();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(C.red('\nНе удалось запустить мост: ') + (err && err.message));
  if (err && err.code === 'EADDRINUSE') {
    console.error(C.red('  Порт занят ДРУГИМ экземпляром моста (или чужой программой).'));
    console.error(C.red('  Браузер тогда ходит в старый процесс, и новые флаги (--insecure)'));
    console.error(C.red('  «не работают». Закрой старое окно моста (Ctrl+C) и запусти снова,'));
    console.error(C.red('  либо возьми другой порт: --port 7791'));
  }
  process.exit(1);
});
