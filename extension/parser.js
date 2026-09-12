// СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактируй.
// Копия bridge/parser.js, делается скриптом scripts/build-extension.js
// (или автоматически при запуске `node bin/cli.js`).

'use strict';

/**
 * Парсер ответов ИИ.
 *
 * Модель, согласно системному промпту, выдаёт команду в блоке кода вида:
 *
 *   ```bash
 *   # [EXECUTE]
 *   cd my_project && npm init -y
 *   ```
 *
 * Мы умеем доставать команду и из ряда «кривых» вариантов, которые модели
 * любят выдавать в реальности (маркер на той же строке, маркер над блоком,
 * маркер без блока, `~~~` вместо ```, маркер внутри <!-- --> и т.д.).
 */

const EXECUTE_RE = /\[\s*(?:EXECUTE|EXEC|RUN|TERMINAL|SHELL)\s*\]/i;

const COMMENT_PREFIX_RE = /^\s*(?:#{1,}|\/{2,}|;{1,}|-{2,}|:{2}|REM\b\s*|<!--|-->|\*>)/i;

/** Срезаем ESC-последовательности терминала (цвета, курсор, OSC-заголовки). */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(ANSI_RE, '')
    .replace(/\u0007/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * Разбивает текст на строки и помечает, какие из них принадлежат fenced-блокам.
 * Возвращает { blocks: [{lang, code, lines:[...]}], outside: [{line, text}] }
 */
function tokenize(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const outside = [];
  let i = 0;

  while (i < lines.length) {
    const open = /^\s{0,3}(`{3,}|~{3,})[ \t]*([^\n`~]*)$/.exec(lines[i]);
    if (open) {
      const fenceChar = open[1][0];
      const fenceLen = open[1].length;
      const lang = open[2].trim().toLowerCase();
      const start = i;
      const body = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const close = new RegExp(`^\\s{0,3}\\${fenceChar}{${fenceLen},}[ \\t]*$`).exec(lines[i]);
        if (close) {
          i += 1;
          closed = true;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ lang, code: body.join('\n'), start, closed });
      continue;
    }
    outside.push({ index: i, text: lines[i] });
    i += 1;
  }

  return { blocks, outside, lines };
}

function stripCommentMarker(line) {
  return line.replace(COMMENT_PREFIX_RE, '');
}

/**
 * Ищет команду [EXECUTE] в тексте ответа модели.
 * Возвращает { command, raw, source, index } или null.
 */
function extractCommand(messageText) {
  if (!messageText || typeof messageText !== 'string') return null;
  const text = messageText;
  const { blocks, outside } = tokenize(text);

  // 1) Маркер внутри fenced-блока кода — основной и самый надёжный случай.
  for (const block of blocks) {
    const codeLines = block.code.split('\n');
    for (let k = 0; k < codeLines.length; k += 1) {
      const line = codeLines[k];
      if (!line.trim()) continue;
      const stripped = stripCommentMarker(line);
      if (EXECUTE_RE.test(stripped)) {
        const inline = stripped.replace(EXECUTE_RE, '').replace(/^[:\-–—>]\s*/, '').trim();
        const rest = codeLines.slice(k + 1).join('\n');
        const command = normalizeCommand([inline, rest].filter(Boolean).join('\n'));
        if (command) {
          return {
            command,
            raw: block.code,
            source: 'code-block',
            lang: block.lang || '',
            index: block.start,
          };
        }
      }
      break; // маркер ищем только в первой непустой строке блока
    }
  }

  // 2) Маркер в первой строке блока, но не как комментарий: "[EXECUTE] cmd"
  for (const block of blocks) {
    const first = block.code.split('\n').find((l) => l.trim());
    if (first && EXECUTE_RE.test(first)) {
      const command = normalizeCommand(first.replace(EXECUTE_RE, '').replace(/^[:\-–—>]\s*/, ''));
      if (command) {
        return { command, raw: block.code, source: 'code-block-inline', index: block.start };
      }
    }
  }

  // 3) Маркер отдельной строкой вне блока, команда — следующая строка или следующий блок.
  for (let o = 0; o < outside.length; o += 1) {
    const { text: line, index } = outside[o];
    if (!EXECUTE_RE.test(line)) continue;
    const inline = line.replace(EXECUTE_RE, '').replace(/^[:\-–—>]\s*/, '').trim();
    if (inline) {
      const command = normalizeCommand(inline.replace(/^`+|`+$/g, ''));
      if (command) return { command, raw: line, source: 'inline', index };
    }
    // следующая непустая строка вне блока
    for (let n = o + 1; n < outside.length; n += 1) {
      const candidate = outside[n].text.trim();
      if (!candidate) continue;
      const command = normalizeCommand(candidate.replace(/^`+|`+$/g, ''));
      if (command) return { command, raw: candidate, source: 'next-line', index: outside[n].index };
      break;
    }
    // ближайший следующий fenced-блок
    const nextBlock = blocks.find((b) => b.start > index);
    if (nextBlock) {
      const command = normalizeCommand(nextBlock.code);
      if (command) {
        return { command, raw: nextBlock.code, source: 'next-block', index: nextBlock.start };
      }
    }
  }

  return null;
}

