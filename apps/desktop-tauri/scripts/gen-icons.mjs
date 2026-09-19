#!/usr/bin/env node
/**
 * gen-icons.mjs — dependency-free icon generator for the Tauri shell.
 *
 * Hand-rolls the three container formats (no image crates/packages needed):
 *   - PNG  : RGBA8 scanlines + zlib deflate, CRC32 by hand
 *   - ICO  : ICONDIR + ICONDIRENTRY[] with PNG-compressed entries (Vista+)
 *   - ICNS : 'icns' header + ic07 (128px) / ic08 (256px) PNG chunks
 *
 * Artwork: flat rounded square + white "D" (DeepSeek-ish indigo), rendered
 * per-pixel with 3x3 supersampling so 32px stays clean.
 *
 * Usage: node scripts/gen-icons.mjs   (from apps/desktop-tauri)
 * Writes into src-tauri/icons/ — the paths tauri.conf.json bundle.icon lists.
 */
import { deflateSync, inflateSync as inflateSyncImpl } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');

// --- palette -----------------------------------------------------------------
const BG = [77, 107, 254, 255]; // #4D6BFE
const FG = [255, 255, 255, 255];

// --- rasterizer ---------------------------------------------------------------

/** Rounded-square coverage (0..1) for a unit pixel center. */
function roundedSquare(x, y, radius) {
  const lo = radius;
  const hi = 1 - radius;
  const dx = x < lo ? lo - x : x > hi ? x - hi : 0;
  const dy = y < lo ? lo - y : y > hi ? y - hi : 0;
  const d = Math.hypot(dx, dy);
  if (d <= radius - 0.008) return 1;
  if (d >= radius + 0.008) return 0;
  return (radius + 0.008 - d) / 0.016; // 1px antialias band
}

/** "D" glyph coverage: vertical stem + right-side half-annulus. */
function glyphD(x, y) {
  const inStem = x >= 0.3 && x <= 0.44 && y >= 0.24 && y <= 0.76;
  const dx = x - 0.44;
  const dy = y - 0.5;
  const dist = Math.hypot(dx, dy);
  const inBowl = x >= 0.44 && dist >= 0.12 && dist <= 0.26 && Math.abs(dy) <= 0.26;
  return inStem || inBowl ? 1 : 0;
}

/** Render size×size RGBA buffer. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const subs = 3; // 3x3 supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let coverage = 0;
      let fgHit = 0;
      for (let sy = 0; sy < subs; sy++) {
        for (let sx = 0; sx < subs; sx++) {
          const x = (px + (sx + 0.5) / subs) / size;
          const y = (py + (sy + 0.5) / subs) / size;
          const alpha = roundedSquare(x, y, radius / size);
          coverage += alpha;
          if (alpha > 0 && glyphD(x, y)) fgHit += alpha;
        }
      }
      coverage /= subs * subs;
      fgHit /= subs * subs;
      const o = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[o + c] = Math.round(BG[c] + (FG[c] - BG[c]) * fgHit);
      }
      rgba[o + 3] = Math.round(255 * coverage);
    }
  }
  return rgba;
}

// --- PNG encoder ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // bytes 10..12 stay 0: deflate, adaptive filtering, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO encoder (PNG-compressed entries) --------------------------------------

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + entries.length;
  const blobs = [];
  images.forEach((img, i) => {
    const e = entries.subarray(i * 16, i * 16 + 16);
    e[0] = img.size >= 256 ? 0 : img.size; // 0 means 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.png.length;
    blobs.push(img.png);
  });
  return Buffer.concat([header, entries, ...blobs]);
}

// --- ICNS encoder (ic07/ic08 PNG chunks) -----------------------------------------

function encodeIcns(images) {
  const chunks = images.map((img) => {
    const head = Buffer.alloc(8);
    head.write(img.type, 0, 'ascii');
    head.writeUInt32BE(8 + img.png.length, 4);
    return Buffer.concat([head, img.png]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

// --- generate --------------------------------------------------------------------

const png32 = encodePng(32, 32, drawIcon(32));
const png128 = encodePng(128, 128, drawIcon(128));
const png256 = encodePng(256, 256, drawIcon(256));
const png512 = encodePng(512, 512, drawIcon(512));

const outputs = new Map([
  ['32x32.png', png32],
  ['128x128.png', png128],
  ['128x128@2x.png', png256],
  ['icon.png', png512],
  ['icon.ico', encodeIco([
    { size: 32, png: png32 },
    { size: 128, png: png128 },
    { size: 256, png: png256 },
  ])],
  ['icon.icns', encodeIcns([
    { type: 'ic07', png: png128 }, // 128x128
    { type: 'ic08', png: png256 }, // 256x256
  ])],
]);

// --- self check: re-parse every PNG we just built ----------------------------------

function assertPng(png, expectWidth, expectHeight) {
  const signature = '89504e470d0a1a0a';
  if (png.subarray(0, 8).toString('hex') !== signature) throw new Error('bad PNG signature');
  if (png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('missing IHDR');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== expectWidth || height !== expectHeight) {
    throw new Error(`IHDR ${width}x${height}, expected ${expectWidth}x${expectHeight}`);
  }
  if (png[24] !== 8 || png[25] !== 6) throw new Error('expected 8-bit RGBA');
  // inflate IDAT and check the raw scanline size
  let idat = Buffer.alloc(0);
  let pos = 8;
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('ascii');
    if (type === 'IDAT') idat = Buffer.concat([idat, png.subarray(pos + 8, pos + 8 + len)]);
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const inflated = zlibInflateSync(idat);
  const expected = (width * 4 + 1) * height;
  if (inflated.length !== expected) {
    throw new Error(`IDAT inflates to ${inflated.length}, expected ${expected}`);
  }
}

function zlibInflateSync(buf) {
  return inflateSyncImpl(buf);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, blob] of outputs) {
  if (name.endsWith('.png')) assertPng(blob, blob.readUInt32BE(16), blob.readUInt32BE(20));
  writeFileSync(join(OUT_DIR, name), blob);
  console.log(`wrote ${name} (${blob.length} bytes)`);
}
console.log(`icons generated in ${OUT_DIR}`);
