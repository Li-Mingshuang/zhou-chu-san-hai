// 把截图变成能用眼睛读的文本。
//
// 两种渲染：
//   line   Canny 式边缘（高斯 → Sobel → 非极大值抑制 → 滞后阈值）→ 盲文点阵
//   solid  Otsu 阈值切出明暗块 → 盲文点阵
//
// 为什么用盲文（U+2800–U+28FF）：一个字符里塞得下 2×4 个点，
// 在等宽字体里子像素接近正方，于是 108 列的文本就有 216×144 的有效分辨率——
// 这是"看得出来是什么"和"只看得出来有东西"的分界。
// 早先一格里只放一个方向字符（- | / \），细线一密就糊成一团，画面完全不形象。
//
//   node tools/sketch.mjs shots/reckoning.png
//   node tools/sketch.mjs shots/reckoning.png --mode solid --w 140
//   node tools/sketch.mjs shots/reckoning.png --crop 500,300,900,560 --w 120
//   node tools/sketch.mjs a-on.png --vs a-off.png        # 把某个角色/道具单独抠出来
//
// 参数
//   --w N          输出宽度（字符列数），默认 108
//   --crop x0,y0,x1,y1   只看一块（放大看细节就靠它）
//   --mode line|solid|hue|all   默认 line
//   --thresh F     边缘灵敏度 0..1（越大线越少），默认 0.16
//   --vs other.png 与另一张图求差，渲染差异形状
//   --blobs        报告前景连通块的包围盒
//   --grid         每 10 列打一次刻度

import { readFileSync } from 'node:fs';
import { decodePng, toRgb, luminance } from './inspect.mjs';

// ── 参数 ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.png'));
if (!file) {
  console.error(
    '用法：node tools/sketch.mjs <图片.png> [--w 108] [--mode line|solid|all] [--crop x0,y0,x1,y1] [--vs 另一张.png] [--thresh 0.16] [--blobs] [--grid]',
  );
  process.exit(1);
}
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const wantW = Number(opt('w', 108));
const mode = opt('mode', 'line');
const sens = Number(opt('thresh', 0.16));
const wantBlobs = has('blobs');
const wantGrid = has('grid');
const cropArg = opt('crop', null);
const vsPath = opt('vs', null);

// ── 解码与裁剪 ──────────────────────────────────────────────

const full = decodePng(readFileSync(file));
const offX = cropArg ? Number(cropArg.split(',')[0]) : 0;
const offY = cropArg ? Number(cropArg.split(',')[1]) : 0;
let img = full;
if (cropArg) {
  const [, , x1, y1] = cropArg.split(',').map(Number);
  const w = Math.max(8, Math.min(full.w - offX, x1 - offX));
  const h = Math.max(8, Math.min(full.h - offY, y1 - offY));
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = toRgb(full, offX + x, offY + y);
      const i = (y * w + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  img = { w, h, channels: 3, data, stride: w * 3, ctype: 2, palette: null };
}
const W = img.w;
const H = img.h;
const px = (x, y) => toRgb(img, Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y)));

// ── 灰度 ────────────────────────────────────────────────────

const gray = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const [r, g, b] = px(x, y);
    gray[y * W + x] = luminance(r, g, b);
  }
}

/**
 * 自动色阶：把 2%–98% 分位拉到 0–1。
 * 礼厅那种整体很暗的画面，不做这一步边缘全挤在 0 附近，什么都检不出来。
 */
function autoLevels(src) {
  const sorted = Float32Array.from(src);
  sorted.sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const span = Math.max(1e-4, hi - lo);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.min(1, Math.max(0, (src[i] - lo) / span));
  return out;
}
const levelled = autoLevels(gray);

/** 可分离盒式模糊（两端都要钳，少一个 Math.max 就会读出 undefined 变成 NaN）。 */
function blur(src, radius, passes) {
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += cur[y * W + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = sum / (radius * 2 + 1);
        sum +=
          cur[y * W + Math.min(W - 1, x + radius + 1)] -
          cur[y * W + Math.min(W - 1, Math.max(0, x - radius))];
      }
    }
    const out = new Float32Array(W * H);
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = sum / (radius * 2 + 1);
        sum +=
          tmp[Math.min(H - 1, y + radius + 1) * W + x] -
          tmp[Math.min(H - 1, Math.max(0, y - radius)) * W + x];
      }
    }
    cur = out;
  }
  return cur;
}
const smooth = blur(levelled, 1, 1);

