// Generates the extension icons (16/48/128) with no image libraries: an
// accent-blue rounded square with a white audio-waveform, encoded to PNG via
// Node's built-in zlib. Run: `node icons/gen-icons.mjs`
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const ACCENT = [0x00, 0x77, 0xff];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function makeIcon(N) {
  const rgba = new Uint8Array(N * N * 4);
  const radius = Math.round(N * 0.22);
  // Waveform: 5 bars, heights as fraction of N.
  const heights = [0.34, 0.6, 0.82, 0.5, 0.24];
  const barW = Math.max(1, Math.round(N * 0.09));
  const gap = Math.max(1, Math.round(N * 0.06));
  const totalW = heights.length * barW + (heights.length - 1) * gap;
  const startX = Math.round((N - totalW) / 2);

  const inRounded = (x, y) => {
    // Rounded-rect membership test.
    const rx = Math.min(x, N - 1 - x);
    const ry = Math.min(y, N - 1 - y);
    if (rx >= radius || ry >= radius) return true;
    const dx = radius - rx;
    const dy = radius - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      if (!inRounded(x, y)) { rgba[i + 3] = 0; continue; }
      // background
      let col = ACCENT, a = 255;
      // bars
      for (let b = 0; b < heights.length; b++) {
        const bx = startX + b * (barW + gap);
        if (x >= bx && x < bx + barW) {
          const h = Math.round(heights[b] * N);
          const top = Math.round((N - h) / 2);
          if (y >= top && y < top + h) { col = WHITE; }
        }
      }
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = a;
    }
  }
  return png(N, N, rgba);
}

for (const N of [16, 48, 128]) {
  writeFileSync(new URL(`./icon${N}.png`, import.meta.url), makeIcon(N));
  console.log(`wrote icon${N}.png`);
}
