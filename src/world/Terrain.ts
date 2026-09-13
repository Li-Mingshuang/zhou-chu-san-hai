import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshLambertMaterial, PlaneGeometry } from 'three';
import { clamp, fbm2, invLerp, lerp, smoothstep } from '../core/MathUtils.js';
import { P } from '../render/Palette.js';
import type { BuildCtx } from './ctx.js';
import {
  COMPOUND,
  PATH,
  PLATEAU_Y,
  SEA_Y,
  SHORE_Y,
  STAIRS,
  pathDistance,
  terrainHeight,
  terrainSlope,
} from './Layout.js';

/**
 * 地形。
 *
 * 整座岛是一张按 terrainHeight() 采样出来的非索引三角网，
 * 每个三角形一个顶点色——于是既得到低多边形的硬边，
 * 又能用一张几何体画出草地、岩壁、土路、沙滩与湿沙线，
 * 全程只有一次 draw call。
 */

const X0 = -112;
const X1 = 112;
const Z0 = -104;
const Z1 = 152;
const STEP = 3.5;

const cGrass = new Color(P.veg);
const cGrassDark = new Color(P.vegDark);
const cDry = new Color(P.vegDry);
const cSand = new Color(P.sand);
const cSandWet = new Color(P.sandWet);
const cRock = new Color(P.rock);
const cDirt = new Color(0x6d5b43);
const cPave = new Color(P.stone);
const cYard = new Color(0x8a7f68);
const tmpColor = new Color();

function groundColor(x: number, z: number, y: number, slope: number, out: Color): Color {
  const n = fbm2(x * 0.11, z * 0.11, 2);
  const m = fbm2(x * 0.031 + 40, z * 0.031 - 17, 2);
  out.copy(cGrass).lerp(cGrassDark, n * 0.85);
  out.lerp(cDry, clamp(m - 0.45, 0, 1) * 1.4);

  // 陡坡露岩
  const rockW = smoothstep(invLerp(0.55, 1.25, slope));
  if (rockW > 0) out.lerp(cRock, rockW * 0.95);

  // 舍区：夯土院子
  if (
    x > COMPOUND.x0 - 2 &&
    x < COMPOUND.x1 + 2 &&
    z > COMPOUND.z0 - 2 &&
    z < COMPOUND.z1 + 2 &&
    y > PLATEAU_Y - 0.8
  ) {
    out.lerp(cYard, 0.62);
  }

  // 石阶铺面
  if (x > STAIRS.x0 - 2.4 && x < STAIRS.x1 + 2.4 && z > STAIRS.zTop - 2.5 && z < STAIRS.zBottom + 2) {
    out.lerp(cPave, 0.8);
  }

  // 山径
  const pd = pathDistance(x, z);
  const half = PATH.width * 0.5;
  if (pd < half + 1.8) {
    out.lerp(cDirt, (1 - smoothstep(invLerp(half - 0.5, half + 1.8, pd))) * 0.92);
  }

  // 沙滩
  const sandW = 1 - smoothstep(invLerp(SHORE_Y + 0.25, SHORE_Y + 3.2, y));
  if (sandW > 0) out.lerp(cSand, sandW * 0.96);

  // 水线湿沙
  const wetW = 1 - smoothstep(invLerp(SEA_Y + 0.05, SEA_Y + 1.1, y));
  if (wetW > 0) out.lerp(cSandWet, wetW * 0.9);

  return out;
}

