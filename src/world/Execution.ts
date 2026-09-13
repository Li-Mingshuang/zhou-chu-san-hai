import { DoubleSide, Mesh, MeshLambertMaterial, PointLight } from 'three';
import type { BuildCtx } from './ctx.js';
import { planeGeo } from '../render/Geo.js';
import { makeTextTexture } from '../render/TextTex.js';

/**
 * 刑场。
 *
 * 电影里这一段发生在岛以外的地方，所以这是一块**孤立的场地**：
 * 放在离小岛两百多米的海面上，靠雾把周围的一切吃掉，
 * 于是"硬切 + 字幕「三个月后」"在空间上也是成立的——
 * 玩家确实被带到了另一个地方，而不是走到隔壁房间。
 *
 * 尺度是照着那种地方的真实样子来的：不大，很干净，水泥，一圈铁丝网，
 * 尽头一道挡弹的土坡。越普通越可怕。
 */

export const EXEC = {
  /** 场地中心。 */
  x: 240,
  z: 60,
  /** 水泥地范围。 */
  halfW: 13,
  halfD: 17,
  floor: 0,
  /** 挡弹土坡所在的一侧（-Z 方向）。 */
  wallZ: 60 - 16.5,
  /** 行刑柱。 */
  postX: 240,
  postZ: 60 - 9,
} as const;

export interface ExecutionHandles {
  /** 需要每帧闪烁的探照灯。 */
  lights: PointLight[];
}

