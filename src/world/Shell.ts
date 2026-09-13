import type { BuildCtx } from './ctx.js';
import { CORRIDOR, HALL, PLATEAU_Y, STAIRS, VAULT, YARD } from './Layout.js';

/**
 * 「新心灵舍」的建筑壳体：礼厅、连接走廊、后山密室、前院围墙与石阶。
 *
 * 这个文件只管「壳」——台基、墙、屋顶、柱、讲台、院墙、台阶。
 * 家具、灯笼、匾额、NPC 是别的模块的活，这里一概不碰，也不加任何点光源。
 *
 * 两条铁律：
 *  1. 一切尺寸都从 Layout.ts 读。本文件里出现的数字要么直接来自 Layout，
 *     要么是由它推出来的（墙厚的一半、压顶的厚度之类），不另立一套坐标。
 *  2. 玩家可能撞上的东西，画几何体的同一次调用里就把尺寸完全相同的碰撞盒
 *     登记好——统一走 solid()，于是视觉与碰撞不可能脱节。
 */

/** 地板面相对 PLATEAU_Y 微微抬起的量：舍区内地形正好是 8，共面会闪面。 */
const LIFT = 0.04;

// ── 通用助手 ──────────────────────────────────────────────

/**
 * 画一个轴对齐盒子，并登记尺寸完全一样的碰撞盒。
 * 这是本文件唯一允许的建墙方式——不这么写就会出现「看得见却穿得过」的墙。
 */
function solid(
  ctx: BuildCtx,
  mat: string,
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
  tag: string,
): void {
  ctx.b.box(w, h, d, mat, cx, cy, cz);
  ctx.level.boxAt(cx, cy, cz, w, h, d, tag);
}

/**
 * 绕 Y 轴转过的一个实体（半开的铁门就用它）。
 * 旋转过的薄板没法用等尺寸的轴对齐盒表示，只能取它旋转后的包围盒——
 * 会稍微多挡一点四个角，所以只用在本来就贴着墙、不挡路的东西上。
 */
function solidRotY(
  ctx: BuildCtx,
  mat: string,
  w: number,
  h: number,
  d: number,
  cx: number,
  cy: number,
  cz: number,
  ry: number,
  tag: string,
): void {
  ctx.b.box(w, h, d, mat, cx, cy, cz, ry);
  const hx = Math.abs((w / 2) * Math.cos(ry)) + Math.abs((d / 2) * Math.sin(ry));
  const hz = Math.abs((w / 2) * Math.sin(ry)) + Math.abs((d / 2) * Math.cos(ry));
  ctx.level.boxAt(cx, cy, cz, hx * 2, h, hz * 2, tag);
}

/**
 * 沿 X 轴的一堵院墙：按 4m 一块分块砌，抹灰与污渍抹灰交替，顶上压一道瓦。
 * 每块都是一个 solid()，碰撞盒与块一一对应；块与块之间刻意重叠 3cm，
 * 免得将来改坐标时在接缝处裂出一条能看穿的缝。
 */
function wallX(
  ctx: BuildCtx,
  x0: number,
  x1: number,
  cz: number,
  y0: number,
  h: number,
  t: number,
  tag: string,
): void {
  const n = Math.max(1, Math.round((x1 - x0) / 4));
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const mat = i % 2 === 0 ? ctx.M.plaster : ctx.M.plasterStain;
    solid(ctx, mat, w + 0.03, h, t, x0 + w * (i + 0.5), y0 + h / 2, cz, tag);
  }
  solid(ctx, ctx.M.tileDark, x1 - x0 + 0.12, 0.22, t + 0.18, (x0 + x1) / 2, y0 + h + 0.11, cz, `${tag}-cap`);
}