export function buildTerrain(ctx: BuildCtx): Group {
  const group = new Group();
  group.name = 'terrain';

  const nx = Math.floor((X1 - X0) / STEP);
  const nz = Math.floor((Z1 - Z0) / STEP);

  // 先把高度算进一张表，避免每个三角形重复采样。
  const heights = new Float32Array((nx + 1) * (nz + 1));
  const xs = new Float32Array(nx + 1);
  const zs = new Float32Array(nz + 1);
  for (let i = 0; i <= nx; i++) xs[i] = X0 + i * STEP;
  for (let j = 0; j <= nz; j++) zs[j] = Z0 + j * STEP;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      heights[j * (nx + 1) + i] = terrainHeight(xs[i]!, zs[j]!);
    }
  }

  const triCount = nx * nz * 2;
  const positions = new Float32Array(triCount * 9);
  const colors = new Float32Array(triCount * 9);
  let p = 0;
  let c = 0;

  const pushTri = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void => {
    positions[p++] = ax;
    positions[p++] = ay;
    positions[p++] = az;
    positions[p++] = bx;
    positions[p++] = by;
    positions[p++] = bz;
    positions[p++] = cx;
    positions[p++] = cy;
    positions[p++] = cz;

    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cy) / 3;
    const mz = (az + bz + cz) / 3;
    // 用三角形投影面积推算坡度，比采样两次地形便宜
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const nyv = e1z * e2x - e1x * e2z;
    const nh = Math.hypot(e1y * e2z - e1z * e2y, nyv, e1x * e2y - e1y * e2x);
    const slope = nh > 1e-6 ? Math.max(0, nyv) / nh : 1;
    groundColor(mx, mz, my, Math.min(3, (1 - slope) * 3 + terrainSlope(mx, mz, 4) * 0.5), tmpColor);
    for (let k = 0; k < 3; k++) {
      colors[c++] = tmpColor.r;
      colors[c++] = tmpColor.g;
      colors[c++] = tmpColor.b;
    }
  };

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      const z0 = zs[j]!;
      const z1 = zs[j + 1]!;
      const a = heights[j * (nx + 1) + i]!;
      const b = heights[j * (nx + 1) + i + 1]!;
      const d = heights[(j + 1) * (nx + 1) + i]!;
      const e = heights[(j + 1) * (nx + 1) + i + 1]!;
      pushTri(x0, a, z0, x1, b, z0, x1, e, z1);
      pushTri(x0, a, z0, x1, e, z1, x0, d, z1);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  ctx.track(mat);
  ctx.track(geo);
  const mesh = new Mesh(geo, mat);
  mesh.name = 'terrain:mesh';
  mesh.matrixAutoUpdate = false;
  mesh.receiveShadow = false;
  group.add(mesh);

  return group;
}

/**
 * 沿海岸线撒一圈浪花。用射线步进找出海平面与地形的交点，
 * 于是沙滩与礁石边的浪会自动贴合地形。
 */
export function buildSurf(ctx: BuildCtx): Group {
  const group = new Group();
  group.name = 'surf';

  const line: Array<[number, number, number]> = [];
  const centerX = 0;
  const centerZ = 26;
  const steps = 200;
  for (let i = 0; i < steps; i++) {
    const ang = (i / steps) * Math.PI * 2;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    let found: [number, number, number] | null = null;
    for (let r = 30; r < 130; r += 1.2) {
      const x = centerX + dx * r * 1.35;
      const z = centerZ + dz * r * 1.65;
      const y = terrainHeight(x, z);
      if (y <= SEA_Y) {
        found = [x, SEA_Y, z];
        break;
      }
    }
    if (found) line.push(found);
  }

  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    const b = line[(i + 1) % line.length]!;
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[2] + b[2]) / 2;
    const ang = Math.atan2(b[0] - a[0], b[2] - a[2]);
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (len > 12) continue;
    const w = 1.6 + ctx.rnd() * 2.2;
    ctx.b.box(w, 0.06, 0.9 + ctx.rnd() * 0.9, ctx.M.foam, mx, SEA_Y + 0.05, mz, ang + Math.PI / 2);
  }

  return group;
}

export function buildSea(ctx: BuildCtx): Group {
  const group = new Group();
  group.name = 'sea';

  const geo = new PlaneGeometry(900, 900, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, ctx.mats.get(ctx.M.sea));
  mesh.position.set(0, SEA_Y, 20);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  group.add(mesh);
  ctx.track(geo);

  // 深水带：离岸远一点再叠一层更暗的水，做出近岸浅、远处深的感觉。
  const deepGeo = new PlaneGeometry(900, 900, 1, 1);
  deepGeo.rotateX(-Math.PI / 2);
  const deep = new Mesh(deepGeo, ctx.mats.get(ctx.M.seaDeep));
  deep.position.set(0, SEA_Y - 0.06, 20);
  deep.scale.set(1, 1, 1);
  deep.matrixAutoUpdate = false;
  deep.updateMatrix();
  group.add(deep);
  ctx.track(deepGeo);

  return group;
}

/** 远处用于挡视线的一层雾山剪影。极便宜，但把地平线撑起来了。 */
export function buildBackdrop(ctx: BuildCtx): Group {
  const group = new Group();
  group.name = 'backdrop';
  const rnd = ctx.rnd;
  for (let i = 0; i < 26; i++) {
    const ang = (i / 26) * Math.PI * 2 + rnd() * 0.1;
    const dist = 190 + rnd() * 90;
    const x = Math.cos(ang) * dist;
    const z = 26 + Math.sin(ang) * dist * 1.25;
    const h = 26 + rnd() * 52;
    const w = 60 + rnd() * 90;
    ctx.b.box(w, h, w, ctx.M.hill, x, SEA_Y + h / 2 - 4, z, ang);
  }
  return group;
}

/** 供其它系统查询地表高度的小包装。 */
export { terrainHeight };

/** 未使用但保留：方便在调试时把整张高度图打出来。 */
export function sampleHeightRow(z: number, x0 = -40, x1 = 40, n = 16): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(terrainHeight(lerp(x0, x1, i / (n - 1)), z));
  return out;
}
