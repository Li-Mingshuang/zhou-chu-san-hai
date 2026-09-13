// 把屏幕截图转成可读的东西。
//
// 这个会话里的模型看不了图片，所以验证靠两条：
//   1) 客观统计（是不是全黑、有没有几何结构、色彩分布）
//   2) 一张 ASCII 亮度图 —— 构图可以直接"读"出来
//
//   node tools/inspect.mjs shots/reckoning.png [列数]
//
// 只支持 Chrome 截图产生的 PNG：8bit、非隔行、无调色板或带调色板。

import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf) {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error('不是 PNG');
  }
  let off = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ctype = 0;
  let palette = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
      if (depth !== 8) throw new Error(`不支持 ${depth} 位深`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error(`不支持的颜色类型 ${ctype}`);
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    line.copy(cur);
    if (filter === 1) {
      for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const c = i >= bpp ? prev[i - bpp] : 0;
        cur[i] = (cur[i] + paeth(a, prev[i], c)) & 0xff;
      }
    }
    prev = cur;
  }

  return { w, h, channels, data: out, stride, palette, ctype };
}

export function toRgb(img, x, y) {
  const i = y * img.stride + x * img.channels;
  const d = img.data;
  if (img.ctype === 3 && img.palette) {
    const pi = d[i] * 3;
    return [img.palette[pi], img.palette[pi + 1], img.palette[pi + 2]];
  }
  if (img.channels >= 3) return [d[i], d[i + 1], d[i + 2]];
  return [d[i], d[i], d[i]];
}

export function luminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const RAMP = ' .:-=+*#%@';

export function asciiMap(img, cols = 76) {
  const rows = Math.max(8, Math.round((cols * img.h) / img.w / 2.1));
  const cw = img.w / cols;
  const ch = img.h / rows;
  const lines = [];
  let sumAll = 0;
  let sumSq = 0;
  let nAll = 0;
  let nearBlack = 0;

  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      let acc = 0;
      let cnt = 0;
      const x0 = Math.floor(rx * cw);
      const y0 = Math.floor(ry * ch);
      const x1 = Math.max(x0 + 1, Math.floor((rx + 1) * cw));
      const y1 = Math.max(y0 + 1, Math.floor((ry + 1) * ch));
      for (let y = y0; y < y1 && y < img.h; y += 2) {
        for (let x = x0; x < x1 && x < img.w; x += 2) {
          const [r, g, b] = toRgb(img, x, y);
          const l = luminance(r, g, b);
          acc += l;
          cnt++;
          sumAll += l;
          sumSq += l * l;
          nAll++;
          if (l < 0.02) nearBlack++;
        }
      }
      const v = cnt ? acc / cnt : 0;
      line += RAMP[Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1)))];
    }
    lines.push(line);
  }

  const mean = sumAll / Math.max(1, nAll);
  const variance = sumSq / Math.max(1, nAll) - mean * mean;
  return {
    lines,
    mean,
    std: Math.sqrt(Math.max(0, variance)),
    blackFraction: nearBlack / Math.max(1, nAll),
    rows,
    cols,
  };
}

/** 上半/下半、左/右的平均亮度，用来判断构图是否偏。 */
export function regionStats(img) {
  const zones = {
    'top-left': [0, 0.5, 0, 0.5],
    'top-right': [0.5, 1, 0, 0.5],
    'bot-left': [0, 0.5, 0.5, 1],
    'bot-right': [0.5, 1, 0.5, 1],
  };
  const out = {};
  for (const [name, [x0, x1, y0, y1]] of Object.entries(zones)) {
    let s = 0;
    let n = 0;
    for (let y = Math.floor(y0 * img.h); y < y1 * img.h; y += 3) {
      for (let x = Math.floor(x0 * img.w); x < x1 * img.w; x += 3) {
        const [r, g, b] = toRgb(img, x, y);
        s += luminance(r, g, b);
        n++;
      }
    }
    out[name] = s / Math.max(1, n);
  }
  return out;
}

/** 量化后的主色，用来确认"暖黄 / 惨绿 / 过曝白"是不是真的出现了。 */
export function dominantColors(img, buckets = 12) {
  const map = new Map();
  for (let y = 0; y < img.h; y += 3) {
    for (let x = 0; x < img.w; x += 3) {
      const [r, g, b] = toRgb(img, x, y);
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let e = map.get(key);
      if (!e) {
        e = { n: 0, r: 0, g: 0, b: 0 };
        map.set(key, e);
      }
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
    }
  }
  const total = [...map.values()].reduce((a, e) => a + e.n, 0);
  return [...map.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, buckets)
    .map((e) => ({
      hex:
        '#' +
        [e.r / e.n, e.g / e.n, e.b / e.n]
          .map((v) => Math.round(v).toString(16).padStart(2, '0'))
          .join(''),
      pct: ((e.n / total) * 100).toFixed(1),
    }));
}

function report(file, cols) {
  const img = decodePng(readFileSync(file));
  const map = asciiMap(img, cols);
  const zones = regionStats(img);
  const colors = dominantColors(img);

  console.log(`\n═══ ${file}`);
  console.log(`尺寸 ${img.w}×${img.h}  通道 ${img.channels}  类型 ${img.ctype}`);
  console.log(
    `平均亮度 ${map.mean.toFixed(3)}  标准差 ${map.std.toFixed(3)}  近黑占比 ${(map.blackFraction * 100).toFixed(1)}%`,
  );
  console.log(
    `分区亮度  TL ${zones['top-left'].toFixed(3)}  TR ${zones['top-right'].toFixed(3)}  BL ${zones['bot-left'].toFixed(3)}  BR ${zones['bot-right'].toFixed(3)}`,
  );
  console.log(`主色 ${colors.map((c) => `${c.hex}(${c.pct}%)`).join(' ')}`);
  console.log('─'.repeat(map.cols));
  for (const l of map.lines) console.log(l);
  console.log('─'.repeat(map.cols));

  const verdict = [];
  if (map.mean < 0.008) verdict.push('⚠ 几乎全黑——场景可能没渲染出来');
  if (map.std < 0.02) verdict.push('⚠ 几乎没有明暗差——可能是纯色画面');
  if (map.blackFraction > 0.92) verdict.push('⚠ 92% 以上接近纯黑');
  if (!verdict.length) verdict.push('✓ 有内容、有层次');
  console.log(verdict.join('\n'));
}

const args = process.argv.slice(2);
const cols = Number(args.find((a) => /^\d+$/.test(a)) ?? 76);
const files = args.filter((a) => a.endsWith('.png'));

if (!files.length) {
  const dir = 'shots';
  try {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.png')).sort()) {
      report(join(dir, f), cols);
    }
  } catch {
    console.error('用法：node tools/inspect.mjs shots/xxx.png [列数]');
  }
} else {
  for (const f of files) report(f, cols);
}