// ── Sobel + 非极大值抑制 + 滞后阈值 ─────────────────────────

const gx = new Float32Array(W * H);
const gy = new Float32Array(W * H);
const mag = new Float32Array(W * H);
let magMax = 0;
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const a = smooth[i - W - 1];
    const b = smooth[i - W];
    const c = smooth[i - W + 1];
    const d = smooth[i - 1];
    const f = smooth[i + 1];
    const g2 = smooth[i + W - 1];
    const h = smooth[i + W];
    const k = smooth[i + W + 1];
    const sx = c + 2 * f + k - (a + 2 * d + g2);
    const sy = g2 + 2 * h + k - (a + 2 * b + c);
    gx[i] = sx;
    gy[i] = sy;
    const m = Math.hypot(sx, sy);
    mag[i] = m;
    if (m > magMax) magMax = m;
  }
}

/** 沿梯度方向做非极大值抑制：只留山脊上的那一个像素，线才是单像素宽的。 */
const nms = new Float32Array(W * H);
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const m = mag[i];
    if (m <= 1e-6) continue;
    let nx = gx[i];
    let ny = gy[i];
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const s1 = mag[(y + Math.round(ny)) * W + (x + Math.round(nx))] ?? 0;
    const s2 = mag[(y - Math.round(ny)) * W + (x - Math.round(nx))] ?? 0;
    if (m >= s1 && m >= s2) nms[i] = m;
  }
}

const norm = new Float32Array(W * H);
for (let i = 0; i < nms.length; i++) norm[i] = nms[i] / (magMax || 1);

/** 滞后阈值：强边缘起头，弱边缘只有连着强边缘才留下，轮廓才连得起来。 */
function hysteresis(high, low) {
  const isEdge = new Uint8Array(W * H);
  const stack = [];
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] >= high) {
      isEdge[i] = 2;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const y = Math.floor(i / W);
    const x = i % W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (isEdge[j] === 0 && norm[j] >= low) {
          isEdge[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return isEdge;
}
const edges = hysteresis(sens, sens * 0.42);

// ── 输出网格（盲文：2×4 子像素） ───────────────────────────

const COLS = Math.max(24, Math.min(300, wantW));
// 盲文一格在等宽字体里约 1:2 高，格内 2×4 个点 → 子像素接近正方，
// 行数按 H/(2W) 反推，画面才不会被拉长。
const ROWS = Math.max(6, Math.round((COLS * H) / (2 * W)));
const SUB_W = COLS * 2;
const SUB_H = ROWS * 4;
const CELL_W = W / SUB_W;
const CELL_H = H / SUB_H;

const BRAILLE_BASE = 0x2800;
// 盲文点序：
//   1 4
//   2 5
//   3 6
//   7 8
const DOT_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

/** 把一个 2×4 的子块打包成一个盲文字符。 */
function brailleChar(c, r, get) {
  let bits = 0;
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      if (get(c * 2 + dx, r * 4 + dy)) bits |= DOT_BIT[dy][dx];
    }
  }
  return bits === 0 ? ' ' : String.fromCharCode(BRAILLE_BASE + bits);
}

/** 子像素是否"命中"：看它覆盖的那块源图里有没有一个命中的像素。 */
function sampler(pred) {
  return (sx, sy) => {
    const x0 = Math.floor(sx * CELL_W);
    const x1 = Math.min(W, Math.max(x0 + 1, Math.ceil((sx + 1) * CELL_W)));
    const y0 = Math.floor(sy * CELL_H);
    const y1 = Math.min(H, Math.max(y0 + 1, Math.ceil((sy + 1) * CELL_H)));
    for (let y = y0; y < y1; y++) {
      const row = y * W;
      for (let x = x0; x < x1; x++) {
        if (pred(row + x)) return true;
      }
    }
    return false;
  };
}

function renderBraille(pred) {
  const get = sampler(pred);
  const lines = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) line += brailleChar(c, r, get);
    lines.push(line);
  }
  return lines;
}

/** Otsu 阈值：场景忽明忽暗，固定阈值不好使。 */
function otsuThreshold() {
  const hist = new Float64Array(256);
  for (let i = 0; i < levelled.length; i += 3) hist[Math.min(255, Math.floor(levelled[i] * 255))]++;
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) {
    total += hist[i];
    sumAll += i * hist[i];
  }
  let wB = 0;
  let sumB = 0;
  let best = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best / 255;
}
const otsu = otsuThreshold();

// ── 色相（字符图，缩略用） ──────────────────────────────────

