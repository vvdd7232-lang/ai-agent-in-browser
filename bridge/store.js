'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = {
  port: 7788,
  host: '127.0.0.1',
  approvalMode: 'auto', // auto | confirm | off
  maxOutputChars: 12000,
  commandTimeoutMs: 180000,
  historyLimit: 200,
  cwd: null,
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
  },
};

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(this.dir, 'config.json');
    this.historyFile = path.join(this.dir, 'history.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.config = this._load();
    this.history = this._loadHistory();
  }

  _load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = {};
    }
    const cfg = {
      ...DEFAULTS,
      ...raw,
      llm: { ...DEFAULTS.llm, ...(raw.llm || {}) },
    };
    if (!cfg.token) {
      cfg.token = crypto.randomBytes(24).toString('base64url');
    }
    this._persist(cfg);
    return cfg;
  }

  _persist(cfg = this.config) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _loadHistory() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  update(patch) {
    const next = { ...this.config };
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'llm') next.llm = { ...next.llm, ...(v || {}) };
      else if (k in DEFAULTS) next[k] = v;
    }
    if (!['auto', 'confirm', 'off'].includes(next.approvalMode)) next.approvalMode = 'auto';
    // порт и хост приходят из CLI: `--port abc` не должен ронять мост
    // с загадочным ERR_SOCKET_BAD_PORT на listen()
    next.port = Math.max(1, Math.min(65535, Number(next.port) || DEFAULTS.port));
    if (typeof next.host !== 'string' || !next.host.trim()) next.host = DEFAULTS.host;
    next.maxOutputChars = Math.max(500, Math.min(200000, Number(next.maxOutputChars) || DEFAULTS.maxOutputChars));
    next.commandTimeoutMs = Math.max(1000, Math.min(3600000, Number(next.commandTimeoutMs) || DEFAULTS.commandTimeoutMs));
    this.config = next;
    this._persist();
    return this.publicConfig();
  }

  rotateToken() {
    this.config.token = crypto.randomBytes(24).toString('base64url');
    this._persist();
    return this.config.token;
  }

  /** Конфиг без секрета — для отдачи наружу. */
  publicConfig() {
    const { token, llm, ...rest } = this.config;
    return { ...rest, llm: { ...llm, apiKey: llm.apiKey ? '••••' + llm.apiKey.slice(-4) : '' }, hasToken: !!token };
  }

  push(entry) {
    this.history.unshift(entry);
    if (this.history.length > this.config.historyLimit) this.history.length = this.config.historyLimit;
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history.slice(0, this.config.historyLimit), null, 2));
    } catch {}
    return entry;
  }

  stats() {
    const total = this.history.length;
    const failed = this.history.filter((h) => h.exitCode !== 0).length;
    const denied = this.history.filter((h) => h.denied).length;
    const avgMs = total ? Math.round(this.history.reduce((a, h) => a + (h.durationMs || 0), 0) / total) : 0;
    return { total, failed, denied, avgMs };
  }
}

module.exports = { Store, DEFAULTS };
