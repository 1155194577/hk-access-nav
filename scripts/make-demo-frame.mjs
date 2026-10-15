/**
 * Generate the demo image used by "What is this?".
 *
 * Why generate rather than ship a photo: the app sends a frame to a vision model,
 * and during development there is often no camera (the iOS Simulator has none,
 * and expo-camera is device-only). A synthetic scene with recognisable content —
 * tactile paving, a step, a handrail — exercises the whole path and gives the
 * model something real to describe, which a solid grey square would not.
 *
 * Output is a PNG. There is no image codec available in this environment, so
 * writing a real baseline JPEG encoder would mean hand-rolling DCT and Huffman
 * tables. That is unnecessary: the vision request carries the image as base64
 * inside JSON, so the bytes are opaque and only the declared MIME type has to
 * match. The PNG is written as .png and the app declares image/png.
 *
 * Run:  node scripts/make-demo-frame.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 480;
const HEIGHT = 360;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'assets', 'demo');
const outPng = join(outDir, 'sidewalk.png');

/** RGB triple for one pixel. Painted top-down, left to right. */
function paint(x, y) {
  const horizon = 150;

  // Upper third: a flat building wall with vertical pier shading.
  if (y < horizon) {
    const pier = Math.floor(x / 48) % 2 === 0 ? 0 : -18;
    const lintel = y > horizon - 26 && y < horizon - 18 ? -26 : 0;
    return [104 + pier + lintel, 112 + pier + lintel, 124 + pier + lintel];
  }

  // A step edge across the pavement, low in the frame. This must be checked
  // before the paving strip so it cuts across it, like a real step does.
  if (y > 300 && y < 314) return [186, 186, 184];

  // Tactile paving: a bright yellow strip down the lower centre, with the raised
  // bars a vision model can actually latch onto.
  if (x >= 190 && x < 290) {
    const barPhase = Math.floor((y - horizon) / 12) % 2;
    const shade = barPhase === 0 ? 16 : 0;
    return [214 + shade, 176 + shade, 40];
  }

  // Handrail on the right: a bright vertical bar with a shadow beside it.
  if (x > 400 && x < 414 && y > 120 && y < 320) return [196, 198, 202];
  if (x >= 414 && x < 422 && y > 120 && y < 320) return [52, 54, 56];

  // Ground plane, with a little perspective shading so it is not flat colour.
  const depth = Math.max(0, Math.min(1, (y - horizon) / (HEIGHT - horizon)));
  const shading = Math.round(depth * 14);
  return [74 - shading, 76 - shading, 78 - shading];
}

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildPng() {
  // Raw scanlines: one filter byte (0 = none) then RGB triples.
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  let p = 0;
  for (let y = 0; y < HEIGHT; y += 1) {
    raw[p] = 0;
    p += 1;
    for (let x = 0; x < WIDTH; x += 1) {
      const [r, g, b] = paint(x, y);
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      p += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
const png = buildPng();
writeFileSync(outPng, png);
console.log(`wrote ${outPng} (${png.length} bytes, ${WIDTH}x${HEIGHT})`);
