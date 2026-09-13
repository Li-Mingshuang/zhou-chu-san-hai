import { PointLight, type BufferGeometry } from 'three';
import { clamp, type Rng } from '../core/MathUtils.js';
import { boxGeo, cylGeo, sphereGeo, trs } from '../render/Geo.js';
import { P } from '../render/Palette.js';
import type { BuildCtx } from './ctx.js';
import {
  DOCK,
  PATH,
  SEA_Y,
  STAIRS,
  pathCenterX,
  pathDistance,
  terrainHeight,
} from './Layout.js';

/**
 * 自然景物与码头。
 *
 * 这里是岛上"没有墙"的那一半：椰林、灌木、岩石、礁石、草簇，以及木栈桥。
 * 三条规矩贯穿全文：
 *
 * 1) 静态几何一律进 ctx.b 合批。整座岛的自然景物最后只剩下十几个 draw call。
 * 2) 落点高度一律现算 terrainHeight(x, z)。地形是解析函数，
 *    将来挪动台地或海滩，草木会自动跟着长，不需要回来改一个数字。
 * 3) 随机一律走 ctx.rnd。?shot= 分镜截图必须逐帧可复现，Math.random 会毁掉这件事。
 */

// ── 小船的位置：buildNature 要避开它，buildDock 要放它 ──────
const BOAT = { x: 8.5, z: 101, halfW: 2.0, halfL: 3.4 };

/** 舍区里那两株大树（x, z）。会长在院子里，所以必须给碰撞。 */
const BIG_TREES: ReadonlyArray<readonly [number, number]> = [
  [-18, 16],
  [17, 21],
];

// ── 通用小工具 ───────────────────────────────────────────

/** 把数值吸附到网格上。见 tube() 的说明：不量化就命不中缓存。 */
function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

const cylCache = new Map<string, BufferGeometry>();
let ballGeo: BufferGeometry | null = null;

/**
 * 带缓存的圆柱。cylGeo() 内部每次都会 new 一个 CylinderGeometry，
 * 而树干、木桩加起来有近千段，所以这里按量化后的参数自己缓存一份。
 * 返回值只被 Batcher 复制，不会被就地修改，共享是安全的。
 */
function tube(rTop: number, rBottom: number, h: number, seg = 6): BufferGeometry {
  const key = `${rTop.toFixed(2)}|${rBottom.toFixed(2)}|${h.toFixed(2)}|${seg}`;
  let g = cylCache.get(key);
  if (!g) {
    g = cylGeo(rTop, rBottom, h, seg);
    cylCache.set(key, g);
  }
  return g;
}

/** 半径 1 的 5 段球。灌木、岩石全都用它缩放出来，只需要一个几何体。 */
function ball(): BufferGeometry {
  if (!ballGeo) ballGeo = sphereGeo(1, 5);
  return ballGeo;
}

/** 码头矩形（含余量）。桥上不长树。 */
function inDock(x: number, z: number, pad: number): boolean {
  return x > DOCK.x0 - pad && x < DOCK.x1 + pad && z > DOCK.z0 - pad && z < DOCK.z1 + pad;
}

/** 石阶走廊。台阶两侧的石头要留开，否则像被埋进石阶里。 */
function onStairs(x: number, z: number): boolean {
  return (
    x > STAIRS.x0 - 3 && x < STAIRS.x1 + 3 && z > STAIRS.zTop - 2.5 && z < STAIRS.zBottom + 2.5
  );
}

/** 小船占掉的沙滩。 */
function onBoat(x: number, z: number): boolean {
  return Math.abs(x - BOAT.x) < BOAT.halfW && Math.abs(z - BOAT.z) < BOAT.halfL;
}

/**
 * 统一的落点检查：能放就返回地面高度，不能放返回 null。
 * 水里、路面上、桥面上、石阶上、以及已经被建筑占掉的位置一律跳过。
 * 放在这里是为了让四类景物共用同一份判断，不会有哪一类漏检。
 */
function groundFor(ctx: BuildCtx, x: number, z: number, pathGap: number): number | null {
  const y = terrainHeight(x, z);
  if (y < SEA_Y + 0.4) return null; // 浪线以下：那是海，不是岸
  if (pathDistance(x, z) < PATH.width * 0.5 + pathGap) return null; // 别长在路上
  if (inDock(x, z, 1)) return null;
  if (onStairs(x, z)) return null;
  if (onBoat(x, z)) return null;
  if (ctx.level.occupied(x, y, z, 0.6, 2)) return null; // 落在建筑里就跳过
  return y;
}

