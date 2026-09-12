'use strict';

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { stripAnsi } = require('./parser');

/** Определяем shell и «вкус» ОС один раз на старте. */
function detectPlatform(override = {}) {
  const platform = override.platform || process.platform;
  const isWindows = platform === 'win32';

  let shell = override.shell;
  if (!shell) {
    if (isWindows) {
      const winPs = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      shell = fs.existsSync(winPs) ? winPs : process.env.PWSH_PATH || 'pwsh.exe';
    } else {
      shell = process.env.SHELL || '/bin/bash';
      if (!fs.existsSync(shell)) shell = '/bin/bash';
      if (!fs.existsSync(shell)) shell = '/bin/sh';
    }
  }

  const base = path.basename(shell).toLowerCase();
  const kind = /powershell|pwsh/.test(base)
    ? 'powershell'
    : /zsh/.test(base)
      ? 'zsh'
      : /fish/.test(base)
        ? 'fish'
        : 'bash';

  return {
    platform,
    isWindows,
    shell,
    kind,
    label: isWindows
      ? 'Windows (PowerShell)'
      : platform === 'darwin'
        ? 'macOS (' + base + ')'
        : 'Linux (' + base + ')',
  };
}

function buildArgs(kind) {
  if (kind === 'powershell') return ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-'];
  if (kind === 'zsh') return ['-f'];
  if (kind === 'fish') return ['--no-config'];
  return ['--norc', '--noprofile'];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Список PID-потомков процесса.
 * Linux — /proc/<pid>/task/<tid>/children, macOS/BSD — pgrep -P, Windows — пусто
 * (там дерево прибивается одним taskkill /T).
 */
function listChildren(pid) {
  if (process.platform === 'linux') {
    const out = [];
    try {
      const taskDir = `/proc/${pid}/task`;
      for (const tid of fs.readdirSync(taskDir)) {
        const file = `${taskDir}/${tid}/children`;
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (!raw) continue;
        for (const p of raw.split(/\s+/)) {
          const n = parseInt(p, 10);
          if (Number.isFinite(n)) out.push(n);
        }
      }
    } catch {
      /* процесс уже умер */
    }
    return out;
  }
  return null; // неизвестно — вызывающий код сам решит, что делать
}

/** Убивает дерево потомков pid, НЕ трогая сам pid. Возвращает число убитых. */
async function killDescendants(pid, signal = 'SIGTERM') {
  if (process.platform === 'win32') return 0;
  let direct = listChildren(pid);
  if (direct === null) {
    direct = await new Promise((resolve) => {
      execFile('pgrep', ['-P', String(pid)], { timeout: 3000 }, (err, stdout) => {
        if (err && !stdout) return resolve([]);
        resolve(
          String(stdout)
            .split(/\s+/)
            .map((s) => parseInt(s, 10))
            .filter((n) => Number.isFinite(n))
        );
      });
    });
  }
  const all = [];
  const seen = new Set();
  const stack = [...direct];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur) || cur === pid) continue;
    seen.add(cur);
    all.push(cur);
    const kids = listChildren(cur) || [];
    stack.push(...kids);
  }
  for (const p of all) {
    try {
      process.kill(p, signal);
    } catch {}
  }
  return all.length;
}

/**
 * Живая shell-сессия: один процесс на всё время работы программы.
 * Именно поэтому `cd my_project` из одной команды действует и на следующую —
 * ровно то, чего ждёт ИИ, когда выдаёт задачу по шагам.
 */
class ShellSession extends EventEmitter {
  constructor(options = {}) {
    super();
    const detected = detectPlatform(options);
    Object.assign(this, detected);

    this.cwd = options.cwd || process.cwd();
    this.env = {
      ...process.env,
      ...(options.env || {}),
      PS1: '',
      PS2: '',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      TERM: process.env.TERM || 'xterm-256color',
    };

    this.child = null;
    this.pending = null;
    this._currentTask = null;
    this.queue = [];
    this.draining = null;
    this.startedAt = null;
    this.commandCount = 0;
    this.restartCount = 0;
    this.closed = false;
    this.defaultTimeoutMs = options.timeoutMs || 180000;
  }

  info() {
    return {
      alive: !!(this.child && this.child.exitCode === null),
      shell: this.shell,
      kind: this.kind,
      platform: this.platform,
      label: this.label,
      cwd: this.cwd,
      pid: this.child ? this.child.pid : null,
      startedAt: this.startedAt,
      commandCount: this.commandCount,
      restartCount: this.restartCount,
      busy: !!this.pending,
      queue: this.queue.length,
    };
  }

