import { clamp, fbm2, invLerp, lerp, smoothstep } from '../core/MathUtils.js';

/**
 * 小岛与道场的全部尺寸。所有世界构建器都只从这里取坐标，
 * 改一个数字就能整体挪动，不必去翻几何体代码。
 *
 * 坐标约定：+X 向东，+Z 向南（朝海），+Y 向上。
 * 玩家从南边的海上上岸，一路往北走，最后在礼堂里做出选择。
 */

export const PLATEAU_Y = 8;
export const SHORE_Y = 0.1;
export const SEA_Y = -0.85;

/** 礼厅。整章的重心。 */
export const HALL = {
  x0: -12,
  x1: 12,
  z0: -18,
  z1: 8,
  floor: PLATEAU_Y,
  wall: 6.4,
  wallT: 0.45,
  /** 正门（南墙）开口。 */
  doorX0: -1.8,
  doorX1: 1.8,
  /** 后门（北墙）开口，通往密室。 */
  backX0: 8.4,
  backX1: 11.2,
  /** 讲台。 */
  stageX0: -6,
  stageX1: 6,
  stageZ0: -18,
  stageZ1: -13,
  stageH: 0.5,
  /** 中轴过道。 */
  aisleX0: -1.7,
  aisleX1: 1.7,
  /** 长凳：第一排与最后一排的 z。 */
  benchZ0: -10.6,
  benchZ1: 3.8,
  benchRows: 9,
  benchH: 0.46,
} as const;

export const CORRIDOR = {
  x0: 8.4,
  x1: 11.2,
  z0: -26,
  z1: -18,
  floor: PLATEAU_Y,
  wall: 3.2,
} as const;

export const VAULT = {
  x0: -9,
  x1: 12,
  z0: -42,
  z1: -26,
  floor: PLATEAU_Y,
  wall: 4.2,
  doorX0: 8.4,
  doorX1: 11.2,
} as const;

export const YARD = {
  x0: -24,
  x1: 24,
  z0: 10,
  z1: 26,
  floor: PLATEAU_Y,
  wall: 2.3,
  gateX0: -2.4,
  gateX1: 2.4,
} as const;

export const STAIRS = {
  x0: -3.4,
  x1: 3.4,
  zTop: 26,
  zBottom: 46,
  top: PLATEAU_Y,
  bottom: SHORE_Y,
} as const;

/** 山径中心线：一条缓慢摆动的土路，从石阶底一直走到码头。 */
export const PATH = {
  z0: 46,
  z1: 98,
  width: 2.4,
  amplitude: 5.5,
  frequency: 0.075,
} as const;

export const DOCK = {
  x0: -3.2,
  x1: 3.2,
  z0: 98,
  z1: 118,
  y: 0.95,
} as const;

/** 舍区围墙范围（挡住宿客，也挡住玩家掉下山坡）。 */
export const COMPOUND = { x0: -30, x1: 30, z0: -50, z1: 28 } as const;

export function pathCenterX(z: number): number {
  return Math.sin((z - PATH.z0) * PATH.frequency) * PATH.amplitude;
}

/** 点到山径中心线的近似水平距离。 */
export function pathDistance(x: number, z: number): number {
  if (z < PATH.z0 - 4 || z > PATH.z1 + 8) return 999;
  return Math.abs(x - pathCenterX(z));
}

export function onPath(x: number, z: number, extra = 0): boolean {
  return pathDistance(x, z) < PATH.width * 0.5 + extra;
}

// ── 地形 ─────────────────────────────────────────────────

interface FlatRegion {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
  /** 混合边界宽度，越大过渡越柔。 */
  m: number;
}

interface RampRegion extends FlatRegion {
  y1: number;
  axis: 'z' | 'x';
}

/** 被整平成平地的区域：舍区台地与海滩。 */
const FLATS: FlatRegion[] = [
  { x0: COMPOUND.x0, x1: COMPOUND.x1, z0: COMPOUND.z0, z1: COMPOUND.z1, y: PLATEAU_Y, m: 7 },
  { x0: -72, x1: 72, z0: 50, z1: 124, y: SHORE_Y, m: 9 },
];

/** 被整平成斜坡的区域：石阶走廊。 */
const RAMPS: RampRegion[] = [
  {
    x0: STAIRS.x0 - 1.6,
    x1: STAIRS.x1 + 1.6,
    z0: STAIRS.zTop,
    z1: STAIRS.zBottom,
    y: STAIRS.top,
    y1: STAIRS.bottom,
    axis: 'z',
    m: 6,
  },
];