function hueChar(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 510;
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  if (l < 0.09) return 'K';
  if (sat < 0.12) return l > 0.72 ? 'W' : l > 0.38 ? 'w' : 'k';
  let h;
  const d = mx - mn;
  if (mx === r) h = ((g - b) / d + 6) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  const c =
    h < 15 || h >= 345 ? 'R' : h < 45 ? 'O' : h < 70 ? 'Y' : h < 160 ? 'G' : h < 200 ? 'C' : h < 260 ? 'B' : 'M';
  return l < 0.35 ? c.toLowerCase() : c;
}

function renderHue() {
  const CW = W / COLS;
  const CH = H / ROWS;
  const lines = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let y = Math.floor(r * CH); y < (r + 1) * CH; y += 2) {
        for (let x = Math.floor(c * CW); x < (c + 1) * CW; x += 2) {
          const [rr, gg, bb] = px(x, y);
          sr += rr;
          sg += gg;
          sb += bb;
          n++;
        }
      }
      line += hueChar(sr / n, sg / n, sb / n);
    }
    lines.push(line);
  }
  return lines;
}

// ── 打印 ────────────────────────────────────────────────────

function rulerLine() {
  const CW = W / COLS;
  let a = '';
  let b = '';
  for (let c = 0; c < COLS; c++) {
    if (c % 10 === 0) {
      const s = String(Math.round(c * CW));
      a += s[0] ?? ' ';
      b += s.slice(1) || ' ';
    } else {
      a += ' ';
      b += ' ';
    }
  }
  return [a, b];
}

function printMap(title, lines, note) {
  console.log(`\n── ${title}${note ? '  ' + note : ''}`);
  if (wantGrid) {
    const [a, b] = rulerLine();
    console.log('     ' + a);
    console.log('     ' + b);
  }
  for (let r = 0; r < lines.length; r++) {
    const tag = wantGrid && r % 5 === 0 ? String(r * 4).padStart(4, ' ') : '    ';
    console.log(`${tag} ${lines[r]}`);
  }
}

// ── 判断 ────────────────────────────────────────────────────

function summary() {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  let dark = 0;
  let bright = 0;
  let edgeCount = 0;
  for (let i = 0; i < gray.length; i += 5) {
    const l = gray[i];
    sum += l;
    sum2 += l * l;
    n++;
    if (l < 0.05) dark++;
    if (l > 0.75) bright++;
    if (edges[i] > 0) edgeCount++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let bestRow = 0;
  let bestGrad = 0;
  for (let y = 1; y < H - 1; y++) {
    let g = 0;
    for (let x = 0; x < W; x += 3) g += Math.abs(smooth[(y + 1) * W + x] - smooth[(y - 1) * W + x]);
    if (g > bestGrad) {
      bestGrad = g;
      bestRow = y;
    }
  }
  console.log(`\n── 判断`);
  console.log(
    `   平均亮度 ${mean.toFixed(3)}  对比度 ${std.toFixed(3)}  近黑 ${((dark / n) * 100).toFixed(1)}%  高光 ${((bright / n) * 100).toFixed(1)}%`,
  );
  console.log(
    `   边缘像素 ${((edgeCount / n) * 100).toFixed(2)}%  Otsu ${otsu.toFixed(3)}  输出 ${COLS}×${ROWS} 字符 = ${SUB_W}×${SUB_H} 点`,
  );
  console.log(
    `   最强水平分界 y=${bestRow} (${((bestRow / H) * 100).toFixed(0)}%)${bestGrad > 0.6 * W ? ' —— 像一条地平线' : ''}`,
  );
  const flags = [];
  if (mean < 0.02) flags.push('⚠ 几乎全黑');
  if (std < 0.015) flags.push('⚠ 几乎没有结构');
  if (edgeCount / n < 0.002) flags.push('⚠ 几乎没有边缘——试试 --thresh 调低');
  if (edgeCount / n > 0.25) flags.push('⚠ 边缘太多太碎——试试 --thresh 调高');
  if (bright / n > 0.35) flags.push('⚠ 大面积过曝');
  if (dark / n > 0.6) flags.push('⚠ 六成以上是死黑');
  console.log(flags.length ? '   ' + flags.join('\n   ') : '   ✓ 有层次、有结构');
}

// ── 前景连通块 ──────────────────────────────────────────────

function blobReport() {
  const sorted = Float32Array.from(gray);
  sorted.sort();
  const median = sorted[Math.floor(sorted.length / 2)];
  const CW = W / COLS;
  const CH = H / ROWS;
  const mask = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let s = 0;
      let n = 0;
      let e = 0;
      for (let y = Math.floor(r * CH); y < (r + 1) * CH; y++) {
        for (let x = Math.floor(c * CW); x < (c + 1) * CW; x++) {
          s += gray[y * W + x];
          if (edges[y * W + x] > 0) e++;
          n++;
        }
      }
      mask[r * COLS + c] = Math.abs(s / n - median) > 0.09 || e / n > 0.2 ? 1 : 0;
    }
  }
  const seen = new Uint8Array(COLS * ROWS);
  const blobs = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (!mask[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let x0 = c;
      let x1 = c;
      let y0 = r;
      let y1 = r;
      let n = 0;
      while (stack.length) {
        const k = stack.pop();
        const ky = Math.floor(k / COLS);
        const kx = k % COLS;
        n++;
        if (kx < x0) x0 = kx;
        if (kx > x1) x1 = kx;
        if (ky < y0) y0 = ky;
        if (ky > y1) y1 = ky;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = kx + dx;
          const ny = ky + dy;
          if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
          const ni = ny * COLS + nx;
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      if (n >= 3) blobs.push({ x0, x1, y0, y1, n });
    }
  }
  blobs.sort((a, b) => b.n - a.n);
  console.log(`\n── 前景连通块（按面积，最多 10 个）`);
  if (!blobs.length) {
    console.log('   （没有明显的前景块）');
    return;
  }
  for (const bl of blobs.slice(0, 10)) {
    const wPct = (((bl.x1 - bl.x0 + 1) / COLS) * 100).toFixed(0);
    const hPct = (((bl.y1 - bl.y0 + 1) / ROWS) * 100).toFixed(0);
    console.log(
      `   列 ${String(bl.x0).padStart(3)}–${String(bl.x1).padStart(3)}  行 ${String(bl.y0).padStart(2)}–${String(bl.y1).padStart(2)}` +
        `   占画面 ${wPct}%×${hPct}%   格数 ${String(bl.n).padStart(4)}`,
    );
  }
}