/** 沿 Z 轴的一堵院墙，逻辑同 wallX。 */
function wallZ(
  ctx: BuildCtx,
  z0: number,
  z1: number,
  cx: number,
  y0: number,
  h: number,
  t: number,
  tag: string,
): void {
  const n = Math.max(1, Math.round((z1 - z0) / 4));
  const d = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const mat = i % 2 === 0 ? ctx.M.plaster : ctx.M.plasterStain;
    solid(ctx, mat, t, h, d + 0.03, cx, y0 + h / 2, z0 + d * (i + 0.5), tag);
  }
  solid(ctx, ctx.M.tileDark, t + 0.18, 0.22, z1 - z0 + 0.12, cx, y0 + h + 0.11, (z0 + z1) / 2, `${tag}-cap`);
}

// ── 礼厅 ─────────────────────────────────────────────────

/**
 * 礼厅壳体：台基、四面墙（含六个高窗与两个门洞）、双坡屋顶、
 * 六根室内柱、正门门廊、讲台，以及后门那扇半开的铁门。
 */
export function buildHallShell(ctx: BuildCtx): void {
  const { M } = ctx;
  const Y = PLATEAU_Y;
  const T = HALL.wallT; // 0.45
  const wallTop = Y + HALL.wall; // 14.4
  const midY = Y + HALL.wall / 2; // 11.2
  const W = HALL.x1 - HALL.x0; // 24
  const D = HALL.z1 - HALL.z0; // 26
  const cz = (HALL.z0 + HALL.z1) / 2; // -5，建筑与屋面的共同中线

  // 墙一律贴在建筑外轮廓的内侧，于是外立面正好落在 Layout 给的矩形上。
  const zS = HALL.z1 - T / 2; // 南墙（正门）中心 7.775
  const zN = HALL.z0 + T / 2; // 北墙（后门）中心 -17.775
  const xW = HALL.x0 + T / 2; // 西墙中心 -11.775
  const xE = HALL.x1 - T / 2; // 东墙中心 11.775

  // ── 1. 台基与地面 ──────────────────────────────────────
  // 台基：比建筑外扩 0.6m 的一圈石裙边，顶面就在 8 附近，玩家直接迈上去，
  // 因此它虽然登记了碰撞盒，却永远低于 stepUp，不会挡人。
  solid(ctx, M.stone, W + 1.2, 0.45, D + 1.2, 0, Y + LIFT - 0.225, cz, 'hall-floor');
  // 室内地板：再高 2cm，避免与台基顶面共面。
  solid(ctx, M.concrete, W - 2 * T, 0.16, D - 2 * T, 0, Y + LIFT + 0.02 - 0.08, cz, 'hall-floor');
  ctx.level.addFlat({
    x0: HALL.x0 - 0.6,
    x1: HALL.x1 + 0.6,
    z0: HALL.z0 - 0.6,
    z1: HALL.z1 + 0.6,
    y: Y,
    tag: 'hall-floor',
  });
  ctx.level.addFlat({ x0: HALL.x0, x1: HALL.x1, z0: HALL.z0, z1: HALL.z1, y: Y, tag: 'hall-floor' });

  // ── 2. 四面墙 ─────────────────────────────────────────
  // 南墙（正门）：门洞两侧各一段实体，门楣把上面补到墙顶 14.4。
  solid(ctx, M.plaster, HALL.doorX0 - HALL.x0, HALL.wall, T, (HALL.x0 + HALL.doorX0) / 2, midY, zS, 'hall-wall');
  solid(ctx, M.plaster, HALL.x1 - HALL.doorX1, HALL.wall, T, (HALL.doorX1 + HALL.x1) / 2, midY, zS, 'hall-wall');
  const doorH = HALL.wall - 2.6; // 3.8
  solid(ctx, M.plaster, HALL.doorX1 - HALL.doorX0, doorH, T, 0, wallTop - doorH / 2, zS, 'hall-wall');

  // 北墙（后门）：开口在东北角，正对通往后山密室的走廊。
  solid(ctx, M.plaster, HALL.backX0 - HALL.x0, HALL.wall, T, (HALL.x0 + HALL.backX0) / 2, midY, zN, 'hall-wall');
  solid(ctx, M.plaster, HALL.x1 - HALL.backX1, HALL.wall, T, (HALL.backX1 + HALL.x1) / 2, midY, zN, 'hall-wall');
  const backH = HALL.wall - 2.4; // 4.0
  solid(ctx, M.plaster, HALL.backX1 - HALL.backX0, backH, T, (HALL.backX0 + HALL.backX1) / 2, wallTop - backH / 2, zN, 'hall-wall');

  // 东西两面墙：各开三个高窗（窗台 11.8、窗顶 13.2）。
  // 每个窗洞把该段墙拆成「窗下段」与「窗上段」，窗下段照常碰撞，
  // 窗上段也在头顶 3 米以上，碰撞盒留着不影响任何人。
  const winZ: ReadonlyArray<readonly [number, number]> = [
    [-13, -11],
    [-5, -3],
    [3, 5],
  ];
  const SILL = 11.8;
  const HEAD = 13.2;
  // 三个窗洞把整面墙切成四段实体墙
  const runs: Array<[number, number]> = [];
  let zc: number = HALL.z0;
  for (const w of winZ) {
    runs.push([zc, w[0]]);
    zc = w[1];
  }
  runs.push([zc, HALL.z1]);

  for (const sx of [xW, xE]) {
    for (const [a, b] of runs) {
      solid(ctx, M.plaster, T, HALL.wall, b - a, sx, midY, (a + b) / 2, 'hall-wall');
    }
    for (const [a, b] of winZ) {
      const wcz = (a + b) / 2;
      const wd = b - a;
      solid(ctx, M.plaster, T, SILL - Y, wd, sx, (Y + SILL) / 2, wcz, 'hall-wall'); // 窗下段
      solid(ctx, M.plaster, T, wallTop - HEAD, wd, sx, (HEAD + wallTop) / 2, wcz, 'hall-wall'); // 窗上段
      // 窗台板、窗楣板与中间一根竖棂：让窗口读起来是窗而不是洞。
      // 全都在 11.6m 以上，玩家碰不到，所以只画不登记碰撞。
      ctx.b.box(T + 0.18, 0.18, wd + 0.3, M.woodDark, sx, SILL - 0.09, wcz);
      ctx.b.box(T + 0.18, 0.18, wd + 0.3, M.woodDark, sx, HEAD + 0.09, wcz);
      ctx.b.box(T + 0.1, HEAD - SILL, 0.1, M.woodDark, sx, (SILL + HEAD) / 2, wcz);
    }
    // 墙头到屋面之间还有约 0.4m 的缝（檐口高于墙顶），用一条通长的封檐带堵死，
    // 否则整条屋檐下会漏出一道亮线。它同样在 14.3m 以上，不参与实际阻挡。
    solid(ctx, M.plaster, T, 0.45, D, sx, wallTop + 0.175, cz, 'hall-wall');
  }

  // ── 3. 屋架 ───────────────────────────────────────────
  // 双坡：屋脊沿 Z 在 x=0、高 18，檐口在 x=±13.6、高 14.6（出檐 1.6m）。
  // 坡角 atan(3.4/13.6) ≈ 14.03° = 0.2449rad，两块板绕 Z 轴反向拧。
  // 屋面板是斜的，用轴对齐盒近似反而会错位，且玩家永远到不了 14m 以上，
  // 所以屋面只画不做碰撞。
  const SLOPE = 0.2449;
  const TAN = Math.tan(SLOPE);
  const RIDGE_Y = 18.0;
  ctx.b.box(14.02, 0.28, 28.4, M.tile, 6.8, 16.3, cz, 0, 0, -SLOPE);
  ctx.b.box(14.02, 0.28, 28.4, M.tile, -6.8, 16.3, cz, 0, 0, SLOPE);
  // 屋脊压顶
  solid(ctx, M.tileDark, 0.5, 0.45, 28.6, 0, RIDGE_Y + 0.1, cz, 'hall-ridge');
  // 檐口封檐板：沿两条檐口通长
  solid(ctx, M.woodDark, 0.14, 0.42, 28.5, 13.62, 14.45, cz, 'hall-eave');
  solid(ctx, M.woodDark, 0.14, 0.42, 28.5, -13.62, 14.45, cz, 'hall-eave');

  // 山墙填充：屋脊沿 Z，所以南北两端各有一个三角形空档。
  // 不堵的话从正立面能一眼看进阁楼、看穿到后院。
  // 只允许用盒子，就用一串小台阶逼近三角形：阶高取 0.28，
  // 不超过屋面板的竖直厚度 0.289——于是每一级的外上角刚好顶在屋面上皮之内，
  // 既不会捅出屋顶，也不会留下能看穿的缝。
  const UNDER = RIDGE_Y - 0.28 / Math.cos(SLOPE); // 屋面底皮在脊处的高度 ≈17.71
  for (const gz of [zS, zN]) {
    for (let y = wallTop; y < UNDER; y += 0.28) {
      const hw = Math.min(HALL.x1, (UNDER - y) / TAN);
      if (hw < 0.25) break;
      const h = Math.min(0.28, UNDER - y + 0.06);
      ctx.b.box(hw * 2, h, T, M.plaster, 0, y + h / 2, gz);
    }
  }

  // ── 4. 室内柱 ─────────────────────────────────────────
  // 六根柱子把大跨度的屋架撑起来，也把厅内空间切成中轴过道加两侧。
  const COL_X = 10.4;
  for (const px of [-COL_X, COL_X]) {
    for (const pz of [-13, -5, 3]) {
      ctx.b.cyl(0.3, 0.34, HALL.wall, M.woodDark, px, midY, pz, 8);
      // 柱身的碰撞盒按柱底外径 0.68 取 0.66，与视觉柱体包围盒一致
      ctx.level.boxAt(px, midY, pz, 0.66, HALL.wall, 0.66, 'column');
      // 柱础：高 0.22，低于 stepUp，只会把人轻轻托一下，不会绊住
      solid(ctx, M.stone, 0.86, 0.26, 0.86, px, Y + 0.09, pz, 'column-base');
    }
    // 额枋：把三根柱子连成整体，也压住柱头
    solid(ctx, M.woodDark, 0.42, 0.5, 16.4, px, wallTop - 0.25, cz, 'hall-beam');
  }

  // ── 5. 正门门廊 ───────────────────────────────────────
  // 两棵圆柱 + 一块小雨篷。柱子要碰撞，否则玩家会从柱子里穿过去。
  for (const px of [-2.7, 2.7]) {
    ctx.b.cyl(0.28, 0.28, 3.6, M.wood, px, Y + 1.8, 9.4, 8);
    ctx.level.boxAt(px, Y + 1.8, 9.4, 0.56, 3.6, 0.56, 'porch-column');
    solid(ctx, M.stone, 0.62, 0.3, 0.62, px, Y - 0.03, 9.4, 'porch-column-base');
    // 柱头正好垫在雨篷下皮（11.68）与柱顶（11.6）之间，把那道缝补上
    solid(ctx, M.wood, 0.62, 0.3, 0.62, px, Y + 3.75, 9.4, 'porch-capital');
  }
  // 雨篷深度给到 3.0，让北缘正好压在礼厅南墙上，不留缝
  solid(ctx, M.tileDark, 7.4, 0.24, 3.0, 0, Y + 3.8, 9.5, 'porch-canopy');

  // ── 6. 正门门框与门槛 ─────────────────────────────────
  // 门框柱贴着开口边线，只嵌进墙里，不占用通行宽度。
  for (const dx of [-1, 1]) {
    solid(ctx, M.woodDark, 0.3, 2.9, T, dx * (HALL.doorX1 + 0.15), Y + 1.45, zS, 'hall-door-frame');
  }
  // 门槛：14cm 高，低于 stepUp，走过去只是脚下垫一下
  solid(ctx, M.woodDark, HALL.doorX1 - HALL.doorX0 + 0.6, 0.14, T, 0, Y + 0.09, zS, 'hall-door-sill');

  // ── 7. 讲台 ───────────────────────────────────────────
  const stW = HALL.stageX1 - HALL.stageX0; // 12
  const stD = HALL.stageZ1 - HALL.stageZ0; // 5
  const stCX = (HALL.stageX0 + HALL.stageX1) / 2; // 0
  const stCZ = (HALL.stageZ0 + HALL.stageZ1) / 2; // -15.5
  const stTop = Y + HALL.stageH; // 8.5
  solid(ctx, M.wood, stW, HALL.stageH, stD, stCX, Y + HALL.stageH / 2, stCZ, 'stage');
  ctx.level.addFlat({
    x0: HALL.stageX0,
    x1: HALL.stageX1,
    z0: HALL.stageZ0,
    z1: HALL.stageZ1,
    y: stTop,
    tag: 'stage',
  });
  // 台前一阶 25cm 的矮踏：玩家从 8 迈上 8.25，再迈上讲台的 8.5。
  // 分两级是因为一级 0.5m 已经超过 stepUp(0.34)，会直接变成一堵挡墙。
  const stepD = 0.8;
  const stepCZ = HALL.stageZ1 + stepD / 2; // -12.6
  solid(ctx, M.wood, stW, 0.25, stepD, stCX, Y + 0.125, stepCZ, 'stage-step');
  ctx.level.addFlat({
    x0: HALL.stageX0,
    x1: HALL.stageX1,
    z0: HALL.stageZ1,
    z1: HALL.stageZ1 + stepD,
    y: Y + 0.25,
    tag: 'stage-step',
  });

  // ── 8. 后门门框与半开的铁门 ───────────────────────────
  for (const bx of [HALL.backX0 - 0.11, HALL.backX1 + 0.11]) {
    solid(ctx, M.woodDark, 0.22, 2.7, T + 0.06, bx, Y + 1.35, zN, 'back-door-frame');
  }
  // 一扇往走廊方向半开的铁门：铰链挂在东侧门框上，从关着的位置推开 65°。
  // 关着时门扇朝 -X（横在门洞里），推开后转向 -Z，落在走廊的东半边，
  // 中轴那条路（x≈9.8）始终是通的。
  const leaf = 1.3;
  const open = (65 * Math.PI) / 180;
  const dirX = -Math.cos(open);
  const dirZ = -Math.sin(open);
  const leafRy = Math.atan2(dirX, dirZ);
  solidRotY(
    ctx,
    M.steelDark,
    0.06,
    2.3,
    leaf,
    HALL.backX1 + (dirX * leaf) / 2,
    Y + 1.15,
    zN + (dirZ * leaf) / 2,
    leafRy,
    'iron-door',
  );
}

