import type { Level } from '../world/Collision.js';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface RayHit {
  /** 命中距离。 */
  t: number;
  x: number;
  y: number;
  z: number;
  /** 命中面法线（近似：取分量最大的一轴）。 */
  nx: number;
  ny: number;
  nz: number;
  /** 'wall' 或命中对象的 id。 */
  what: string;
  /** 命中的对象（如果有）。 */
  target?: unknown;
}

/** 归一化射线方向。 */
export function normalize(dir: Vec3Like): [number, number, number] {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return [dir.x / len, dir.y / len, dir.z / len];
}

/**
 * 射线与竖直圆柱求交（人的碰撞体近似）。
 * 返回最近的 [0, maxDist] 内的 t，未命中返回 null。
 */
export function rayCylinder(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cz: number,
  y0: number,
  y1: number,
  radius: number,
  maxDist: number,
): number | null {
  const mx = ox - cx;
  const mz = oz - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (mx * dx + mz * dz);
  const c = mx * mx + mz * mz - radius * radius;

  let t0: number;
  if (a < 1e-9) {
    // 垂直射击：只要在圆柱范围内，取进入高度的时间
    if (c > 0) return null;
    t0 = 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const inv = 1 / (2 * a);
    const ta = (-b - sq) * inv;
    const tb = (-b + sq) * inv;
    if (tb < 0) return null;
    t0 = ta >= 0 ? ta : 0;
  }

  // 圆柱自身起始处可能已经在内部，需要沿射线找高度落在 [y0, y1] 的区间
  let t = t0;
  for (let guard = 0; guard < 4; guard++) {
    const y = oy + dy * t;
    if (y >= y0 && y <= y1 && t >= 0 && t <= maxDist) return t;
    // 跳到下一个与上下端面相交的位置
    if (Math.abs(dy) < 1e-9) return null;
    const ty = y < y0 ? (y0 - oy) / dy : (y1 - oy) / dy;
    if (ty <= t) return null;
    t = ty;
    // 端面交点若在圆柱半径内则命中
    const px = ox + dx * t;
    const pz = oz + dz * t;
    const dd = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
    if (dd <= radius * radius && t >= 0 && t <= maxDist) return t;
    // 否则继续往外找
    if (t > maxDist) return null;
    break;
  }
  return null;
}

/**
 * 一次完整的射击/视线射线：先与关卡墙体求交，再逐个与目标圆柱求交，
 * 返回最近的那个。
 */
export interface CylinderTarget {
  id: string;
  x: number;
  z: number;
  y0: number;
  y1: number;
  radius: number;
  alive: boolean;
  ref?: unknown;
}

export function castShot(
  level: Level,
  origin: Vec3Like,
  dir: Vec3Like,
  maxDist: number,
  targets: readonly CylinderTarget[],
  opts: { sight?: boolean } = {},
): RayHit | null {
  const [dx, dy, dz] = normalize(dir);

  let best: RayHit | null = null;
  let bestT = maxDist;

  const wall = level.ray(origin, { x: dx, y: dy, z: dz }, maxDist, { sight: opts.sight ?? false });
  if (wall) {
    bestT = wall.t;
    best = {
      t: wall.t,
      x: wall.point[0],
      y: wall.point[1],
      z: wall.point[2],
      nx: 0,
      ny: 1,
      nz: 0,
      what: wall.box.tag,
    };
  }

  for (const tg of targets) {
    if (!tg.alive) continue;
    const t = rayCylinder(
      origin.x,
      origin.y,
      origin.z,
      dx,
      dy,
      dz,
      tg.x,
      tg.z,
      tg.y0,
      tg.y1,
      tg.radius,
      maxDist,
    );
    if (t === null || t >= bestT) continue;
    bestT = t;
    best = {
      t,
      x: origin.x + dx * t,
      y: origin.y + dy * t,
      z: origin.z + dz * t,
      nx: 0,
      ny: 0,
      nz: 0,
      what: tg.id,
      target: tg.ref,
    };
  }

  return best;
}

/** 命中点属于身体的哪个部位：头、胸、腹、腿。用于决定倒下的方式。 */
export function hitZone(hitY: number, feetY: number): 'head' | 'chest' | 'gut' | 'leg' {
  const h = hitY - feetY;
  if (h > 1.52) return 'head';
  if (h > 1.12) return 'chest';
  if (h > 0.78) return 'gut';
  return 'leg';
}
