#!/usr/bin/env node
'use strict';

/**
 * Генерирует иконки расширения (extension/icons/*.png) без единой зависимости:
 * собираем PNG вручную — IHDR + IDAT (zlib) + IEND.
 *
 * Запускается автоматически из bin/cli.js и из `npm run icons`.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y += 1) {
    raw[o++] = 0; // фильтр none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixelAt(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/** Зелёно-голубой квадрат со скруглением и белым «>$» внутри. */
function pixel(x, y, size) {
  const u = x / (size - 1);
  const v = y / (size - 1);

  // скруглённый квадрат (SDF)
  const r = 0.24;
  const px = Math.abs(u - 0.5) - (0.5 - r);
  const py = Math.abs(v - 0.5) - (0.5 - r);
  const d = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - r;
  if (d > 0.012) return [0, 0, 0, 0];

  const t = (u + v) / 2;
  let [R, G, B] = [lerp(34, 20, t), lerp(197, 184, t), lerp(94, 166, t)];

  // глиф ">" и "_" — рисуем простыми геометрическими условиями
  const gx = u;
  const gy = v;
  const stroke = 0.085;
  // стрелка ">"
  const ax = 0.24;
  const inChevron =
    gx > ax &&
    gx < ax + 0.34 &&
    Math.abs(gy - (0.32 + (gx - ax) * 0.55)) < stroke * 0.6 &&
    (gx - ax) < 0.34;
  const inChevron2 =
    gx > ax &&
    gx < ax + 0.34 &&
    Math.abs(gy - (0.68 - (gx - ax) * 0.55)) < stroke * 0.6;
  // курсор "_"
  const inCursor = gx > 0.52 && gx < 0.78 && gy > 0.6 && gy < 0.72;

  if (inChevron || inChevron2 || inCursor) {
    R = 255;
    G = 255;
    B = 255;
  }

  const edge = d > -0.012 ? 0.55 : 1;
  return [R, G, B, Math.round(255 * edge)];
}

function main() {
  const outDir = path.join(__dirname, '..', 'extension', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = encodePng(size, pixel);
    fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
    console.log(`  ✓ extension/icons/icon${size}.png  (${png.length} байт)`);
  }
}

if (require.main === module) main();

module.exports = { encodePng, main };