// ── 后山密室与连接走廊 ───────────────────────────────────

/**
 * 密室壳体：混凝土地面与四壁、波纹铁皮屋顶，外加那条把礼厅后门
 * 和密室连起来的走廊（两侧墙、顶板、吊在顶板下的灯管）。
 */
export function buildVaultShell(ctx: BuildCtx): void {
  const { M } = ctx;
  const Y = PLATEAU_Y;
  const T = 0.4;
  const wallTop = Y + VAULT.wall; // 12.2
  const midY = Y + VAULT.wall / 2; // 10.1
  const cxMid = (VAULT.x0 + VAULT.x1) / 2; // 1.5
  const czMid = (VAULT.z0 + VAULT.z1) / 2; // -34
  const zS = VAULT.z1 - T / 2; // 南墙中心 -25.8
  const zN = VAULT.z0 + T / 2; // 北墙中心 -41.8
  const xW = VAULT.x0 + T / 2; // -8.8
  const xE = VAULT.x1 - T / 2; // 11.8

  // ── 1. 地面 ───────────────────────────────────────────
  ctx.level.addFlat({
    x0: VAULT.x0,
    x1: VAULT.x1,
    z0: VAULT.z0,
    z1: VAULT.z1,
    y: Y,
    tag: 'vault-floor',
  });
  // 湿漉漉的水泥地板：暗、反光少，和礼厅的暖木地板分得很开
  solid(ctx, M.concreteWet, 20.6, 0.12, 15.6, cxMid, Y + LIFT + 0.02 - 0.06, czMid, 'vault-floor');

  // ── 2. 四壁（南墙留出通往走廊的门洞）──────────────────
  solid(ctx, M.concreteDark, VAULT.doorX0 - VAULT.x0, VAULT.wall, T, (VAULT.x0 + VAULT.doorX0) / 2, midY, zS, 'vault-wall');
  solid(ctx, M.concreteDark, VAULT.x1 - VAULT.doorX1, VAULT.wall, T, (VAULT.doorX1 + VAULT.x1) / 2, midY, zS, 'vault-wall');
  const doorHead = VAULT.wall - 2.4; // 1.8
  solid(ctx, M.concreteDark, VAULT.doorX1 - VAULT.doorX0, doorHead, T, (VAULT.doorX0 + VAULT.doorX1) / 2, wallTop - doorHead / 2, zS, 'vault-wall');
  solid(ctx, M.concreteDark, VAULT.x1 - VAULT.x0, VAULT.wall, T, cxMid, midY, zN, 'vault-wall');
  solid(ctx, M.concreteDark, T, VAULT.wall, VAULT.z1 - VAULT.z0, xW, midY, czMid, 'vault-wall');
  solid(ctx, M.concreteDark, T, VAULT.wall, VAULT.z1 - VAULT.z0, xE, midY, czMid, 'vault-wall');

  // ── 3. 波纹铁皮屋顶 ───────────────────────────────────
  // 底板一整块，然后沿 Z 每 0.55m 压一道棱条做出波纹。
  // 16.6m 进深按 0.55m 排下来是 30 道（题目里写的 39 道对应 0.426m 间距，
  // 与「每 0.55m 一道」对不上，这里以间距为准）。
  const roofY = wallTop + 0.15; // 12.35
  solid(ctx, M.steelDark, 21.6, 0.25, 16.6, cxMid, roofY, czMid, 'vault-roof');
  const ribY = roofY + 0.125 + 0.07;
  for (let z = VAULT.z0 - 0.1; z <= VAULT.z1 + 0.1; z += 0.55) {
    // 间距抖 ±3cm：手工压出来的铁皮不会齐得像贴图
    const jz = z + (ctx.rnd() - 0.5) * 0.06;
    ctx.b.box(21.6, 0.14, 0.22, M.steel, cxMid, ribY, jz);
  }
  // 墙头压条：屋面下皮（12.225）比墙顶（12.2）高 2.5cm，不堵的话
  // 沿着四面墙头会有一圈能看见天的细缝。这条压条同时咬住墙顶与屋面，把它封死。
  const capY = wallTop + 0.06; // 12.26 → 压条跨 12.09~12.43，正好咬住墙顶与屋面
  solid(ctx, M.steelDark, 0.5, 0.34, 16.6, xE, capY, czMid, 'vault-eave');
  solid(ctx, M.steelDark, 0.5, 0.34, 16.6, xW, capY, czMid, 'vault-eave');
  solid(ctx, M.steelDark, 21.2, 0.34, 0.5, cxMid, capY, zN, 'vault-eave');
  solid(ctx, M.steelDark, 21.2, 0.34, 0.5, cxMid, capY, zS, 'vault-eave');

  // ── 4. 走廊 ───────────────────────────────────────────
  // 两侧墙贴着净宽外侧砌，于是走廊内净宽正好是 [8.4, 11.2]，
  // 与礼厅后门、密室门的开口严丝合缝。
  const cLen = CORRIDOR.z1 - CORRIDOR.z0; // 8
  const cCZ = (CORRIDOR.z0 + CORRIDOR.z1) / 2; // -22
  const cMidX = (CORRIDOR.x0 + CORRIDOR.x1) / 2; // 9.8
  solid(ctx, M.concreteDark, 0.4, CORRIDOR.wall, cLen, CORRIDOR.x0 - 0.2, Y + CORRIDOR.wall / 2, cCZ, 'corridor-wall');
  solid(ctx, M.concreteDark, 0.4, CORRIDOR.wall, cLen, CORRIDOR.x1 + 0.2, Y + CORRIDOR.wall / 2, cCZ, 'corridor-wall');
  // 顶板：比净宽各宽出 0.1，前后再压进礼厅北墙与密室南墙各 0.2，接缝处不外露
  solid(ctx, M.concreteDark, 3.6, 0.3, cLen + 0.4, cMidX, Y + CORRIDOR.wall + 0.15, cCZ, 'corridor-ceiling');
  solid(ctx, M.concreteWet, 2.8, 0.12, cLen + 0.2, cMidX, Y + LIFT - 0.06, cCZ, 'corridor-floor');

  // ── 5. 走廊灯管 ───────────────────────────────────────
  // 一根惨绿的灯管吊在顶板下，自发光材质，不额外加光源
  // （密室与礼厅的灯光由别的模块负责，这里只给个灯具）。
  solid(ctx, M.steelDark, 0.09, 0.18, 0.09, cMidX, Y + 3.1, cCZ, 'corridor-lamp');
  // 灯管本体在 3m 高的顶板下，玩家碰不到，只画不做碰撞。
  ctx.b.box(0.16, 0.16, 1.6, M.greenLamp, cMidX, Y + 3.0, cCZ);
}

