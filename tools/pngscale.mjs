// 把文档用的截图缩小一半再压一遍。
//
// 仓库里不该躺着 8MB 的 PNG。没有 sharp / canvas 可用（也不想引依赖），
// 所以拿 inspect.mjs 里那个手写解码器配上 zlib 自己重新编码。
//
//   node tools/pngscale.mjs docs/*.png [倍率]

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { decodePng, toRgb } from './inspect.mjs';

// ── PNG 编码 ────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

function encodePng(w, h, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 真彩色 RGB
  ihdr[10] = 0; // 压缩
  ihdr[11] = 0; // 滤波
  ihdr[12] = 0; // 非隔行

  // 每行前面加一个滤波字节；用 1（Sub）对照片类画面压得更好
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const cur = rgb[i + c];
        const left = x > 0 ? rgb[i - 3 + c] : 0;
        raw[o + 1 + x * 3 + c] = (cur - left) & 0xff;
      }
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 整数倍率的方块平均降采样。 */
function shrink(img, factor) {
  const w = Math.floor(img.w / factor);
  const h = Math.floor(img.h / factor);
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const [pr, pg, pb] = toRgb(img, x * factor + dx, y * factor + dy);
          r += pr;
          g += pg;
          b += pb;
          n++;
        }
      }
      const i = (y * w + x) * 3;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
    }
  }
  return { w, h, data: out };
}

const args = process.argv.slice(2);
const factor = Number(args.find((a) => /^\d+$/.test(a)) ?? 2);
const files = args.filter((a) => a.endsWith('.png'));

if (!files.length) {
  console.error('用法：node tools/pngscale.mjs docs/*.png [倍率]');
  process.exit(1);
}

for (const f of files) {
  const before = readFileSync(f);
  const img = decodePng(before);
  const small = shrink(img, factor);
  const png = encodePng(small.w, small.h, small.data);
  writeFileSync(f, png);
  console.log(
    `${f}  ${img.w}×${img.h} ${(before.length / 1024).toFixed(0)}kB → ${small.w}×${small.h} ${(png.length / 1024).toFixed(0)}kB`,
  );
}