// ── 树木 ─────────────────────────────────────────────────

interface TrunkOpts {
  /** 段数。 */
  segs: number;
  /** 单段高度范围（缩放前）。 */
  hMin: number;
  hMax: number;
  /** 最下一段的半径（缩放前）。 */
  r0: number;
  /** 最上一段半径 / r0。 */
  tipRatio: number;
  /** 整体缩放。 */
  scale: number;
}

/**
 * 分段树干。每段自己带一个 0.10~0.35 的横向偏移，
 * 累积起来就是椰子树那种弯。倾斜角由方向向量反解出来
 * （rx = atan2(dz, dy)、rz = -asin(dx)），并且用同一个方向向量
 * 推进下一段的基点——这样段与段首尾严丝合缝，不会露出阶梯状裂缝。
 *
 * 返回树顶坐标，树冠就长在那儿。
 */
function trunk(
  ctx: BuildCtx,
  x: number,
  y: number,
  z: number,
  o: TrunkOpts,
  rnd: Rng,
): [number, number, number] {
  let bx = x;
  let by = y;
  let bz = z;
  let rPrev = snap(o.r0 * o.scale, 0.02);

  for (let i = 0; i < o.segs; i++) {
    // 半径自下而上收缩：椰子树 0.30 → 0.18
    const rTop = snap(o.r0 * o.scale * (1 - (1 - o.tipRatio) * ((i + 1) / o.segs)), 0.02);
    const h = snap(rnd.range(o.hMin, o.hMax) * o.scale, 0.1);

    // 这一段往 +X 还是 +Z 歪
    const off = rnd.range(0.1, 0.35) * o.scale;
    const alongX = rnd() < 0.5;
    const ox = alongX ? off * rnd.sign() : 0;
    const oz = alongX ? 0 : off * rnd.sign();

    const inv = 1 / Math.hypot(ox, h, oz);
    const dx = ox * inv;
    const dy = h * inv;
    const dz = oz * inv;
    const rx = Math.atan2(dz, dy);
    const rz = -Math.asin(clamp(dx, -1, 1));

    ctx.b.add(
      tube(rTop, rPrev, h, 6),
      ctx.M.woodDark,
      trs(bx + dx * h * 0.5, by + dy * h * 0.5, bz + dz * h * 0.5, 0, 1, 1, 1, rx, rz),
    );

    bx += dx * h;
    by += dy * h;
    bz += dz * h;
    rPrev = rTop;
  }

  return [bx, by, bz];
}

/**
 * 树冠：一圈细长薄板，逐片往下垂。
 * 叶片几何沿自身 +X 伸出，所以 ry 定方位、rz = -droop 让叶尖垂下去，
 * 叶根正好落在树顶：中心偏移半个叶长即可。
 */
function crown(
  ctx: BuildCtx,
  tip: [number, number, number],
  leafCount: number,
  leafLen: number,
  s: number,
  rnd: Rng,
): void {
  const mats = [ctx.M.veg, ctx.M.vegDark, ctx.M.vegDry];
  for (let i = 0; i < leafCount; i++) {
    const a = (i / leafCount) * Math.PI * 2 + rnd.range(-0.22, 0.22);
    const droop = rnd.range(0.35, 0.7);
    const len = leafLen * s * rnd.range(0.85, 1.15);
    const ch = Math.cos(droop);
    const sh = Math.sin(droop);
    const dx = ch * Math.cos(a);
    const dy = -sh;
    const dz = -ch * Math.sin(a);

    ctx.b.add(
      boxGeo(2.4, 0.06, 0.42),
      mats[rnd.int(0, 2)]!,
      trs(
        tip[0] + dx * len * 0.5,
        tip[1] + dy * len * 0.5,
        tip[2] + dz * len * 0.5,
        a,
        len / 2.4,
        1,
        s * rnd.range(0.9, 1.3),
        0,
        -droop,
      ),
    );
  }
}

