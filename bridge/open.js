'use strict';

/**
 * Открыть URL в браузере по-кроссплатформенному и БЕЗ права уронить мост.
 *
 * Исторический баг: на Windows `start` — не исполняемый файл, а внутренняя
 * команда cmd.exe, и `spawn('start', [url])` падал с ENOENT, убивая мост.
 * Поэтому win32 идёт через `cmd.exe /c start "" <url>`, а любая ошибка
 * открытия игнорируется: браузер — удобство, а не часть моста.
 */

const { spawn } = require('node:child_process');

/** Какую команду использовать на данной платформе (вынесено для тестов). */
function openCommand(platform, url) {
  switch (platform) {
    case 'win32':
      // пустой аргумент — «титул» окна, иначе start съест url;
      // Node сам отрендерит пустую строку как "" для cmd.exe
      return ['cmd.exe', ['/c', 'start', '', url]];
    case 'darwin':
      return ['open', [url]];
    default:
      return ['xdg-open', [url]];
  }
}

function openBrowser(url) {
  const [cmd, args] = openCommand(process.platform, url);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); // ENOENT и прочие — просто нет браузера, не критично
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { openBrowser, openCommand };