function normalizeCommand(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '')
    .replace(/```+\s*$/, '')
    .trim();
}

/** Сколько блоков [EXECUTE] модель выдала в одном сообщении (по промпту должен быть один). */
function countExecuteMarkers(messageText) {
  if (!messageText) return 0;
  const matches = String(messageText).match(new RegExp(EXECUTE_RE.source, 'gi'));
  return matches ? matches.length : 0;
}

const DANGEROUS_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/i, why: 'рекурсивное удаление из корня' },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+~\/?(\s|$)/i, why: 'удаление домашнего каталога' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bmkfs(\.\w+)?\b/i, why: 'форматирование раздела' },
  { re: /\bdd\s+.*\bof=\/dev\//i, why: 'запись на блочное устройство' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, why: 'перезапись диска' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: 'выключение машины' },
  { re: /\bchmod\s+(-R\s+)?(777|a\+rwx)\s+\/(\s|$)/i, why: 'chmod 777 на корень' },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: 'загрузка и выполнение скрипта из сети' },
  { re: /\bformat\s+[a-z]:/i, why: 'форматирование диска (Windows)' },
  { re: /\brmdir\s+\/[sq][^\n]*[a-z]:\\\s*$/i, why: 'удаление диска (Windows)' },
  { re: /\bgit\s+push\b[^\n]*--force\b/i, why: 'force push' },
  { re: /\bnpm\s+publish\b/i, why: 'публикация пакета' },
];

/** Грубая, но полезная проверка на заведомо разрушительные команды. */
function inspectCommand(command) {
  const hits = [];
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(command)) hits.push(why);
  }
  return { dangerous: hits.length > 0, reasons: hits };
}

/**
 * Обрезаем вывод так, чтобы он влез в контекст модели:
 * оставляем начало и конец, середину выбрасываем.
 */
function truncateOutput(text, maxChars = 12000) {
  const s = stripAnsi(text);
  if (s.length <= maxChars) return { text: s, truncated: false };
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head - 200;
  const cut = s.length - head - (tail > 0 ? tail : 0);
  const note = `\n... [мост обрезал ${cut} символов в середине вывода] ...\n`;
  return { text: s.slice(0, head) + note + (tail > 0 ? s.slice(-tail) : ''), truncated: true };
}

/**
 * Формируем сообщение, которое расширение вставляет в чат вместо пользователя.
 */
function formatTerminalReply({ command, output, exitCode, cwd, truncated, timedOut, denied }) {
  if (denied) {
    return [
      '[TERMINAL] Пользователь ОТКЛОНИЛ команду — она не выполнялась.',
      '',
      'Команда: ' + command,
      '',
      'Предложи другой вариант или спроси пользователя, что делать дальше.',
    ].join('\n');
  }
  const lines = [];
  lines.push('[TERMINAL] Результат выполнения твоей команды.');
  lines.push('');
  lines.push('$ ' + command.split('\n')[0]);
  if (cwd) lines.push('cwd: ' + cwd);
  if (timedOut) lines.push('статус: ПРЕВЫШЕН ТАЙМАУТ, процесс прерван');
  lines.push('exit code: ' + exitCode);
  lines.push('');
  lines.push('```');
  const body = (output || '').trimEnd();
  lines.push(body === '' ? '(пустой вывод)' : body);
  lines.push('```');
  if (truncated) lines.push('\n(вывод обрезан — полностью он в окне программы-интегратора)');
  lines.push('');
  lines.push(
    exitCode === 0 && !timedOut
      ? 'Команда выполнена успешно. Продолжай со следующего шага или заверши задачу.'
      : 'Команда завершилась с ошибкой. Проанализируй вывод и исправь её следующей командой.'
  );
  return lines.join('\n');
}

const api = {
  EXECUTE_RE,
  stripAnsi,
  tokenize,
  extractCommand,
  countExecuteMarkers,
  normalizeCommand,
  inspectCommand,
  truncateOutput,
  formatTerminalReply,
};

// Один и тот же парсер используется в трёх местах: мост (Node), панель
// (браузер) и расширение (content script). Поэтому отдаём его и туда, и туда.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.AiAgentParser = api;
