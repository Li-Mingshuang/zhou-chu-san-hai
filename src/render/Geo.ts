import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  Group,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MatLib } from './Mats.js';

/**
 * 低多边形美术的几何工具。
 * 所有几何体统一为「非索引 + position/normal」两属性，顶点法线为面法线，
 * 这样既得到平坦着色的硬边，又能保证同材质几何可以无脑合并。
 */

function strip(g: BufferGeometry): BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute('uv');
  n.deleteAttribute('uv1');
  n.deleteAttribute('uv2');
  n.deleteAttribute('color');
  n.deleteAttribute('tangent');
  n.computeVertexNormals();
  return n;
}

const boxCache = new Map<string, BufferGeometry>();

export function boxGeo(w: number, h: number, d: number): BufferGeometry {
  const k = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  let g = boxCache.get(k);
  if (!g) {
    g = strip(new BoxGeometry(w, h, d));
    boxCache.set(k, g);
  }
  return g;
}

export function cylGeo(rTop: number, rBottom: number, h: number, seg = 6): BufferGeometry {
  return strip(new CylinderGeometry(rTop, rBottom, h, seg, 1, false));
}

export function planeGeo(w: number, h: number): BufferGeometry {
  return strip(new PlaneGeometry(w, h));
}

export function sphereGeo(r: number, seg = 8): BufferGeometry {
  return strip(new SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.6))));
}

/** 便捷矩阵：平移 + 绕 Y 旋转 + 缩放。 */
export function trs(
  x = 0,
  y = 0,
  z = 0,
  ry = 0,
  sx = 1,
  sy = 1,
  sz = 1,
  rx = 0,
  rz = 0,
): Matrix4 {
  const m = new Matrix4();
  const pos = new Vector3(x, y, z);
  const q = new Quaternion().setFromEuler(new Euler(rx, ry, rz, 'YXZ'));
  const s = new Vector3(sx, sy, sz);
  m.compose(pos, q, s);
  return m;
}

export interface BatchOpts {
  /** 预留：同材质上的顶点色微差。当前未启用。 */
  readonly?: boolean;
}

/**
 * 静态几何合批器：把成百上千个小块按材质合并成少量 Mesh，
 * 是本章能跑满 60fps 的关键。
 */
export class Batcher {
  private buckets = new Map<string, { geos: BufferGeometry[] }>();

  constructor(private readonly mats: MatLib) {}

  /** 以矩阵方式加入一块几何。矩阵会被消费（几何数据被复制进缓冲区）。 */
  add(geo: BufferGeometry, matKey: string, matrix: Matrix4): void {
    const cloned = geo.clone();
    cloned.applyMatrix4(matrix);
    let b = this.buckets.get(matKey);
    if (!b) {
      b = { geos: [] };
      this.buckets.set(matKey, b);
    }
    b.geos.push(cloned);
  }

  /** 轴对齐盒子，最常用的调用。 */
  box(
    w: number,
    h: number,
    d: number,
    matKey: string,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rx = 0,
    rz = 0,
  ): void {
    this.add(boxGeo(w, h, d), matKey, trs(x, y, z, ry, 1, 1, 1, rx, rz));
  }

  /** 竖直圆柱（柱子、香炉、灯杆）。 */
  cyl(
    rTop: number,
    rBottom: number,
    h: number,
    matKey: string,
    x: number,
    y: number,
    z: number,
    seg = 6,
  ): void {
    this.add(cylGeo(rTop, rBottom, h, seg), matKey, trs(x, y, z));
  }

  /** 一串台阶：沿 +Z 方向上行的楼梯。 */
  stairs(
    width: number,
    steps: number,
    rise: number,
    run: number,
    matKey: string,
    x: number,
    y: number,
    z: number,
    ry = 0,
  ): void {
    const rot = trs(x, y, z, ry);
    const tmp = new Matrix4();
    for (let i = 0; i < steps; i++) {
      const local = trs(0, i * rise + rise / 2, i * run + run / 2);
      tmp.multiplyMatrices(rot, local);
      this.add(boxGeo(width, rise, run), matKey, tmp.clone());
    }
  }

  get empty(): boolean {
    return this.buckets.size === 0;
  }

  /** 合并并生成一个 Group，每个材质一个 Mesh。 */
  build(name = 'batch'): Group {
    const group = new Group();
    group.name = name;
    for (const [matKey, bucket] of this.buckets) {
      if (bucket.geos.length === 0) continue;
      const merged =
        bucket.geos.length === 1 ? bucket.geos[0]! : mergeGeometries(bucket.geos, false);
      if (!merged) {
        console.warn(`[batcher] merge failed for ${matKey}`);
        continue;
      }
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, this.mats.get(matKey));
      mesh.name = `${name}:${matKey}`;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    this.buckets.clear();
    return group;
  }
}

/** 生成一圈散布点，用于植被/杂物。 */
export function ringPositions(
  count: number,
  radius: number,
  cx = 0,
  cz = 0,
  jitter = 0.4,
  rnd: () => number = Math.random,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.3;
    const r = radius * (1 - jitter * 0.5 + rnd() * jitter);
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/** 简单的地面网格线（DEBUG 用）。 */
export function gridLines(size: number, divisions: number, matKey: string, mats: MatLib): Group {
  const g = new Group();
  const step = size / divisions;
  const half = size / 2;
  const geos: BufferGeometry[] = [];
  for (let i = 0; i <= divisions; i++) {
    const p = -half + i * step;
    const a = boxGeo(size, 0.02, 0.03).clone();
    a.applyMatrix4(trs(0, 0, p));
    const b = boxGeo(0.03, 0.02, size).clone();
    b.applyMatrix4(trs(p, 0, 0));
    geos.push(a, b);
  }
  const merged = mergeGeometries(geos, false);
  if (merged) {
    const m = new Mesh(merged, mats.get(matKey));
    m.matrixAutoUpdate = false;
    g.add(m);
  }
  return g;
}