/** 区域权重：矩形内部为 1，向外在 m 米内平滑衰减到 0。 */
function regionWeight(x: number, z: number, r: FlatRegion): number {
  const dx = Math.max(r.x0 - x, x - r.x1, 0);
  const dz = Math.max(r.z0 - z, z - r.z1, 0);
  const d = Math.max(dx, dz);
  if (d >= r.m) return 0;
  if (d <= 0) return 1;
  return smoothstep(1 - d / r.m);
}

/** 未经整平的原始山体：南边沉入海里，北边抬成后山崖壁。 */
function baseHeight(x: number, z: number): number {
  const t = smoothstep(invLerp(50, 28, z));
  let y = t * PLATEAU_Y;

  // 岛的外形：椭圆之外沉入海面以下，避免看到地形网格的边缘。
  const radius = Math.hypot(x * 0.72, (z - 26) * 0.5);
  const sink = smoothstep(invLerp(52, 76, radius));
  y = lerp(y, SEA_Y - 4, sink);

  // 北面的后山
  if (z < -46) y += (-46 - z) * 0.42 * (1 - sink);

  // 地表起伏（被台地与海滩整平后自然消失）
  const rough = (fbm2(x * 0.055, z * 0.055, 3) - 0.5) * 2.8;
  y += rough * (0.22 + 0.78 * t) * (1 - sink);

  return y;
}

/** 世界地表高度。地形网格、碰撞与放置物都用它，保证三者永远一致。 */
export function terrainHeight(x: number, z: number): number {
  let y = baseHeight(x, z);
  for (const f of FLATS) {
    const w = regionWeight(x, z, f);
    if (w > 0) y = lerp(y, f.y, w);
  }
  for (const r of RAMPS) {
    const w = regionWeight(x, z, r);
    if (w > 0) {
      const t = clamp(
        r.axis === 'z'
          ? (z - r.z0) / Math.max(1e-6, r.z1 - r.z0)
          : (x - r.x0) / Math.max(1e-6, r.x1 - r.x0),
        0,
        1,
      );
      y = lerp(y, lerp(r.y, r.y1, t), w);
    }
  }
  return y;
}

/** 地表法线的近似值（用于坡度、植被倾斜）。 */
export function terrainSlope(x: number, z: number, eps = 1.5): number {
  const dx = terrainHeight(x + eps, z) - terrainHeight(x - eps, z);
  const dz = terrainHeight(x, z + eps) - terrainHeight(x, z - eps);
  return Math.hypot(dx, dz) / (2 * eps);
}

// ── 场景锚点（节拍脚本与分镜模式共用） ────────────────────

export interface Anchor {
  x: number;
  y: number;
  z: number;
  /** 朝向（弧度，0 = -Z 朝北）。 */
  yaw: number;
}

export const ANCHORS: Record<string, Anchor> = {
  /** 上岸处。 */
  shoreArrive: { x: 1.2, y: SHORE_Y, z: 90, yaw: 0 },
  /** 石阶之下。 */
  stairsFoot: { x: 0, y: SHORE_Y, z: 48, yaw: 0 },
  /** 前院门口。 */
  yardGate: { x: 0, y: PLATEAU_Y, z: 24, yaw: 0 },
  /** 礼厅正门外。 */
  hallPorch: { x: 0, y: PLATEAU_Y, z: 10.5, yaw: 0 },
  /** 中轴过道靠后处（他坐下的位置）。 */
  hallLastRow: { x: 0, y: PLATEAU_Y, z: 4.6, yaw: 0 },
  /** 过道中段。 */
  hallAisleMid: { x: 0, y: PLATEAU_Y, z: -2.4, yaw: 0 },
  /** 讲台之前。 */
  hallStageFront: { x: 0, y: PLATEAU_Y + HALL.stageH, z: -11.4, yaw: 0 },
  /** 北墙后门前。 */
  hallBackDoor: { x: 9.8, y: PLATEAU_Y, z: -16.8, yaw: Math.PI },
  /** 走廊。 */
  corridor: { x: 9.8, y: PLATEAU_Y, z: -22, yaw: Math.PI },
  /** 密室内。 */
  vaultInside: { x: 9.8, y: PLATEAU_Y, z: -28, yaw: Math.PI },
  vaultDeep: { x: -6, y: PLATEAU_Y, z: -38, yaw: 0 },
  /** 码头上。 */
  dockEnd: { x: 0, y: DOCK.y, z: 110, yaw: Math.PI },
};

export function anchor(id: keyof typeof ANCHORS | string): Anchor {
  const a = ANCHORS[id];
  if (!a) {
    console.warn(`[layout] unknown anchor "${id}"`);
    return { x: 0, y: PLATEAU_Y, z: 0, yaw: 0 };
  }
  return a;
}
