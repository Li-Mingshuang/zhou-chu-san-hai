/** 数学与随机工具。确定性随机用 mulberry32，保证分镜截图可复现。 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** 帧率无关的指数逼近。lambda 越大越快。 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** 角度归一到 (-PI, PI]。 */
export const wrapAngle = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x <= -Math.PI) x += Math.PI * 2;
  return x;
};

/** 帧率无关的角度逼近。 */
export const dampAngle = (current: number, target: number, lambda: number, dt: number): number =>
  current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));

export const easeInOutCubic = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

export const easeInCubic = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * x;
};

/** mulberry32：小巧、确定性的伪随机数发生器。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  (): number;
  range(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  pick<T>(arr: readonly T[]): T;
  sign(): number;
}

export function rng(seed: number): Rng {
  const r = makeRng(seed) as Rng;
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.int = (lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length]!;
  r.sign = () => (r() < 0.5 ? -1 : 1);
  return r;
}

/** 在 [0,1) 之间取值的平滑噪声（一维，够用）。 */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number): number => {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  const a = h(i);
  const b = h(i + 1);
  return lerp(a, b, smoothstep(f));
}

/** 二维值噪声，用于地形起伏。 */
export function noise2(x: number, y: number): number {
  const h = (n: number, m: number): number => {
    const s = Math.sin(n * 127.1 + m * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smoothstep(x - xi);
  const yf = smoothstep(y - yi);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}

export function fbm2(x: number, y: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq) * amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

/** 把 v 从 [a,b] 映射到 [0,1] 并夹紧。 */
export const invLerp = (a: number, b: number, v: number): number => clamp((v - a) / (b - a), 0, 1);

/** 近似的秒表格式化，用于结局统计。 */
export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