// ── 前院 ─────────────────────────────────────────────────

/**
 * 前院围墙：南面大门（两根方柱 + 横梁）、东西两侧院墙、
 * 北侧封住礼厅两翼空档的矮墙，以及院内地面。
 * 横梁正面留给别人挂匾额，这里不写任何字。
 */
export function buildYardShell(ctx: BuildCtx): void {
  const { M } = ctx;
  const Y = PLATEAU_Y;
  const T = 0.4;
  const wallTop = Y + YARD.wall; // 10.3
  const gateW = YARD.gateX1 - YARD.gateX0; // 4.8
  const gateZ = YARD.z1; // 26，院墙南线与大门中线

  // ── 1. 院内地面 ───────────────────────────────────────
  ctx.level.addFlat({ x0: YARD.x0, x1: YARD.x1, z0: YARD.z0, z1: YARD.z1, y: Y, tag: 'yard' });

  // ── 2. 院墙 ───────────────────────────────────────────
  // 南面留大门：门洞两侧分块砌墙
  wallX(ctx, YARD.x0, YARD.gateX0, gateZ - T / 2, Y, YARD.wall, T, 'yard-wall');
  wallX(ctx, YARD.gateX1, YARD.x1, gateZ - T / 2, Y, YARD.wall, T, 'yard-wall');
  // 东西两面：北端一直伸到矮墙那条线上，把院子的西北、东北角彻底封死
  const lowZ = 9.5; // 北侧矮墙中线
  wallZ(ctx, lowZ - T / 2, gateZ, YARD.x0 + T / 2, Y, YARD.wall, T, 'yard-wall');
  wallZ(ctx, lowZ - T / 2, gateZ, YARD.x1 - T / 2, Y, YARD.wall, T, 'yard-wall');

  // ── 3. 大门 ───────────────────────────────────────────
  const beamY = Y + 3.9; // 11.9
  const beamBottom = beamY - 0.25; // 11.65
  // 门上的砖额：从墙顶补到横梁下皮，免得大门上方是一个通天的大洞
  solid(ctx, M.plaster, gateW + 0.8, beamBottom - wallTop, T, 0, (wallTop + beamBottom) / 2, gateZ - T / 2, 'yard-gate-head');
  for (const px of [-3.0, 3.0]) {
    solid(ctx, M.stone, 0.8, 3.6, 0.8, px, Y + 1.8, gateZ, 'yard-gate-pillar');
    // 柱头：垫在横梁下面，补上柱子顶（11.6）与横梁底（11.65）之间的 5cm
    solid(ctx, M.stoneDark, 1.05, 0.3, 1.05, px, Y + 3.6, gateZ, 'yard-gate-capital');
  }
  // 横梁：正面留给匾额，这里一个字都不加
  solid(ctx, M.woodDark, 7.6, 0.5, 0.5, 0, beamY, gateZ, 'yard-gate-beam');

  // ── 4. 北侧矮墙 ───────────────────────────────────────
  // 礼厅两侧的空档用 1.6m 矮墙封住，中间正对礼厅门廊的那段留空当路。
  const lowH = 1.6;
  wallX(ctx, YARD.x0, HALL.x0 - 0.2, lowZ, Y, lowH, T, 'yard-lowwall');
  wallX(ctx, HALL.x1 + 0.2, YARD.x1, lowZ, Y, lowH, T, 'yard-lowwall');
  // 矮墙端头各加一道返墙，接到礼厅山墙外皮上：
  // 否则玩家能绕到礼厅侧面，顺着那条夹缝一直摸到后山去。
  for (const rx of [HALL.x0 - 0.2, HALL.x1 + 0.2]) {
    solid(ctx, M.plasterStain, T, lowH, lowZ - T / 2 - HALL.z1, rx, Y + lowH / 2, (HALL.z1 + lowZ - T / 2) / 2, 'yard-return');
  }
}

