#!/usr/bin/env node
/**
 * One-shot generator for the tray icon: writes assets/tray.png (16x16) and
 * assets/tray@2x.png (32x32) — Electron's DPI-suffix convention — as flat
 * RGBA rounded squares. Pure node: a hand-rolled PNG encoder (no dependencies,
 * no canvas, no Electron), run once and committed.
 *
 *   node scripts/make-tray-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(scriptDir, '..', 'assets');

const COLOR = { r: 76, g: 141, b: 255, a: 255 }; // dsh blue

// --- CRC32 -------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

// --- PNG chunks ----------------------------------------------------------------
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Minimal RGBA PNG: IHDR + IDAT (filter-0 scanlines) + IEND. */
function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`pixel buffer must be ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0; // filter type 0
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Flat rounded square, centered, covering `fill` of the canvas. */
function roundedSquare(size, radius, color) {
  const rgba = Buffer.alloc(size * size * 4);
  const margin = Math.max(1, Math.round(size * 0.0625)); // 1px at 16, 2px at 32
  const x0 = margin;
  const y0 = margin;
  const x1 = size - 1 - margin;
  const y1 = size - 1 - margin;
  const r = Math.min(radius, Math.floor((x1 - x0) / 2), Math.floor((y1 - y0) / 2));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside =
        x >= x0 && x <= x1 && y >= y0 && y <= y1
          ? insideRoundedCorner(x, y, x0, y0, x1, y1, r)
          : false;
      const offset = (y * size + x) * 4;
      rgba[offset] = inside ? color.r : 0;
      rgba[offset + 1] = inside ? color.g : 0;
      rgba[offset + 2] = inside ? color.b : 0;
      rgba[offset + 3] = inside ? color.a : 0;
    }
  }
  return rgba;
}

function insideRoundedCorner(x, y, x0, y0, x1, y1, r) {
  const corners = [
    { cx: x0 + r, cy: y0 + r },
    { cx: x1 - r, cy: y0 + r },
    { cx: x0 + r, cy: y1 - r },
    { cx: x1 - r, cy: y1 - r },
  ];
  for (const { cx, cy } of corners) {
    const inCornerZone =
      (x < x0 + r || x > x1 - r) && (y < y0 + r || y > y1 - r) &&
      ((x < x0 + r && y < y0 + r) || (x > x1 - r && y < y0 + r) || (x < x0 + r && y > y1 - r) || (x > x1 - r && y > y1 - r));
    if (inCornerZone) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r) return false;
    }
  }
  return true;
}

mkdirSync(assetsDir, { recursive: true });
const targets = [
  { file: 'tray.png', size: 16, radius: 4 },
  { file: 'tray@2x.png', size: 32, radius: 8 },
];
for (const { file, size, radius } of targets) {
  const png = encodePng(size, size, roundedSquare(size, radius, COLOR));
  writeFileSync(join(assetsDir, file), png);
  console.log(`[make-tray-icon] wrote assets/${file} (${size}x${size}, ${png.length} bytes)`);
}
