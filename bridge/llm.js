'use strict';

/**
 * Необязательный LLM-клиент.
 *
 * Основной сценарий проекта — расширение читает ОБЫЧНЫЙ чат в браузере.
 * Но для быстрого демо и отладки моста удобно иметь чат прямо в панели:
 * тогда не нужно ставить расширение, чтобы прогнать весь цикл.
 *
 * Подойдёт любой OpenAI-совместимый endpoint (OpenAI, OpenRouter, LM Studio,
 * Ollama, vLLM, Together и т.д.) — достаточно baseUrl + apiKey + model.
 */

async function streamChat({ baseUrl, apiKey, model, messages, signal, onDelta }) {
  const url = `${String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    const err = new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
      } catch {
        /* игнорируем битый keep-alive кадр */
      }
    }
  }
  return full;
}

/**
 * Демо-ассистент: честная заглушка вместо ChatGPT, когда API-ключ не задан.
 * Терминал при этом работает НАСТОЯЩИЙ — заглушка только «модель».
 * Она выдаёт по одному блоку [EXECUTE] за шаг, ровно как велит системный промпт.
 */
function demoAssistant(messages) {
  const terminalSteps = messages.filter((m) => m.role === 'user' && m.content.includes('[TERMINAL]'));
  const step = terminalSteps.length;
  const failed = /\bexit code: (?!0\b)/.test(terminalSteps[step - 1]?.content || '');

  if (failed && step === 1) {
    return `Вижу ошибку в выводе. Проверю, что доступно в системе, прежде чем продолжать:

\`\`\`bash
# [EXECUTE]
node -v 2>&1; npm -v 2>&1; which git 2>&1; echo "PATH=$PATH"
\`\`\``;
  }

  const steps = [
    `Понял задачу. Работаю через терминал пользователя.

Сначала осмотрюсь — где я и что уже установлено:

\`\`\`bash
# [EXECUTE]
pwd && ls -la && node -v && git --version
\`\`\``,

    `Хорошо, окружение понятно. Создаю структуру проекта и инициализирую git:

\`\`\`bash
# [EXECUTE]
mkdir -p ai-demo && cd ai-demo && git init -q && npm init -y >/dev/null && ls -la
\`\`\``,

    `Проект инициализирован. Добавляю первый рабочий файл и запускаю его:

\`\`\`bash
# [EXECUTE]
printf 'const t = new Date();\\nconsole.log("мост работает", t.toISOString());\\n' > index.js && node index.js
\`\`\``,

    `Отлично, код исполняется. Фиксирую результат в git:

\`\`\`bash
# [EXECUTE]
git add -A && git -c user.email=agent@local -c user.name="AI Agent" commit -q -m "init: demo via browser bridge" && git log --oneline
\`\`\``,
  ];

  if (step < steps.length) return steps[step];

  return `Готово. Краткое резюме:

**Что сделано**
- создана папка \`ai-demo\` с \`package.json\` и \`index.js\`;
- репозиторий инициализирован, сделан первый коммит;
- скрипт \`node index.js\` проверен и работает.

**Что проверить пользователю**
- \`cd ai-demo && git log\` — история коммитов;
- \`node index.js\` — вывод скрипта.

Больше команд не требуется — задача закрыта.`;
}

module.exports = { streamChat, demoAssistant };