// ── 石阶 ─────────────────────────────────────────────────

/**
 * 从海滩爬上舍区的 20 级石阶。
 * 视觉是 20 个叠压的盒子；碰撞只登记一条斜坡——逐级给盒子的话，
 * 玩家会在每一级的棱角上被卡住。
 */
export function buildStairs(ctx: BuildCtx): void {
  const { M } = ctx;
  const RISE = 0.4;
  const RUN = 1.0;
  const STEPS = 20;
  const width = STAIRS.x1 - STAIRS.x0; // 6.8

  for (let i = 0; i < STEPS; i++) {
    // i = 0 是最低一级：顶面 0.4，z 中心 45.5；i = 19 顶面正好是 STAIRS.top = 8
    const top = RISE * (i + 1);
    const cz = STAIRS.zBottom - RUN / 2 - i * RUN;
    // 每级做 0.9 高：上下级之间自然叠压，看起来是实心的，不会露空
    ctx.b.box(width, 0.9, RUN, i % 2 === 0 ? M.stone : M.stoneDark, 0, top - 0.45, cz);
    // 两侧矮护栏：窄，而且玩家不常贴边走，按题目要求不做碰撞
    for (const rx of [STAIRS.x0 - 0.2, STAIRS.x1 + 0.2]) {
      ctx.b.box(0.28, 0.55, RUN, M.stoneDark, rx, top + 0.27, cz);
    }
  }

  // 整条台阶的碰撞：一条从台地到海滩的斜坡，玩家走上去是平滑的
  ctx.level.addRamp({
    x0: STAIRS.x0,
    x1: STAIRS.x1,
    z0: STAIRS.zTop,
    z1: STAIRS.zBottom,
    y0: STAIRS.top,
    y1: STAIRS.bottom,
    axis: 'z',
    tag: 'stairs',
  });
}
