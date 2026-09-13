import { clamp } from '../core/MathUtils.js';

/**
 * 关卡碰撞。不使用物理引擎：地板是解析函数，墙是轴对齐盒子。
 * 这对一座方方正正的乡下道场来说完全够用，且行为可预测——
 * 玩家永远卡不进墙里，也永远不会从楼梯上滑下去。
 */

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  tag: string;
  /** 是否阻挡视线与子弹。矮家具（长凳）为 false。 */
  sight: boolean;
  /** 是否可以踩上去（台阶、讲台）。 */
  standable: boolean;
}

export interface Flat {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
  tag: string;
}

export interface Ramp {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 在 z0（或 x0）处的高度。 */
  y0: number;
  /** 在 z1（或 x1）处的高度。 */
  y1: number;
  axis: 'z' | 'x';
  tag: string;
}

export interface Hit {
  /** 命中距离（沿射线）。 */
  t: number;
  point: [number, number, number];
  box: Box;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

interface RayOpts {
  sight?: boolean;
  /** 忽略某个 tag 前缀。 */
  ignoreTag?: string;
}

export class Level {
  readonly boxes: Box[] = [];
  readonly flats: Flat[] = [];
  readonly ramps: Ramp[] = [];
  terrain: (x: number, z: number) => number = () => 0;
  /** 能自动迈上去的高度差。高于此值的边沿一律阻挡。 */
  stepUp = 0.34;
  bounds = { x0: -220, x1: 220, z0: -220, z1: 220 };

  addBox(b: Omit<Box, 'tag' | 'sight' | 'standable'> & Partial<Box>): Box {
    const box: Box = {
      ...b,
      tag: b.tag ?? 'wall',
      sight: b.sight ?? true,
      standable: b.standable ?? false,
    };
    this.boxes.push(box);
    return box;
  }

  /** 由中心 + 尺寸声明一个盒子。 */
  boxAt(
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    tag = 'wall',
    opts: { sight?: boolean; standable?: boolean } = {},
  ): Box {
    return this.addBox({
      x0: cx - w / 2,
      x1: cx + w / 2,
      y0: cy - h / 2,
      y1: cy + h / 2,
      z0: cz - d / 2,
      z1: cz + d / 2,
      tag,
      sight: opts.sight ?? true,
      standable: opts.standable ?? false,
    });
  }

  addFlat(f: Omit<Flat, 'tag'> & { tag?: string }): Flat {
    const flat: Flat = { ...f, tag: f.tag ?? 'floor' };
    this.flats.push(flat);
    return flat;
  }

  addRamp(r: Omit<Ramp, 'tag'> & { tag?: string }): Ramp {
    const ramp: Ramp = { ...r, tag: r.tag ?? 'ramp' };
    this.ramps.push(ramp);
    return ramp;
  }

  clear(): void {
    this.boxes.length = 0;
    this.flats.length = 0;
    this.ramps.length = 0;
  }

  private inFlat(f: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number): boolean {
    return x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1;
  }

  /** 该点的地面高度：地形与所有不高于 stepUp 的地板取最高值。 */
  groundAt(x: number, z: number, feetY: number): number {
    let y = this.terrain(x, z);
    const limit = feetY + this.stepUp;
    for (const f of this.flats) {
      if (!this.inFlat(f, x, z)) continue;
      if (f.y > limit) continue;
      if (f.y > y) y = f.y;
    }
    for (const r of this.ramps) {
      if (!this.inFlat(r, x, z)) continue;
      const t = clamp(
        r.axis === 'z' ? (z - r.z0) / Math.max(1e-6, r.z1 - r.z0) : (x - r.x0) / Math.max(1e-6, r.x1 - r.x0),
        0,
        1,
      );
      const ry = r.y0 + (r.y1 - r.y0) * t;
      if (ry > limit) continue;
      if (ry > y) y = ry;
    }
    return y;
  }