  start() {
    if (this.child) return this;
    this.child = spawn(this.shell, buildArgs(this.kind), {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.startedAt = Date.now();
    this.closed = false;

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk, 'stdout'));
    this.child.stderr.on('data', (chunk) => this._onData(chunk, 'stderr'));
    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code, signal) => {
      const child = this.child;
      this.child = null;
      this.emit('exit', { code, signal, pid: child ? child.pid : null });
      if (this.pending) {
        this._finishPending({
          output: this.pending.output,
          exitCode: typeof code === 'number' ? code : -1,
          interrupted: true,
        });
      }
      if (!this.closed) {
        // shell умер сам (например, пользователь написал `exit`) — поднимаем заново
        this.restartCount += 1;
        setImmediate(() => {
          if (!this.closed) {
            try {
              this.start();
              this.emit('restart', { reason: 'shell-exited', ...this.info() });
            } catch (err) {
              this.emit('error', err);
            }
          }
        });
      }
    });

    this._primeShell();
    this.emit('start', this.info());
    return this;
  }

  _primeShell() {
    if (this.kind === 'powershell') {
      this.child.stdin.write('$ProgressPreference = "SilentlyContinue"\n');
      this.child.stdin.write('try { $PSStyle.OutputRendering = "Ansi" } catch {}\n');
    } else {
      this.child.stdin.write('PS1= PS2= PAGER=cat GIT_PAGER=cat; export PS1 PS2 PAGER GIT_PAGER\n');
    }
  }

  _onData(chunk, stream) {
    let clean = stripAnsi(chunk);
    let raw = chunk;

    // После прерывания команды shell всё равно допечатывает buffered-сентинел.
    // Сливаем поток до resync-маркера, но хвост чанка ПОСЛЕ маркера обязаны
    // вернуть в обычный поток — там уже может лежать вывод следующей команды.
    if (this.draining) {
      const idx = clean.indexOf(this.draining.marker);
      if (idx === -1) {
        this.draining.buf += clean;
        return;
      }
      const lineEnd = clean.indexOf('\n', idx);
      const tail = lineEnd === -1 ? '' : clean.slice(lineEnd + 1);
      this.draining = null;
      if (!tail) return;
      clean = tail;
      raw = tail;
    }

    if (this.pending) {
      this.pending.raw += raw;
      this.pending.output += clean;
      this.emit('output', { id: this.pending.id, chunk: raw, clean, stream });
      this._checkMarker();
    } else {
      this.emit('noise', { clean, stream });
    }
  }

  _marker(id) {
    return `__AIAGENT_BRIDGE_${id}__`;
  }

  _checkMarker() {
    const p = this.pending;
    if (!p) return;
    const idx = p.output.indexOf(p.marker);
    if (idx === -1) return;
    const lineEnd = p.output.indexOf('\n', idx);
    const metaLine = p.output.slice(idx, lineEnd === -1 ? undefined : lineEnd);
    const body = p.output.slice(0, idx).replace(/\n+$/, '');
    const m = /\|exit=(-?\d+)\|cwd=(.*)$/.exec(metaLine);
    this._finishPending({
      output: body,
      exitCode: m ? parseInt(m[1], 10) : -1,
      cwd: m ? m[2].trim() : undefined,
    });
  }

  /** Ставит команду в очередь; команды выполняются строго последовательно. */
  run(command, opts = {}) {
    if (!this.child) this.start();
    return new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const task = { command, opts, resolve, reject, id };
      this.queue.push(task);
      if (!this.pending) this._pump();
    });
  }

  _pump() {
    const task = this.queue.shift();
    if (!task) return;
    if (!this.child) {
      try {
        this.start();
      } catch (err) {
        task.reject(err);
        return;
      }
    }
    this._currentTask = task;
    this._execTask(task);
  }

  _execTask(task) {
    const { command, opts, id } = task;
    const marker = this._marker(id);
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;

    this.pending = { id, marker, output: '', raw: '', command, startedAt: Date.now(), timer: null };
    this.commandCount += 1;
    this.emit('command-start', { id, command, cwd: this.cwd, startedAt: this.pending.startedAt });

    const sentinel =
      this.kind === 'powershell'
        ? `$__ai = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { if ($?) { 0 } else { 1 } }; Write-Output "${marker}|exit=$__ai|cwd=$((Get-Location).Path)"`
        : `__ai=$?; echo "${marker}|exit=$__ai|cwd=$(pwd)"`;

    this.pending.timer = setTimeout(() => {
      if (this.pending && this.pending.id === id) this._onTimeout(id);
    }, timeoutMs);

    try {
      this.child.stdin.write(command.replace(/\r\n/g, '\n') + '\n');
      this.child.stdin.write(sentinel + '\n');
    } catch (err) {
      this._finishPending({ output: String(err && err.message), exitCode: -1, fatal: true });
    }
  }

  async _onTimeout(id) {
    const killed = await this.abort({ id });
    this._finishPending({
      output: (this.pending && this.pending.output) || '',
      exitCode: -1,
      timedOut: true,
      killed,
    });
  }

  _finishPending({ output, exitCode, timedOut, cwd, interrupted, killed, fatal }) {
    const p = this.pending;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending = null;
    if (cwd) this.cwd = cwd;

    const result = {
      id: p.id,
      command: p.command,
      output: stripAnsi(output || '').replace(/\n+$/, ''),
      raw: p.raw,
      exitCode: Number.isInteger(exitCode) ? exitCode : -1,
      timedOut: !!timedOut,
      interrupted: !!interrupted,
      killed: killed || 0,
      cwd: this.cwd,
      durationMs: Date.now() - p.startedAt,
      finishedAt: Date.now(),
    };

    const task = this._currentTask;
    this._currentTask = null;
    this.emit('command-end', result);
    if (task) task.resolve(result);
    if (fatal && this.child) this.close();
    setImmediate(() => {
      if (!this.closed) this._pump();
    });
  }

  /**
   * Прерывает текущую команду.
   *
   * Ctrl-C в stdin не работает: shell запущен без tty, поэтому сигнал
   * до foreground-процесса не доходит. Вместо этого находим потомков shell
   * и убиваем их, сама сессия (а значит cwd и переменные) остаётся живой.
   */
  async abort(opts = {}) {
    const p = this.pending;
    if (!p && !opts.force) return 0;
    if (!this.child) return 0;

    // После убийства shell всё равно допечатает buffered-сентинел прерванной
    // команды. Сливаем весь поток до своего resync-маркера, иначе хвост
    // вывода попадёт в результат следующей команды.
    const resync = `__AIAGENT_RESYNC_${Date.now().toString(36)}__`;
    this.draining = { marker: resync, buf: '' };

    let killed = 0;
    if (this.isWindows) {
      // В Windows дерево прибивается только вместе с shell — перезапустим сессию.
      killed = await this._killWindowsTree();
      this.draining = null;
    } else {
      killed = await killDescendants(this.child.pid, 'SIGTERM');
      await sleep(600);
      killed += await killDescendants(this.child.pid, 'SIGKILL');
      try {
        this.child.stdin.write(`echo "${resync}"\n`);
      } catch {}
    }

    // shell не отвечает — поднимаем новый на том же cwd
    if (!this.child || this.child.exitCode !== null) {
      this.restartCount += 1;
      this.draining = null;
      this.start();
      this.emit('restart', { reason: 'unresponsive', ...this.info() });
    } else if (this.draining) {
      setTimeout(() => {
        this.draining = null;
      }, 2500).unref?.();
    }

    this.emit('abort', { id: p ? p.id : null, killed });
    return killed;
  }

  async _killWindowsTree() {
    if (!this.child) return 0;
    const pid = this.child.pid;
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 }, () => resolve());
    });
    this.child = null;
    this.draining = null;
    this.restartCount += 1;
    this.start();
    return 1;
  }

  /** Меняет рабочую директорию сессии. */
  async changeDir(target) {
    const resolved = path.resolve(this.cwd, target || '');
    if (!fs.existsSync(resolved)) {
      const err = new Error(`Каталог не найден: ${resolved}`);
      err.code = 'ENOENT';
      throw err;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      const err = new Error(`Это не каталог: ${resolved}`);
      err.code = 'ENOTDIR';
      throw err;
    }
    const quote =
      this.kind === 'powershell'
        ? `'${resolved.replace(/'/g, "''")}'`
        : `'${resolved.replace(/'/g, "'\\''")}'`;
    const cmd = this.kind === 'powershell' ? `Set-Location ${quote}` : `cd ${quote}`;
    const res = await this.run(cmd, { silent: true });
    if (res.exitCode !== 0) throw new Error(res.output || 'Не удалось сменить каталог');
    this.cwd = resolved;
    return this.cwd;
  }

  close() {
    this.closed = true;
    if (this.pending && this.pending.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.draining = null;
    this.queue.length = 0;
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill('SIGTERM');
      } catch {}
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 1000);
      t.unref?.();
    }
    this.emit('close', this.info());
  }
}

function defaultDataDir() {
  return process.env.AI_AGENT_DATA_DIR || path.join(os.homedir(), '.ai-agent-in-browser');
}

module.exports = { ShellSession, detectPlatform, defaultDataDir, killDescendants };