// ── 与另一张图求差 ──────────────────────────────────────────

function renderDiff(otherPath) {
  const other = decodePng(readFileSync(otherPath));
  const readOther = (x, y) => toRgb(other, offX + x, offY + y);
  const diff = new Float32Array(W * H);
  let peak = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r1, g1, b1] = px(x, y);
      const [r2, g2, b2] = readOther(x, y);
      const d = Math.abs(luminance(r1, g1, b1) - luminance(r2, g2, b2));
      diff[y * W + x] = d;
      if (d > peak) peak = d;
    }
  }
  return {
    strong: renderBraille((i) => diff[i] > 0.16),
    faint: renderBraille((i) => diff[i] > 0.045),
    diff,
    peak,
  };
}

// ── 跑 ──────────────────────────────────────────────────────

console.log(`═══ ${file}${cropArg ? `  (crop ${cropArg})` : ''}`);
console.log(`源图 ${full.w}×${full.h}  取用 ${W}×${H}`);

summary();

if (!vsPath) {
  if (mode === 'line' || mode === 'all') {
    printMap('轮廓（Canny → 盲文）', renderBraille((i) => edges[i] > 0), `(sens ${sens})`);
  }
  if (mode === 'solid' || mode === 'all') {
    printMap('明暗块面（Otsu → 盲文）', renderBraille((i) => levelled[i] >= otsu), `(阈值 ${otsu.toFixed(2)}；点是亮的部分)`);
  }
  if (mode === 'hue' || mode === 'all') {
    printMap('色相', renderHue(), '(大写=亮 小写=暗；K黑 W白 w灰 R红 O橙 Y黄 G绿 C青 B蓝 M品红)');
  }
} else {
  const d = renderDiff(vsPath);
  const short = vsPath.split(/[\\/]/).pop();
  printMap(`与 ${short} 的差（强）`, d.strong, '(这块形状就是"多出来/少掉"的东西)');
  printMap('同一个差（弱，含边缘）', d.faint, '');
  let changed = 0;
  let n = 0;
  for (let i = 0; i < d.diff.length; i += 3) {
    if (d.diff[i] > 0.03) changed++;
    n++;
  }
  console.log(`\n   变化像素占比 ${((changed / n) * 100).toFixed(1)}%   峰值 ${d.peak.toFixed(2)}`);
}

if (wantBlobs) blobReport();
