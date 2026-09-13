import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

/**
 * 程序化文字贴图。
 *
 * 全作不使用任何外部素材，但匾额、条幅、标语上的字不能靠几何体拼。
 * 于是用 canvas 现画：白字透明底，交给材质上色与光照。
 * 生成的贴图带污渍与缺角，避免"电脑打印"的干净感。
 */

export interface TextTexOpts {
  /** 画布横向像素，默认按字数与字号推算。 */
  width?: number;
  height?: number;
  fontSize?: number;
  /** 竖排（匾额横排，幡与标语竖排）。 */
  vertical?: boolean;
  font?: string;
  /** 字色。 */
  color?: string;
  /** 每个字的随机位移与旋转（手写的不整齐）。 */
  jitter?: number;
  /** 污渍强度 0..1。 */
  stain?: number;
  /** 缺墨：随机让部分像素透明。 */
  erosion?: number;
  /** 字距（竖排时为行距）。 */
  tracking?: number;
  /** 背景色，默认全透明。 */
  background?: string | null;
  /** 固定随机种子，保证分镜截图可复现。 */
  seed?: number;
}

const CJK = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let seedCounter = 0;

/** 生成一张文字贴图。调用方负责在不需要时 dispose。 */
export function makeTextTexture(text: string, opts: TextTexOpts = {}): CanvasTexture {
  const chars = [...text];
  const fontSize = opts.fontSize ?? 96;
  const vertical = opts.vertical ?? false;
  const tracking = opts.tracking ?? (vertical ? 1.18 : 1.06);
  const jitter = opts.jitter ?? 0.02;
  const stain = opts.stain ?? 0.45;
  const erosion = opts.erosion ?? 0.16;
  const color = opts.color ?? '#ffffff';
  const font = opts.font ?? `${fontSize}px ${CJK}`;

  const pad = fontSize * 0.5;
  const width = opts.width ?? Math.ceil(vertical ? fontSize * 1.5 + pad : chars.length * fontSize * tracking + pad);
  const height = opts.height ?? Math.ceil(vertical ? chars.length * fontSize * tracking + pad : fontSize * 1.5 + pad);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(4, width);
  canvas.height = Math.max(4, height);
  const g = canvas.getContext('2d');
  if (!g) {
    // 极端环境下拿不到 2d context：返回一张空白贴图，游戏仍可运行。
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    return tex;
  }

  const rnd = mulberry(opts.seed ?? 1337 + seedCounter++);

  if (opts.background) {
    g.fillStyle = opts.background;
    g.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    g.clearRect(0, 0, canvas.width, canvas.height);
  }

  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = color;

  const step = fontSize * tracking;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (ch === ' ') continue;
    const cx = vertical ? canvas.width / 2 : pad / 2 + step * (i + 0.5);
    const cy = vertical ? pad / 2 + step * (i + 0.5) : canvas.height / 2;
    g.save();
    g.translate(cx + (rnd() - 0.5) * fontSize * jitter, cy + (rnd() - 0.5) * fontSize * jitter);
    g.rotate((rnd() - 0.5) * jitter * 1.4);
    g.fillText(ch, 0, 0);
    g.restore();
  }

  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  // 缺墨：随机抹掉少量像素，边缘更碎。
  if (erosion > 0) {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! === 0) continue;
      if (rnd() < erosion * 0.055) d[i + 3] = 0;
      else if (rnd() < erosion * 0.1) d[i + 3] = Math.floor(d[i + 3]! * (0.35 + rnd() * 0.5));
    }
  }

  // 污渍：低频涂抹，让字看起来贴在旧东西上。
  if (stain > 0) {
    const spots = Math.round(6 + stain * 14);
    for (let s = 0; s < spots; s++) {
      const sx = rnd() * canvas.width;
      const sy = rnd() * canvas.height;
      const sr = fontSize * (0.25 + rnd() * 0.9);
      const grad = g.createRadialGradient(sx, sy, 0, sx, sy, sr);
      const dark = rnd() < 0.5;
      grad.addColorStop(0, dark ? `rgba(30,22,14,${0.1 * stain})` : `rgba(240,232,210,${0.07 * stain})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sx, sy, sr, 0, Math.PI * 2);
      g.fill();
    }
    g.putImageData(img, 0, 0);
  } else {
    g.putImageData(img, 0, 0);
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** 手写体的便签/信纸：横条纹 + 潦草的字块（不写真实内容，避免可读的伪造文本）。 */
export function makeLetterTexture(seed = 7): CanvasTexture {
  const rnd = mulberry(seed);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 340;
  const g = canvas.getContext('2d');
  if (!g) {
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }

  g.fillStyle = '#d9d2bd';
  g.fillRect(0, 0, 256, 340);
  g.strokeStyle = 'rgba(120,105,80,0.35)';
  g.lineWidth = 1;
  for (let y = 34; y < 330; y += 18) {
    g.beginPath();
    g.moveTo(14, y);
    g.lineTo(242, y);
    g.stroke();
  }
  // 字迹：短横线，长度随机，模拟中文行
  g.strokeStyle = 'rgba(38,34,30,0.62)';
  for (let y = 26; y < 322; y += 18) {
    let x = 20;
    const end = 236 - rnd() * 60;
    while (x < end) {
      const w = 5 + rnd() * 9;
      g.lineWidth = 1.6 + rnd() * 1.2;
      g.beginPath();
      g.moveTo(x, y + (rnd() - 0.5) * 2);
      g.lineTo(x + w, y + (rnd() - 0.5) * 2);
      g.stroke();
      x += w + 3 + rnd() * 4;
    }
  }
  g.fillStyle = 'rgba(150,120,70,0.16)';
  for (let i = 0; i < 22; i++) {
    g.beginPath();
    g.arc(rnd() * 256, rnd() * 340, 4 + rnd() * 26, 0, Math.PI * 2);
    g.fill();
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
