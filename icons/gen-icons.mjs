// Generates the extension icons (16/48/128) with no image libraries: the
// Winday mark — three off-white hearts arranged as a clover (tips meeting at
// the center) on a dark rounded square — rasterized per-pixel with 4×4
// supersampling and encoded to PNG via Node's built-in zlib.
// Run: `node icons/gen-icons.mjs`
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [0x1f, 0x1e, 0x1c];      // dark warm charcoal
const PETAL = [0xfa, 0xf9, 0xf5];   // off-white

// Tunables (fractions of the icon size N).
const CORNER = 0.255;   // rounded-square corner radius
const SCALE = 0.135;    // heart size (implicit-curve unit -> N)
const DIST = 0.175;     // heart local origin's distance from the icon center
const STRETCH = 1.22;   // widen the hearts (plumper than the raw curve)
const SHIFT_Y = 0.01;   // nudge the whole clover down a touch (optical center)

// Classic implicit heart: (x² + y² − 1)³ − x²·y³ ≤ 0 — lobes toward +y,
// tip at (0, −1). Evaluated in each petal's local frame.
function inHeart(x, y) {
  x /= STRETCH;
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

// The three petals: each heart's lobes point outward (up, lower-left,
// lower-right), so the tips meet near the center. u = outward unit vector.
const ANGLES = [90, 210, 330].map((deg) => (deg * Math.PI) / 180);
const PETALS = ANGLES.map((t) => ({ ux: Math.cos(t), uy: Math.sin(t) }));

function inClover(mx, my) {
  // (mx, my): math coords in units of N, origin at the icon center, y up.
  for (const { ux, uy } of PETALS) {
    // Local frame: y along u (lobes outward), x perpendicular.
    const yh = (mx * ux + my * uy) / SCALE - DIST / SCALE;
    const xh = (mx * -uy + my * ux) / SCALE;
    if (yh > -1.05 && yh < 1.35 && inHeart(xh, yh)) return true;
  }
  return false;
}

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
  const radius = CORNER * N;
  const SS = 4; // 4×4 supersamples per pixel

  // Rounded-rect membership for a (sub)sample point in pixel units.
  const inRounded = (x, y) => {
    const rx = Math.min(x, N - x);
    const ry = Math.min(y, N - y);
    if (rx >= radius || ry >= radius) return rx >= 0 && ry >= 0;
    const dx = radius - rx;
    const dy = radius - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let shape = 0;  // subsamples inside the rounded square
      let petal = 0;  // subsamples inside a heart
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!inRounded(px, py)) continue;
          shape++;
          const mx = px / N - 0.5;
          const my = 0.5 - py / N + SHIFT_Y;
          if (inClover(mx, my)) petal++;
        }
      }
      const i = (y * N + x) * 4;
      if (shape === 0) { rgba[i + 3] = 0; continue; }
      const total = SS * SS;
      const t = petal / shape; // petal coverage within the visible part
      rgba[i] = Math.round(BG[0] + (PETAL[0] - BG[0]) * t);
      rgba[i + 1] = Math.round(BG[1] + (PETAL[1] - BG[1]) * t);
      rgba[i + 2] = Math.round(BG[2] + (PETAL[2] - BG[2]) * t);
      rgba[i + 3] = Math.round((shape / total) * 255);
    }
  }
  return png(N, N, rgba);
}

for (const N of [16, 48, 128]) {
  writeFileSync(new URL(`./icon${N}.png`, import.meta.url), makeIcon(N));
  console.log(`wrote icon${N}.png`);
}