/** 一棵海边椰子树：3~4 段树干 + 7 片叶子，整体缩放 0.8~1.35。 */
function palm(ctx: BuildCtx, x: number, z: number, rnd: Rng): void {
  const y = terrainHeight(x, z);
  const s = rnd.range(0.8, 1.35);
  // 树根往下埋 0.2：斜坡上才不会露出圆柱的底面
  const tip = trunk(
    ctx,
    x,
    y - 0.2,
    z,
    { segs: rnd.int(3, 4), hMin: 1.6, hMax: 2.2, r0: 0.3, tipRatio: 0.6, scale: s },
    rnd,
  );
  crown(ctx, tip, 7, 2.4, s, rnd);
}

/** 舍区里的两株大树：更粗、更高、冠更大。这两株挡人，所以给碰撞。 */
function bigTree(ctx: BuildCtx, x: number, z: number): void {
  const y = terrainHeight(x, z);
  const tip = trunk(
    ctx,
    x,
    y - 0.3,
    z,
    { segs: 4, hMin: 1.6, hMax: 2.0, r0: 0.55, tipRatio: 0.6, scale: 1 },
    ctx.rnd,
  );
  crown(ctx, tip, 12, 3.6, 1, ctx.rnd);
  // 1.2×7×1.2 的方柱就是树干本体，玩家撞上去会被推开
  ctx.level.boxAt(x, y + 3.5, z, 1.2, 7, 1.2, 'tree');
}

// ── 灌木 / 岩石 / 草 ─────────────────────────────────────

/** 一丛灌木：2~4 个压扁的球往上叠，越上面越小，看起来像一丛而不是一堆。 */
function shrub(ctx: BuildCtx, x: number, y: number, z: number, rnd: Rng): void {
  const mats = [ctx.M.veg, ctx.M.vegDark, ctx.M.vegDry];
  const n = rnd.int(2, 4);
  const base = rnd.range(0.35, 0.9);
  for (let i = 0; i < n; i++) {
    const s = base * rnd.range(0.7, 1.1) * (1 - i * 0.12);
    ctx.b.add(
      ball(),
      mats[rnd.int(0, 2)]!,
      trs(
        x + rnd.range(-0.4, 0.4) * base,
        y + s * 0.35 + i * base * 0.42,
        z + rnd.range(-0.4, 0.4) * base,
        rnd.range(0, Math.PI),
        s,
        s * rnd.range(0.55, 0.8),
        s,
      ),
    );
  }
}

/**
 * 一块石头。一半埋进地里：中心只抬到 0.2s，
 * 露出来的部分比整块小，看着才像"长"在地上。
 */
function rock(
  ctx: BuildCtx,
  x: number,
  y: number,
  z: number,
  s: number,
  dark: boolean,
  rnd: Rng,
): void {
  const mat = dark ? ctx.M.stoneDark : ctx.M.rock;
  if (rnd() < 0.45) {
    // 柱状岩：像被劈开立在坡上的那一种
    ctx.b.add(
      tube(1, 1.3, 1, 5),
      mat,
      trs(
        x,
        y + s * 0.3,
        z,
        rnd.range(0, Math.PI),
        s,
        s * rnd.range(0.7, 1.5),
        s * 0.85,
        rnd.range(-0.25, 0.25),
        rnd.range(-0.25, 0.25),
      ),
    );
  } else {
    ctx.b.add(
      ball(),
      mat,
      trs(
        x,
        y + s * 0.2,
        z,
        rnd.range(0, Math.PI),
        s,
        s * rnd.range(0.45, 0.75),
        s * rnd.range(0.8, 1.2),
        rnd.range(-0.3, 0.3),
        rnd.range(-0.3, 0.3),
      ),
    );
  }
}

/** 一个草簇：一根斜着插进土里的细长盒子，便宜到可以撒几百个。 */
function grassTuft(ctx: BuildCtx, x: number, y: number, z: number, rnd: Rng): void {
  const s = rnd.range(0.7, 1.3);
  ctx.b.add(
    boxGeo(0.12, 0.5, 0.12),
    rnd() < 0.5 ? ctx.M.veg : ctx.M.vegDark,
    // 抬 0.2s：倾斜之后盒子的一半会转到地下，正好当草根
    trs(x, y + 0.2 * s, z, rnd.range(0, Math.PI), s, s, s, rnd.range(-0.45, 0.45), rnd.range(-0.45, 0.45)),
  );
}

// ── 主函数 ───────────────────────────────────────────────

