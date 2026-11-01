/**
 * 生成 tabBar 图标（81x81 PNG）。
 *
 * 用法：node tools/gen-tab-icons.js
 * 输出：miniapp/images/tab_home.png、tab_home_on.png、tab_history.png、tab_history_on.png
 *
 * 不依赖任何三方库：手写 PNG 编码（IHDR/IDAT/IEND + zlib deflate）。
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 81;
const INACTIVE = [140, 140, 140];  // #8C8C8C
const ACTIVE = [212, 175, 55];     // #D4AF37

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
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

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- 画布 ---
function createCanvas() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4, 0);
  return {
    rgba,
    set(x, y, color, alpha = 1) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
      const i = (y * SIZE + x) * 4;
      const a = Math.max(0, Math.min(1, alpha));
      const inv = 1 - a;
      rgba[i] = Math.round(color[0] * a + rgba[i] * inv);
      rgba[i + 1] = Math.round(color[1] * a + rgba[i + 1] * inv);
      rgba[i + 2] = Math.round(color[2] * a + rgba[i + 2] * inv);
      rgba[i + 3] = Math.round(255 * a + rgba[i + 3] * inv);
    }
  };
}

// 抗锯齿描边圆环
function strokeCircle(cv, cx, cy, r, width, color) {
  const outer = r + width / 2;
  const inner = r - width / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.max(0, Math.min(1, outer - d)) - Math.max(0, Math.min(1, inner - d));
      if (cover > 0) cv.set(x, y, color, cover);
    }
  }
}

// 抗锯齿实心圆
function fillCircle(cv, cx, cy, r, color) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cover = Math.max(0, Math.min(1, r - d));
      if (cover > 0) cv.set(x, y, color, cover);
    }
  }
}

// 抗锯齿线段
function strokeLine(cv, x0, y0, x1, y1, width, color) {
  const half = width / 2;
  const minX = Math.floor(Math.min(x0, x1) - half - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
  const minY = Math.floor(Math.min(y0, y1) - half - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      const cover = Math.max(0, Math.min(1, half - d + 0.5));
      if (cover > 0) cv.set(x, y, color, cover);
    }
  }
}

// 抗锯齿矩形
function fillRect(cv, x0, y0, w, h, color, radius = 0) {
  for (let y = Math.floor(y0) - 1; y < Math.ceil(y0 + h) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x < Math.ceil(x0 + w) + 1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let cover = 1;
      if (radius > 0) {
        // 圆角矩形：到内缩矩形的距离
        const ix = Math.max(x0 + radius - px, 0, px - (x0 + w - radius));
        const iy = Math.max(y0 + radius - py, 0, py - (y0 + h - radius));
        const d = Math.hypot(ix, iy);
        cover = Math.max(0, Math.min(1, radius - d + 0.5));
      } else {
        cover =
          Math.max(0, Math.min(1, x0 + 0.5 - px + 0.5, px - (x0 + w - 0.5) + 0.5)) *
          Math.max(0, Math.min(1, y0 + 0.5 - py + 0.5, py - (y0 + h - 0.5) + 0.5));
        cover = Math.min(1, cover);
      }
      if (cover > 0) cv.set(x, y, color, cover);
    }
  }
}

// --- 图标绘制 ---

// 首页：放大镜（查个股）
function drawHome(cv, color) {
  strokeCircle(cv, 35, 35, 19, 6, color);
  strokeLine(cv, 48, 48, 64, 64, 7, color);
}

// 历史：时钟
function drawHistory(cv, color) {
  strokeCircle(cv, 40.5, 40.5, 25, 5.5, color);
  strokeLine(cv, 40.5, 26, 40.5, 42, 5, color);
  strokeLine(cv, 40.5, 42, 53, 42, 5, color);
}

function build(drawFn, color) {
  const cv = createCanvas();
  drawFn(cv, color);
  return encodePng(SIZE, SIZE, cv.rgba);
}

const outDir = path.join(__dirname, '..', 'miniapp', 'images');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = [
  ['tab_home.png', drawHome, INACTIVE],
  ['tab_home_on.png', drawHome, ACTIVE],
  ['tab_history.png', drawHistory, INACTIVE],
  ['tab_history_on.png', drawHistory, ACTIVE]
];

files.forEach(([name, fn, color]) => {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, build(fn, color));
  console.log('写入', file);
});
