'use strict';

/**
 * Минимальный WebSocket-сервер (RFC 6455) без зависимостей.
 * Нужен только текст-фреймы сервер→клиент (live-лог терминала) и ping/pong.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

class Socket extends EventEmitter {
  constructor(raw) {
    super();
    this.raw = raw;
    this.alive = true;
    this.buffer = Buffer.alloc(0);
    this.id = crypto.randomBytes(6).toString('hex');

    raw.on('data', (chunk) => this._onData(chunk));
    raw.on('close', () => this._die());
    raw.on('error', () => this._die());
    raw.setNoDelay(true);
  }

  _die() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('close');
  }

  send(obj) {
    if (!this.alive) return false;
    try {
      this.raw.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj)));
      return true;
    } catch {
      this._die();
      return false;
    }
  }

  close() {
    if (!this.alive) return;
    try {
      this.raw.write(encodeFrame(Buffer.alloc(0), 0x8));
    } catch {}
    try {
      this.raw.end();
    } catch {}
    this._die();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) === 0x80;
      let len = second & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        len = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      if (len > 8 * 1024 * 1024) {
        this.close();
        return;
      }
      const maskSize = masked ? 4 : 0;
      if (this.buffer.length < offset + maskSize + len) return;

      let payload = this.buffer.subarray(offset + maskSize, offset + maskSize + len);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + maskSize + len);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        try {
          this.raw.write(encodeFrame(payload, 0xa));
        } catch {}
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        this.emit('message', payload.toString('utf8'));
      }
    }
  }
}

class WebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    this.timer = setInterval(() => {
      for (const c of this.clients) c.send({ type: 'ping', t: Date.now() });
    }, 25000);
    this.timer.unref?.();
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const ws = new Socket(socket);
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', (msg) => this.emit('message', msg, ws));
    this.emit('connection', ws);
  }

  broadcast(obj) {
    const payload = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const c of this.clients) c.send(payload);
  }

  get size() {
    return this.clients.size;
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.clients) c.close();
    this.clients.clear();
  }
}

module.exports = { WebSocketServer, Socket, encodeFrame };