export function buildNature(ctx: BuildCtx): void {
  const rnd = ctx.rnd;

  // ── 1. 椰林 / 海边树林：约 110 棵 ───────────────────────
  // z ∈ [48,132]、|x| ∈ [4,62] 正好压在沙滩带上；离中轴 4 米以内是山径，
  // 再往外 62 米开始沉进海里，groundFor 会把水里的点全部拒掉。
  let palms = 0;
  for (let attempt = 0; attempt < 4000 && palms < 110; attempt++) {
    const x = rnd.range(4, 62) * rnd.sign();
    const z = rnd.range(48, 132);
    if (groundFor(ctx, x, z, 1.4) === null) continue;
    palm(ctx, x, z, rnd);
    palms++;
  }

  // ── 2. 舍区两株大树 ────────────────────────────────────
  // 固定位置：这是给院子定调的两株，不能随机。
  for (const [tx, tz] of BIG_TREES) {
    if (groundFor(ctx, tx, tz, 0.5) === null) continue; // 正好盖在建筑里就放弃
    bigTree(ctx, tx, tz);
  }

  // ── 3. 灌木与杂草：约 300 团 ───────────────────────────
  // 密度随离路距离增加：先随便取点，再按距离做一次拒绝采样。
  // 于是路边干干净净、离开山径十几米之后层层叠叠。
  let shrubs = 0;
  for (let attempt = 0; attempt < 3000 && shrubs < 300; attempt++) {
    const x = rnd.range(-70, 70);
    const z = rnd.range(40, 140);
    const y = groundFor(ctx, x, z, 0.6);
    if (y === null) continue;
    const d = pathDistance(x, z);
    const w = d > 40 ? 1 : clamp(d / 12, 0.12, 1);
    if (rnd() > w) continue;
    shrub(ctx, x, y, z, rnd);
    shrubs++;
  }

  // ── 4. 岩石：约 90 块 ──────────────────────────────────
  // 从台地边坡一直撒到沙滩，压扁 + 随机旋转，避免看出是同一个球。
  let rocks = 0;
  for (let attempt = 0; attempt < 3000 && rocks < 90; attempt++) {
    const x = rnd.range(-72, 72);
    const z = rnd.range(30, 140);
    const y = groundFor(ctx, x, z, 0.5);
    if (y === null) continue;
    rock(ctx, x, y, z, rnd.range(0.35, 1.5), rnd() < 0.4, rnd);
    rocks++;
  }

  // ── 5. 海边礁石群：约 40 块，半浸在水里 ────────────────
  // 这一带的地形被整平成了沙滩，海面还在十几米以外，
  // 所以不能盲目撒点——先扫一遍网格，把真正贴着水线的格子挑出来，
  // 再从里面随机取。否则一半礁石会整块埋进干沙里，白花面数还看不见。
  const wet: Array<[number, number]> = [];
  for (let sx = 10; sx <= 55; sx += 1.6) {
    for (let sz = 104; sz <= 140; sz += 1.3) {
      if (terrainHeight(sx, sz) < SEA_Y + 0.7) wet.push([sx, sz]);
    }
  }
  for (let i = 0; i < 40 && wet.length > 0; i++) {
    const cell = wet.splice(rnd.int(0, wet.length - 1), 1)[0]!;
    const x = cell[0] + rnd.range(-0.7, 0.7);
    const z = cell[1] + rnd.range(-0.6, 0.6);
    // 石头中心压到 SEA_Y + 0.2：上半露在水面外，下半泡着
    rock(ctx, x, SEA_Y + 0.2, z, rnd.range(0.5, 1.7), true, rnd);
  }

  // ── 6. 山径两侧的草簇：约 160 个 ───────────────────────
  // 贴边撒，越靠近路越密；路面本身留空，免得踩在草上。
  let tufts = 0;
  const gap0 = PATH.width * 0.5;
  for (let attempt = 0; attempt < 2500 && tufts < 160; attempt++) {
    const z = rnd.range(PATH.z0 - 3, PATH.z1 + 2);
    const d = rnd.range(gap0 + 0.3, gap0 + 5);
    if (rnd() > 1 - (d - gap0) / 6) continue; // 越远越容易被拒
    const x = pathCenterX(z) + rnd.sign() * d;
    const y = groundFor(ctx, x, z, 0.2);
    if (y === null) continue;
    grassTuft(ctx, x, y, z, rnd);
    tufts++;
  }
}