  /** 水平推出：把半径为 radius 的圆柱挤出所有墙体。原地修改 pos。 */
  resolve(pos: Vec3Like, radius: number, height: number): void {
    // 两遍迭代，处理夹在两个盒子之间的情况。
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const b of this.boxes) {
        if (pos.y + height <= b.y0) continue; // 完全在盒子下方
        if (pos.y >= b.y1) continue; // 完全在盒子上方
        // 顶面不高于可迈高度：踩上去，不阻挡（台阶、矮台）。
        if (b.y1 <= pos.y + this.stepUp) continue;
        const cx = clamp(pos.x, b.x0, b.x1);
        const cz = clamp(pos.z, b.z0, b.z1);
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        moved = true;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          pos.x += (dx / d) * push;
          pos.z += (dz / d) * push;
        } else {
          // 圆心在盒子内部：沿最近的一面推出去
          const dl = pos.x - b.x0;
          const dr = b.x1 - pos.x;
          const db = pos.z - b.z0;
          const df = b.z1 - pos.z;
          const m = Math.min(dl, dr, db, df);
          if (m === dl) pos.x = b.x0 - radius;
          else if (m === dr) pos.x = b.x1 + radius;
          else if (m === db) pos.z = b.z0 - radius;
          else pos.z = b.z1 + radius;
        }
      }
      if (!moved) break;
    }
  }

  /** 该位置是否被墙体占据（用于放置 NPC、检查出生点）。 */
  occupied(x: number, y: number, z: number, radius = 0.4, height = 1.7): boolean {
    for (const b of this.boxes) {
      if (y + height <= b.y0 || y >= b.y1) continue;
      if (b.y1 <= y + this.stepUp) continue;
      const cx = clamp(x, b.x0, b.x1);
      const cz = clamp(z, b.z0, b.z1);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /** 射线与盒子求交（slab 法），返回最近的命中。 */
  ray(origin: Vec3Like, dir: Vec3Like, maxDist: number, opts: RayOpts = {}): Hit | null {
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len < 1e-9) return null;
    const dx = dir.x / len;
    const dy = dir.y / len;
    const dz = dir.z / len;

    let best: Hit | null = null;
    let bestT = maxDist;

    for (const b of this.boxes) {
      if (opts.sight && !b.sight) continue;
      if (opts.ignoreTag && b.tag.startsWith(opts.ignoreTag)) continue;

      let tmin = 0;
      let tmax = bestT;
      let ok = true;

      // X
      if (Math.abs(dx) < 1e-9) {
        if (origin.x < b.x0 || origin.x > b.x1) ok = false;
      } else {
        const inv = 1 / dx;
        let t1 = (b.x0 - origin.x) * inv;
        let t2 = (b.x1 - origin.x) * inv;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) ok = false;
      }

      // Y
      if (ok) {
        if (Math.abs(dy) < 1e-9) {
          if (origin.y < b.y0 || origin.y > b.y1) ok = false;
        } else {
          const inv = 1 / dy;
          let t1 = (b.y0 - origin.y) * inv;
          let t2 = (b.y1 - origin.y) * inv;
          if (t1 > t2) [t1, t2] = [t2, t1];
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) ok = false;
        }
      }

      // Z
      if (ok) {
        if (Math.abs(dz) < 1e-9) {
          if (origin.z < b.z0 || origin.z > b.z1) ok = false;
        } else {
          const inv = 1 / dz;
          let t1 = (b.z0 - origin.z) * inv;
          let t2 = (b.z1 - origin.z) * inv;
          if (t1 > t2) [t1, t2] = [t2, t1];
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) ok = false;
        }
      }

      if (!ok || tmin >= bestT) continue;
      bestT = tmin;
      best = {
        t: tmin,
        point: [origin.x + dx * tmin, origin.y + dy * tmin, origin.z + dz * tmin],
        box: b,
      };
    }

    return best;
  }

  /** 两点之间是否被墙挡住（AI 视线）。 */
  blocked(from: Vec3Like, to: Vec3Like, opts: RayOpts = { sight: true }): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return false;
    const hit = this.ray(from, { x: dx, y: dy, z: dz }, dist - 0.05, opts);
    return hit !== null;
  }

  /** 在给定矩形内找一个没被占用的点。找不到就返回中心。 */
  findFreeSpot(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    rnd: () => number,
    y = 8,
  ): { x: number; z: number } {
    for (let i = 0; i < 40; i++) {
      const x = x0 + rnd() * (x1 - x0);
      const z = z0 + rnd() * (z1 - z0);
      if (!this.occupied(x, y, z, 0.5, 1.8)) return { x, z };
    }
    return { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
  }
}