export function buildExecutionGround(ctx: BuildCtx): ExecutionHandles {
  const { b, M, level } = ctx;
  const handles: ExecutionHandles = { lights: [] };
  const cx = EXEC.x;
  const cz = EXEC.z;

  // ── 地面与挡弹土坡 ───────────────────────────────────
  b.box(EXEC.halfW * 2, 0.5, EXEC.halfD * 2, M.concreteWet, cx, EXEC.floor - 0.25, cz);
  level.addFlat({
    x0: cx - EXEC.halfW,
    x1: cx + EXEC.halfW,
    z0: cz - EXEC.halfD,
    z1: cz + EXEC.halfD,
    y: EXEC.floor,
    tag: 'exec-floor',
  });

  // 挡弹土坡：一层夯土 + 顶上压着的沙袋
  b.box(EXEC.halfW * 2, 2.6, 2.2, M.sandWet, cx, 1.3, EXEC.wallZ);
  level.boxAt(cx, 1.3, EXEC.wallZ, EXEC.halfW * 2, 2.6, 2.2, 'exec-berm');
  for (let i = 0; i < 22; i++) {
    const x = cx - EXEC.halfW + 0.8 + (i % 11) * 2.4;
    const y = 2.7 + Math.floor(i / 11) * 0.36;
    b.box(0.62, 0.34, 0.4, M.sand, x, y, EXEC.wallZ + 0.5, ctx.rnd.range(-0.12, 0.12));
  }

  // ── 行刑柱 ───────────────────────────────────────────
  b.cyl(0.16, 0.19, 2.4, M.woodDark, EXEC.postX, 1.2, EXEC.postZ, 6);
  b.box(0.5, 0.16, 0.5, M.concreteDark, EXEC.postX, 0.08, EXEC.postZ);
  level.boxAt(EXEC.postX, 1.2, EXEC.postZ, 0.42, 2.4, 0.42, 'post');

  // 柱子后面的沙袋墙（很多人以为这是"刑场"的样子，其实防的是流弹）
  for (let i = 0; i < 7; i++) {
    b.box(0.62, 0.34, 0.4, M.sand, EXEC.postX - 2.2 + i * 0.72, 0.17 + (i % 2) * 0.34, EXEC.postZ - 0.7, ctx.rnd.range(-0.1, 0.1));
  }

  // ── 一圈铁丝网 ───────────────────────────────────────
  const posts: Array<[number, number]> = [];
  for (let i = 0; i <= 10; i++) {
    posts.push([cx - EXEC.halfW + i * ((EXEC.halfW * 2) / 10), cz - EXEC.halfD]);
    posts.push([cx - EXEC.halfW + i * ((EXEC.halfW * 2) / 10), cz + EXEC.halfD]);
  }
  for (let i = 0; i <= 12; i++) {
    posts.push([cx - EXEC.halfW, cz - EXEC.halfD + i * ((EXEC.halfD * 2) / 12)]);
    posts.push([cx + EXEC.halfW, cz - EXEC.halfD + i * ((EXEC.halfD * 2) / 12)]);
  }
  for (const [px, pz] of posts) {
    b.cyl(0.07, 0.08, 3.0, M.steelDark, px, 1.5, pz, 5);
  }
  // 横向的铁丝：用极细的长条暗示，低多边形下够用
  for (const y of [0.9, 1.7, 2.5, 2.9]) {
    b.box(EXEC.halfW * 2, 0.035, 0.035, M.steel, cx, y, cz - EXEC.halfD);
    b.box(EXEC.halfW * 2, 0.035, 0.035, M.steel, cx, y, cz + EXEC.halfD);
    b.box(0.035, 0.035, EXEC.halfD * 2, M.steel, cx - EXEC.halfW, y, cz);
    b.box(0.035, 0.035, EXEC.halfD * 2, M.steel, cx + EXEC.halfW, y, cz);
  }
  // 铁丝网用一排矮墙挡住（不让玩家走出去）
  level.boxAt(cx, 1.5, cz - EXEC.halfD, EXEC.halfW * 2, 3, 0.3, 'fence', { sight: false });
  level.boxAt(cx, 1.5, cz + EXEC.halfD, EXEC.halfW * 2, 3, 0.3, 'fence', { sight: false });
  level.boxAt(cx - EXEC.halfW, 1.5, cz, 0.3, 3, EXEC.halfD * 2, 'fence', { sight: false });
  level.boxAt(cx + EXEC.halfW, 1.5, cz, 0.3, 3, EXEC.halfD * 2, 'fence', { sight: false });

  // ── 探照灯与水泥台 ───────────────────────────────────
  const lampSpots: Array<[number, number]> = [
    [cx - 9, cz - 14],
    [cx + 9, cz - 14],
    [cx - 9, cz + 12],
    [cx + 9, cz + 12],
  ];
  for (const [lx, lz] of lampSpots) {
    b.cyl(0.09, 0.11, 5.4, M.steelDark, lx, 2.7, lz, 6);
    b.box(0.7, 0.24, 0.5, M.steelDark, lx, 5.5, lz);
    b.box(0.6, 0.16, 0.1, M.muzzle, lx, 5.5, lz - 0.3);
    const light = new PointLight(0xfff0d0, 2.2, 26, 2);
    light.position.set(lx, 5.4, lz - 0.4);
    ctx.light(light);
    handles.lights.push(light);
  }

  // 记录席：一张长桌，两把椅子。没人坐的时候更冷。
  b.box(3.2, 0.08, 0.9, M.woodWorn, cx - 7, 0.78, cz + 8);
  b.box(0.1, 0.74, 0.1, M.steelDark, cx - 8.3, 0.37, cz + 8);
  b.box(0.1, 0.74, 0.1, M.steelDark, cx - 5.7, 0.37, cz + 8);
  level.boxAt(cx - 7, 0.4, cz + 8, 3.2, 0.8, 0.9, 'exec-desk');
  for (const dx of [-8.6, -5.4]) {
    b.box(0.5, 0.06, 0.5, M.woodDark, cx + dx, 0.46, cz + 9.2);
    b.box(0.5, 0.5, 0.08, M.woodDark, cx + dx, 0.72, cz + 9.44);
  }

  // ── 墙上的告示 ───────────────────────────────────────
  const tex = ctx.track(
    makeTextTexture('肅靜', {
      vertical: true,
      fontSize: 96,
      color: '#d9d2c0',
      stain: 0.5,
      erosion: 0.3,
      seed: 991,
    }),
  );
  const mat = ctx.track(
    new MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.06, side: DoubleSide, depthWrite: false }),
  );
  const geo = ctx.track(planeGeo(0.62, 1.5));
  const sign = new Mesh(geo, mat);
  sign.position.set(cx + 4.5, 2.0, cz - EXEC.halfD + 0.6);
  ctx.dynamic.add(sign);

  // 地面上的白色标线：他站的位置
  b.box(2.4, 0.02, 0.08, M.paper, EXEC.postX, 0.012, EXEC.postZ + 0.9);

  // ── 海面之外的一条地平线 ─────────────────────────────
  // 远处的一排矮墙，让画面底下不至于什么都没有
  b.box(90, 1.2, 1.0, M.concreteDark, cx, 0.6, cz + 46);

  return handles;
}