export function buildDock(ctx: BuildCtx): void {
  const w = DOCK.x1 - DOCK.x0; // 6.4
  const topY = DOCK.y;
  const zMid = (DOCK.z0 + DOCK.z1) / 2;
  const zLen = DOCK.z1 - DOCK.z0;
  // 桥面底下的沙滩高度：台阶要从这里起步
  const groundY = terrainHeight(0, DOCK.z0 + 2);

  // ── 桥面木板 ───────────────────────────────────────────
  // 板厚 0.22、板深 0.42、缝 0.08 —— 正好 0.5 一块，
  // 于是板顶严丝合缝地贴在 DOCK.y 上，玩家脚下是平的。
  const pitch = 0.5;
  const planks = Math.floor(zLen / pitch);
  for (let i = 0; i < planks; i++) {
    const z = DOCK.z0 + i * pitch + pitch * 0.5;
    ctx.b.box(w, 0.22, 0.42, i % 2 === 0 ? ctx.M.woodWorn : ctx.M.wood, 0, topY - 0.11, z);
  }

  // ── 纵梁：两根，顶面正好托住板底 ───────────────────────
  for (const bx of [-2.4, 2.4]) {
    ctx.b.box(0.34, 0.3, zLen, ctx.M.woodDark, bx, topY - 0.22 - 0.15, zMid);
  }

  // ── 木桩：每 3 米一对 ──────────────────────────────────
  // 桩顶接在纵梁下方（DOCK.y - 0.3），整根 4.2 米插下去，
  // 桩脚落在 SEA_Y - 2 以下——沙滩上只看得见露出沙面的那一截。
  const pileH = 4.2;
  for (let z = DOCK.z0 + 1.5; z <= DOCK.z1 - 1.4; z += 3) {
    for (const px of [-2.6, 2.6]) {
      ctx.b.add(tube(0.24, 0.26, pileH, 6), ctx.M.woodDark, trs(px, topY - 0.3 - pileH * 0.5, z));
    }
  }

  // ── 碰撞 ───────────────────────────────────────────────
  ctx.level.addFlat({
    x0: DOCK.x0,
    x1: DOCK.x1,
    z0: DOCK.z0,
    z1: DOCK.z1,
    y: DOCK.y,
    tag: 'dock',
  });

  // 桥面离沙滩 0.85 米。没有这块看不见的实体，玩家会从侧面直接走进桥板底下
  // 把头探出桥面。它的顶面正好等于 DOCK.y，所以站在桥上的人完全不受影响。
  ctx.level.boxAt(0, (groundY + topY) / 2, zMid, w, topY - groundY, zLen, 'dockBase', {
    sight: false,
  });

  // ── 上桥台阶 ───────────────────────────────────────────
  // 沙滩 0.1、桥面 0.95，差 0.85：三级各抬 0.30，一步一级刚好迈得上去
  // （Level.stepUp = 0.34）。最上一级 1.00 略高于桥面，当作门槛。
  // 三级都登记 flat（能踩）与 box（侧面挡人）。
  const stepRise = 0.3;
  const stepRun = 0.5;
  const stepBase = groundY - 0.3; // 台阶底往下埋一点，免得露出悬空的底面
  for (let i = 0; i < 3; i++) {
    const zc = DOCK.z0 - stepRun * (2 - i) - stepRun * 0.5;
    const top = groundY + stepRise * (i + 1);
    const h = top - stepBase;
    const cy = stepBase + h * 0.5;
    ctx.b.box(w, h, stepRun, i % 2 === 0 ? ctx.M.wood : ctx.M.woodWorn, 0, cy, zc);
    ctx.level.addFlat({
      x0: DOCK.x0,
      x1: DOCK.x1,
      z0: zc - stepRun * 0.5,
      z1: zc + stepRun * 0.5,
      y: top,
      tag: 'dockStep',
    });
    ctx.level.boxAt(0, cy, zc, w, h, stepRun, 'dockStep');
  }

  // ── 两侧矮栏杆 ─────────────────────────────────────────
  // 立柱放 ±3.1、中间留出 6 米通道。栏杆只做视觉、不给碰撞：
  // 一旦加碰撞，贴着边走的人会被推下桥面，反而更难受。
  const railZ0 = DOCK.z0 + 1.5;
  const railLen = DOCK.z1 - railZ0;
  for (const sx of [-3.1, 3.1]) {
    for (let z = railZ0; z <= DOCK.z1; z += 2.5) {
      ctx.b.box(0.12, 0.9, 0.12, ctx.M.woodWorn, sx, topY + 0.45, z);
    }
    ctx.b.box(0.12, 0.12, railLen, ctx.M.wood, sx, topY + 0.86, (railZ0 + DOCK.z1) / 2);
  }

  // ── 码头尽头的系缆桩与灯 ───────────────────────────────
  const zEnd = DOCK.z1 - 1.2;
  // 系缆桩靠东侧：短柱 + 蘑菇头
  ctx.b.add(tube(0.16, 0.2, 0.85, 6), ctx.M.woodDark, trs(2.6, topY + 0.42, zEnd));
  ctx.b.add(tube(0.24, 0.24, 0.12, 6), ctx.M.woodWorn, trs(2.6, topY + 0.92, zEnd));

  // 灯在西侧：木杆 + 灯罩 + 顶盖
  const lx = -2.6;
  const lz = zEnd;
  const lh = 3.2;
  ctx.b.add(tube(0.09, 0.12, lh, 6), ctx.M.woodDark, trs(lx, topY + lh * 0.5, lz));
  ctx.b.box(0.36, 0.09, 0.36, ctx.M.woodDark, lx, topY + lh + 0.04, lz);
  ctx.b.box(0.3, 0.32, 0.3, ctx.M.lanternDim, lx, topY + lh - 0.15, lz);

  // 全章唯一一个我们自己加的点光源。distance 14 刚好照到桥尾，
  // 再大就要给整座桥的 shader 加负担了。
  const lamp = new PointLight(P.lantern, 1.2, 14, 2);
  lamp.name = 'dockLamp';
  lamp.position.set(lx, topY + lh - 0.15, lz);
  ctx.dynamic.add(lamp); // 挂进场景图，免得调用方忘了它
  ctx.light(lamp);
  // 海风里的灯从来不是恒亮的：缓慢地 ±8% 晃。
  ctx.animate((_dt, elapsed) => {
    lamp.intensity = 1.2 * (1 + 0.05 * Math.sin(elapsed * 1.7) + 0.03 * Math.sin(elapsed * 5.3));
  });

  // ── 岸边的小船 ─────────────────────────────────────────
  // 停在沙滩上、船头朝海（+Z 就是朝海）。船身是低模梯形：
  // 窄船底 + 两侧外倾的船帮 + 船头一块往上斜的板。
  const bx = BOAT.x;
  const bz = BOAT.z;
  const by = terrainHeight(bx, bz);
  const flare = 0.26; // 船帮外倾角
  ctx.b.box(1.5, 0.2, 4.6, ctx.M.woodWorn, bx, by + 0.16, bz); // 船底
  for (const s of [-1, 1]) {
    // 绕 Z 转 ±flare：上沿往外张，就是船帮外倾的样子
    ctx.b.box(0.14, 0.78, 4.6, ctx.M.woodDark, bx + s * 0.72, by + 0.5, bz, 0, 0, -s * flare);
    ctx.b.box(0.12, 0.12, 4.6, ctx.M.lacquer, bx + s * 0.83, by + 0.88, bz, 0, 0, -s * flare); // 舷边漆线
    ctx.b.box(1.3, 0.09, 0.5, ctx.M.woodWorn, bx, by + 0.6, bz + s * 1.05); // 座板
  }
  // 船头：绕 X 转 0.42，板面朝前上方翘
  ctx.b.box(1.5, 0.8, 0.16, ctx.M.woodDark, bx, by + 0.6, bz + 2.14, 0, 0.42);
  // 船尾横板
  ctx.b.box(1.6, 0.72, 0.14, ctx.M.woodDark, bx, by + 0.48, bz - 2.3);
  // 桅杆与横杆
  ctx.b.add(tube(0.09, 0.12, 4, 6), ctx.M.woodDark, trs(bx, by + 2.4, bz + 0.3));
  ctx.b.box(1.9, 0.1, 0.1, ctx.M.woodWorn, bx, by + 3.9, bz + 0.3, 0, 0, 0.05);

  // 玩家上岸后往北一定会路过它，所以整条船给一块方盒碰撞，
  // 宁可撞在空气里，也不要让玩家从船身中间穿过去。
  ctx.level.boxAt(bx, by + 0.6, bz, 2.6, 1.2, 5, 'boat');
}
