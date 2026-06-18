// mobile/scripts/make-icon.mjs — generate the flattr app icon (solid black, white "f")
// with zero dependencies (hand-rolled PNG encoder). Run: node scripts/make-icon.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const WHITE = [255, 255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function canvas(bg) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    buf[i * 4] = bg[0];
    buf[i * 4 + 1] = bg[1];
    buf[i * 4 + 2] = bg[2];
    buf[i * 4 + 3] = bg[3];
  }
  return buf;
}
function rect(buf, x0, y0, x1, y1, col) {
  for (let y = Math.max(0, y0 | 0); y < Math.min(SIZE, y1 | 0); y++) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(SIZE, x1 | 0); x++) {
      const i = (y * SIZE + x) * 4;
      buf[i] = col[0];
      buf[i + 1] = col[1];
      buf[i + 2] = col[2];
      buf[i + 3] = col[3];
    }
  }
}
// Lowercase "f": tall stem, top hook arm to the right, mid crossbar (1024-space).
const F_RECTS = [
  [460, 330, 580, 800], // stem
  [460, 330, 712, 446], // top hook arm
  [356, 506, 668, 602], // crossbar
];
function drawF(buf, scale) {
  const c = 512;
  for (const [x0, y0, x1, y1] of F_RECTS) {
    rect(buf, c + (x0 - c) * scale, c + (y0 - c) * scale, c + (x1 - c) * scale, c + (y1 - c) * scale, WHITE);
  }
}

// Legacy / iOS / store icon: black background + f.
const icon = canvas([0, 0, 0, 255]);
drawF(icon, 1.0);
writeFileSync("mobile/assets/icon.png", png(icon, SIZE, SIZE));

// Android adaptive foreground: transparent + f scaled into the safe zone.
const fg = canvas([0, 0, 0, 0]);
drawF(fg, 0.62);
writeFileSync("mobile/assets/android-icon-foreground.png", png(fg, SIZE, SIZE));

// Solid-black adaptive background (also drives splash-style fallbacks).
writeFileSync("mobile/assets/android-icon-background.png", png(canvas([0, 0, 0, 255]), SIZE, SIZE));

console.log("wrote icon.png, android-icon-foreground.png, android-icon-background.png (black + f)");
