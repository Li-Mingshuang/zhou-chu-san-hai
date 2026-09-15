import {
  DoubleSide,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  PointLight,
  Group,
} from 'three';
import type { BuildCtx } from './ctx.js';
import { HALL, VAULT, YARD, PLATEAU_Y } from './Layout.js';
import { P } from '../render/Palette.js';
import { makeLetterTexture, makeTextTexture } from '../render/TextTex.js';
import { interactable } from '../systems/Interaction.js';
import { planeGeo } from '../render/Geo.js';

/**
 * 道具与叙事物。
 *
 * 本章没有过场动画。所有"发生了什么"都靠你在一个东西面前按下 E：
 * 一沓钱、一柜子名表、一堵信徒的信、铁栅栏后面的小孩。
 * 这些交互物才是这一章的剧本。
 */

export interface SeatSpot {
  x: number;
  z: number;
  yaw: number;
}

export interface PropHandles {
  seats: SeatSpot[];
  /** 需要动画的灯（香炉、日光灯）。 */
  lights: PointLight[];
  /** 铁栅栏门（可开）。 */
  cageDoor: Object3D | null;
  /** 供台前的蒲团位置。 */
  cushions: Array<[number, number]>;
}

function emptyHandles(): PropHandles {
  return { seats: [], lights: [], cageDoor: null, cushions: [] };
}

/** 挂一块带文字的布/木牌。文字贴图是现画的，不是素材。 */
function sign(
  ctx: BuildCtx,
  text: string,
  opts: {
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    ry?: number;
    vertical?: boolean;
    color?: string;
    fontSize?: number;
    glow?: boolean;
    twoSided?: boolean;
  },
): Mesh {
  const tex = ctx.track(
    makeTextTexture(text, {
      vertical: opts.vertical ?? false,
      fontSize: opts.fontSize ?? 96,
      color: opts.color ?? '#efe7d5',
      stain: 0.35,
      erosion: 0.14,
      seed: Math.floor(opts.x * 13 + opts.z * 7 + text.length),
    }),
  );
  const mat = ctx.track(
    new MeshLambertMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.06,
      side: opts.twoSided ? DoubleSide : DoubleSide,
      depthWrite: false,
      emissive: opts.glow ? 0x2a2114 : 0x000000,
      color: 0xffffff,
    }),
  );
  const geo = ctx.track(planeGeo(opts.width, opts.height));
  const mesh = new Mesh(geo, mat);
  mesh.position.set(opts.x, opts.y, opts.z);
  mesh.rotation.y = opts.ry ?? 0;
  mesh.name = `sign:${text}`;
  ctx.dynamic.add(mesh);
  return mesh;
}

// ══════════════════════════════════════════════════════════
//  礼厅
// ══════════════════════════════════════════════════════════

export function buildHallProps(ctx: BuildCtx): PropHandles {
  const h = emptyHandles();
  const { b, M } = ctx;
  const floor = PLATEAU_Y;

  const benchLeft = { x0: HALL.x0 + 1.2, x1: HALL.aisleX0 - 0.4 };
  const benchRight = { x0: HALL.aisleX1 + 0.4, x1: HALL.x1 - 1.2 };
  const rows = HALL.benchRows;
  const spacing = (HALL.benchZ1 - HALL.benchZ0) / (rows - 1);

  for (let r = 0; r < rows; r++) {
    const z = HALL.benchZ0 + r * spacing;
    for (const side of [-1, 1] as const) {
      const blk = side < 0 ? benchLeft : benchRight;
      const w = blk.x1 - blk.x0;
      const cx = (blk.x0 + blk.x1) / 2;
      b.box(w, 0.42, 0.4, M.wood, cx, floor + 0.21, z);
      b.box(w + 0.14, 0.07, 0.48, M.woodDark, cx, floor + 0.45, z);
      // 踢脚横撑
      b.box(w, 0.06, 0.07, M.woodDark, cx, floor + 0.06, z);
      ctx.level.boxAt(cx, floor + 0.21, z, w, 0.49, 0.48, 'bench', { sight: false });
    }
    // 两排之间坐四个人：左二右二，靠过道
    if (r % 2 === 0) {
      h.seats.push({ x: benchLeft.x1 - 0.8, z, yaw: 0 });
      h.seats.push({ x: benchLeft.x0 + 0.8, z, yaw: 0 });
      h.seats.push({ x: benchRight.x0 + 0.8, z, yaw: 0 });
      h.seats.push({ x: benchRight.x1 - 0.8, z, yaw: 0 });
    }
  }

  // ── 讲台 ─────────────────────────────────────────────
  const stageTop = floor + HALL.stageH;
  // 供桌
  b.box(4.6, 0.12, 1.0, M.lacquerDark, 0, stageTop + 0.92, -16.4);
  b.box(0.18, 0.9, 0.18, M.lacquerDark, -2.0, stageTop + 0.46, -16.4);
  b.box(0.18, 0.9, 0.18, M.lacquerDark, 2.0, stageTop + 0.46, -16.4);
  b.box(3.4, 0.05, 0.7, M.cloth, 0, stageTop + 1.0, -16.4);
  ctx.level.boxAt(0, stageTop + 0.5, -16.4, 4.6, 1.0, 1.0, 'altar');

  // 尊者的座位
  b.box(0.9, 0.1, 0.8, M.wood, 0, stageTop + 0.48, -17.0);
  b.box(0.9, 0.5, 0.12, M.woodDark, 0, stageTop + 0.78, -17.36);
  b.box(0.14, 0.44, 0.7, M.woodDark, -0.38, stageTop + 0.24, -17.0);
  b.box(0.14, 0.44, 0.7, M.woodDark, 0.38, stageTop + 0.24, -17.0);

  // 香炉
  b.cyl(0.42, 0.3, 0.36, M.steelDark, 0, stageTop + 1.18, -16.4, 10);
  b.cyl(0.46, 0.44, 0.06, M.steel, 0, stageTop + 1.38, -16.4, 10);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.cyl(0.012, 0.012, 0.5, M.incense, Math.cos(a) * 0.12, stageTop + 1.62, -16.4 + Math.sin(a) * 0.12, 4);
  }
  const incenseLight = new PointLight(0xff8a3c, 1.6, 9, 2);
  incenseLight.position.set(0, stageTop + 1.5, -16.2);
  ctx.light(incenseLight);
  h.lights.push(incenseLight);
  ctx.animate((_dt, t) => {
    incenseLight.intensity = 1.5 + Math.sin(t * 2.3) * 0.16 + Math.sin(t * 5.7) * 0.07;
  });

  // 蒲团
  for (let i = 0; i < 6; i++) {
    const x = -2.5 + i * 1.0;
    b.cyl(0.32, 0.34, 0.11, M.clothDark, x, stageTop + 0.055, -13.9, 8);
    h.cushions.push([x, -13.9]);
  }

  // ── 匾额与条幅 ───────────────────────────────────────
  sign(ctx, '新心靈舍', {
    x: 0,
    y: floor + 5.2,
    z: HALL.z0 + 0.16,
    width: 4.6,
    height: 1.15,
    ry: 0,
    fontSize: 120,
    glow: true,
  });
  // 正门内侧的匾
  sign(ctx, '心誠則靈', {
    x: 0,
    y: floor + 4.6,
    z: HALL.z1 - 0.16,
    width: 3.2,
    height: 0.8,
    ry: Math.PI,
    fontSize: 110,
  });

  const bannerTexts = ['感謝天地', '放下執念', '心存善念', '回頭是岸'];
  for (let i = 0; i < 4; i++) {
    const x = -9 + i * 6;
    sign(ctx, bannerTexts[i]!, {
      x,
      y: floor + 3.4,
      z: HALL.z0 + 0.5,
      width: 0.62,
      height: 2.9,
      ry: 0,
      vertical: true,
      fontSize: 84,
    });
  }
  // 侧墙上的字
  sign(ctx, '止語', {
    x: HALL.x0 + 0.2,
    y: floor + 2.4,
    z: -4,
    width: 0.66,
    height: 1.6,
    ry: Math.PI / 2,
    vertical: true,
    fontSize: 90,
  });
  sign(ctx, '感恩', {
    x: HALL.x1 - 0.2,
    y: floor + 2.4,
    z: -4,
    width: 0.6,
    height: 1.2,
    ry: -Math.PI / 2,
    vertical: true,
    fontSize: 90,
  });

  // ── 灯笼 ─────────────────────────────────────────────
  const lanternSpots: Array<[number, number, number]> = [
    [-7.5, floor + 5.0, -12],
    [7.5, floor + 5.0, -12],
    [-7.5, floor + 5.0, -3],
    [7.5, floor + 5.0, -3],
    [-7.5, floor + 5.0, 5],
    [7.5, floor + 5.0, 5],
    [0, floor + 5.0, -16.6],
  ];
  for (const [lx, ly, lz] of lanternSpots) {
    // 吊绳
    b.box(0.02, 1.2, 0.02, M.woodDark, lx, ly + 0.7, lz);
    b.cyl(0.22, 0.24, 0.52, M.lantern, lx, ly, lz, 8);
    b.cyl(0.08, 0.26, 0.1, M.lacquerDark, lx, ly + 0.31, lz, 8);
    b.cyl(0.08, 0.26, 0.1, M.lacquerDark, lx, ly - 0.31, lz, 8);
  }
  const hallLights: Array<[number, number]> = [
    [0, -14],
    [0, -2],
    [0, 6],
  ];
  for (const [lx, lz] of hallLights) {
    const l = new PointLight(P.lantern, 2.6, 22, 2);
    l.position.set(lx, floor + 4.6, lz);
    ctx.light(l);
    h.lights.push(l);
  }

  // ── 讲台正上方打下来的一束光 ─────────────────────────
  // 尊者站在台口，光从他头顶下来，把整个礼厅的注意力钉在他身上。
  const idolSpot = new PointLight(0xffe2b4, 3.4, 13, 2);
  idolSpot.position.set(0, stageTop + 3.4, -13.4);
  ctx.light(idolSpot);
  h.lights.push(idolSpot);
  // 灯罩（让这束光看起来有来源）
  b.cyl(0.3, 0.22, 0.24, M.lacquerDark, 0, stageTop + 3.7, -13.4, 8);
  b.cyl(0.1, 0.1, 0.5, M.muzzle, 0, stageTop + 3.45, -13.4, 6);
  ctx.animate((_dt, t) => {
    idolSpot.intensity = 3.3 + Math.sin(t * 0.7) * 0.18;
  });

  // 讲台前的一小块地毯，把他从木地板上托起来
  b.box(3.6, 0.02, 2.6, M.lacquerDark, 0, stageTop + 0.012, -13.9);

  // 供台前的长明灯
  b.cyl(0.14, 0.17, 0.26, M.lacquer, -2.6, stageTop + 0.13, -16.0, 8);
  b.cyl(0.05, 0.05, 0.1, M.muzzle, -2.6, stageTop + 0.3, -16.0, 6);
  b.cyl(0.14, 0.17, 0.26, M.lacquer, 2.6, stageTop + 0.13, -16.0, 8);
  b.cyl(0.05, 0.05, 0.1, M.muzzle, 2.6, stageTop + 0.3, -16.0, 6);

  // ── 弹唱的人坐的那张凳子 ─────────────────────────────
  // 凳面高度是从 Humanoid.sit() 反推的：坐姿把胯降到根节点上方 0.526 米，
  // 所以凳面做到 8.50 就刚好托住他，不会穿模也不会悬空。
  {
    const sx = -8.8;
    const sz = -11.2;
    const ry = -2.45;
    b.box(0.46, 0.06, 0.44, M.woodWorn, sx, floor + 0.47, sz, ry);
    const ca = Math.cos(ry);
    const sa = Math.sin(ry);
    for (const [lx, lz] of [
      [-0.17, -0.16],
      [0.17, -0.16],
      [-0.17, 0.16],
      [0.17, 0.16],
    ] as Array<[number, number]>) {
      b.box(0.05, 0.47, 0.05, M.woodDark, sx + lx * ca - lz * sa, floor + 0.235, sz + lx * sa + lz * ca);
    }
    b.box(0.4, 0.04, 0.04, M.woodDark, sx, floor + 0.14, sz, ry);
  }

  // ── 功德箱 ───────────────────────────────────────────
  b.box(1.1, 0.72, 0.7, M.lacquerDark, -3.4, floor + 0.36, HALL.z1 - 1.6, 0.12);
  b.box(1.16, 0.08, 0.76, M.lacquer, -3.4, floor + 0.75, HALL.z1 - 1.6, 0.12);
  b.box(0.34, 0.03, 0.1, M.ink, -3.4, floor + 0.79, HALL.z1 - 1.6, 0.12);
  sign(ctx, '功德', {
    x: -3.4,
    y: floor + 0.45,
    z: HALL.z1 - 1.95,
    width: 0.5,
    height: 0.28,
    ry: 0,
    fontSize: 90,
  });
  ctx.level.boxAt(-3.4, floor + 0.36, HALL.z1 - 1.6, 1.1, 0.72, 0.7, 'donation');

  // ── 立柱间的电线与裸灯泡 ─────────────────────────────
  b.box(0.015, 0.015, 12, M.ink, 4.6, floor + 5.6, -5);
  b.cyl(0.06, 0.09, 0.14, M.muzzle, 4.6, floor + 5.5, -2, 6);
  const bulb = new PointLight(0xffe6bb, 0.8, 7, 2);
  bulb.position.set(4.6, floor + 5.4, -2);
  ctx.light(bulb);

  // ── 可交互物 ─────────────────────────────────────────
  ctx.interact(
    interactable({
      id: 'hall-donation',
      x: -3.4,
      y: floor + 0.7,
      z: HALL.z1 - 1.6,
      radius: 2.6,
      label: '看功德箱',
      once: true,
      onInteract: (game) => {
        game.audio.paper();
        game.say('塞满了。上面几张是新钞，下面压着的边角发黑。', { narr: true });
      },
    }),
  );

  ctx.interact(
    interactable({
      id: 'hall-incense',
      x: 0,
      y: stageTop + 1.3,
      z: -16.2,
      radius: 3.2,
      label: '看香炉',
      once: true,
      onInteract: (game) => {
        game.audio.breath(0.5);
        game.say('香是新换的。香灰下面埋着一层没烧完的纸。', { narr: true });
      },
    }),
  );

  ctx.interact(
    interactable({
      id: 'hall-seat',
      x: 0,
      y: floor + 0.5,
      z: HALL.benchZ1 + 0.6,
      radius: 2.6,
      label: '坐下',
      once: true,
      onInteract: (game) => {
        game.say('最后一排。这个位置看得见所有人。', { narr: true });
        game.flag('sat-last-row', true);
      },
    }),
  );

  // 一封信掉在过道上
  const letterTex = ctx.track(makeLetterTexture(11));
  const letterMat = ctx.track(
    new MeshLambertMaterial({ map: letterTex, side: DoubleSide, transparent: true }),
  );
  const letterGeo = ctx.track(planeGeo(0.22, 0.3));
  const letter = new Mesh(letterGeo, letterMat);
  letter.rotation.x = -Math.PI / 2;
  letter.rotation.z = 0.4;
  letter.position.set(-2.6, floor + 0.015, -6.6);
  ctx.dynamic.add(letter);
  ctx.interact(
    interactable({
      id: 'hall-letter',
      x: -2.6,
      y: floor + 0.2,
      z: -6.6,
      radius: 2.2,
      label: '捡起信',
      once: true,
      onInteract: (game) => {
        game.audio.paper();
        game.say('写给「师兄」的。说她把房子卖了，问什么时候能见孩子。', { narr: true });
      },
    }),
  );

  return h;
}

// ══════════════════════════════════════════════════════════
//  密室
// ══════════════════════════════════════════════════════════

export function buildVaultProps(ctx: BuildCtx): PropHandles {
  const h = emptyHandles();
  const { b, M } = ctx;
  const floor = VAULT.floor;

  // ── 铁架 ─────────────────────────────────────────────
  const shelfZ = [-40, -37.4, -34.8, -32.2, -29.6];
  for (const sz of shelfZ) {
    for (const sx of [-6.4, 0.2, 6.8]) {
      for (let i = 0; i < 4; i++) {
        b.box(3.0, 0.05, 0.55, M.steelDark, sx, floor + 0.45 + i * 0.55, sz);
      }
      for (const lx of [-1.45, 1.45]) {
        for (const lz of [-0.24, 0.24]) {
          b.box(0.06, 2.1, 0.06, M.steelDark, sx + lx, floor + 1.05, sz + lz);
        }
      }
      ctx.level.boxAt(sx, floor + 1.05, sz, 3.0, 2.1, 0.6, 'shelf');
      // 架上的纸箱
      for (let i = 0; i < 3; i++) {
        const w = 0.5 + ctx.rnd() * 0.4;
        const hh = 0.3 + ctx.rnd() * 0.22;
        b.box(w, hh, 0.44, M.paper, sx - 1.0 + i * 1.0, floor + 0.5 + Math.floor(i) * 0.55 + hh / 2, sz, ctx.rnd.range(-0.2, 0.2));
      }
    }
  }

  // ── 地上的纸箱堆 ─────────────────────────────────────
  for (let i = 0; i < 26; i++) {
    const x = ctx.rnd.range(-7.5, 10.5);
    const z = ctx.rnd.range(-41, -27);
    if (x > 6.5 && z > -30) continue; // 别堵住门口
    const w = 0.55 + ctx.rnd() * 0.5;
    const hh = 0.4 + ctx.rnd() * 0.35;
    const d = 0.55 + ctx.rnd() * 0.5;
    const stack = ctx.rnd() < 0.35 ? 2 : 1;
    for (let s = 0; s < stack; s++) {
      b.box(w, hh, d, ctx.rnd() < 0.5 ? M.paper : M.clothDark, x, floor + hh / 2 + s * hh, z, ctx.rnd.range(-0.4, 0.4));
    }
    ctx.level.boxAt(x, floor + hh, z, w, hh * stack, d, 'crate', { sight: false });
  }

  // ── 钱 ───────────────────────────────────────────────
  b.box(2.4, 0.75, 1.1, M.woodWorn, -1.5, floor + 0.375, -31.4);
  ctx.level.boxAt(-1.5, floor + 0.375, -31.4, 2.4, 0.75, 1.1, 'table');
  for (let i = 0; i < 16; i++) {
    const stackH = 0.06 + ctx.rnd() * 0.14;
    b.box(0.34, stackH, 0.16, M.cash, -2.4 + (i % 8) * 0.26, floor + 0.78 + stackH / 2, -31.5 + Math.floor(i / 8) * 0.4, ctx.rnd.range(-0.12, 0.12));
  }
  // 散落在地上的钞票
  for (let i = 0; i < 22; i++) {
    b.box(0.16, 0.01, 0.07, M.cash, ctx.rnd.range(-4, 3), floor + 0.012, ctx.rnd.range(-34, -29), ctx.rnd.range(0, 3.14));
  }

  // ── 名表托盘 ─────────────────────────────────────────
  b.box(1.4, 0.06, 0.7, M.clothDark, 3.6, floor + 0.85, -31.4);
  b.box(0.06, 0.86, 0.06, M.steelDark, 3.0, floor + 0.43, -31.7);
  b.box(0.06, 0.86, 0.06, M.steelDark, 4.2, floor + 0.43, -31.7);
  for (let i = 0; i < 12; i++) {
    const wx = 3.0 + (i % 4) * 0.34;
    const wz = -31.6 + Math.floor(i / 4) * 0.22;
    b.cyl(0.075, 0.075, 0.03, M.watch, wx, floor + 0.9, wz, 10);
    b.box(0.05, 0.012, 0.02, M.watch, wx, floor + 0.9, wz - 0.11);
  }
  // 珠宝盒
  for (let i = 0; i < 6; i++) {
    b.box(0.24, 0.09, 0.18, M.lacquerDark, -6.0 + i * 0.3, floor + 0.05, -28.4, ctx.rnd.range(-0.3, 0.3));
    b.box(0.08, 0.03, 0.06, ctx.rnd() < 0.5 ? M.gold : M.jewel, -6.0 + i * 0.3, floor + 0.11, -28.4);
  }

  // ── 铁栅栏小间 ───────────────────────────────────────
  const cage = { x0: VAULT.x0 + 0.3, x1: VAULT.x0 + 3.9, z0: VAULT.z0 + 0.3, z1: VAULT.z0 + 4.4 };
  const barMat = M.steelDark;
  for (let i = 0; i <= 12; i++) {
    const x = cage.x0 + ((cage.x1 - cage.x0) * i) / 12;
    b.box(0.05, 2.2, 0.05, barMat, x, floor + 1.1, cage.z1);
  }
  for (let i = 0; i <= 14; i++) {
    const z = cage.z0 + ((cage.z1 - cage.z0) * i) / 14;
    b.box(0.05, 2.2, 0.05, barMat, cage.x1, floor + 1.1, z);
  }
  b.box(3.7, 0.08, 0.08, barMat, (cage.x0 + cage.x1) / 2, floor + 2.22, cage.z1);
  b.box(0.08, 0.08, 4.2, barMat, cage.x1, floor + 2.22, (cage.z0 + cage.z1) / 2);
  ctx.level.boxAt((cage.x0 + cage.x1) / 2, floor + 1.1, cage.z1, cage.x1 - cage.x0, 2.2, 0.1, 'cage');
  ctx.level.boxAt(cage.x1, floor + 1.1, (cage.z0 + cage.z1) / 2, 0.1, 2.2, cage.z1 - cage.z0, 'cage');

  // 栅栏里的东西
  b.box(1.2, 0.1, 0.8, M.clothDark, cage.x0 + 1.2, floor + 0.05, cage.z0 + 1.4);
  b.cyl(0.16, 0.13, 0.1, M.steel, cage.x0 + 2.6, floor + 0.05, cage.z0 + 0.9, 8);
  b.box(0.3, 0.02, 0.22, M.paper, cage.x0 + 2.2, floor + 0.02, cage.z0 + 2.6, 0.6);

  // ── 满墙的信 ─────────────────────────────────────────
  const letterVariants = [
    ctx.track(makeLetterTexture(3)),
    ctx.track(makeLetterTexture(19)),
    ctx.track(makeLetterTexture(47)),
  ];
  const letterMats = letterVariants.map((t) =>
    ctx.track(new MeshLambertMaterial({ map: t, side: DoubleSide, transparent: true })),
  );
  const noteGeo = ctx.track(planeGeo(0.19, 0.26));
  const noteGroup = new Group();
  noteGroup.name = 'vault-letters';
  for (let i = 0; i < 46; i++) {
    const m = new Mesh(noteGeo, letterMats[i % letterMats.length]!);
    const col = i % 10;
    const row = Math.floor(i / 10);
    m.position.set(
      VAULT.x0 + 1.2 + col * 1.05,
      floor + 1.1 + row * 0.62 + ctx.rnd.range(-0.06, 0.06),
      VAULT.z1 - 0.06,
    );
    m.rotation.z = ctx.rnd.range(-0.14, 0.14);
    m.rotation.x = ctx.rnd.range(-0.06, 0.06);
    noteGroup.add(m);
  }
  ctx.dynamic.add(noteGroup);

  // ── 日光灯 ───────────────────────────────────────────
  for (const lz of [-39, -34, -29]) {
    b.box(0.16, 0.14, 2.4, M.greenLamp, -3.0, floor + 3.9, lz);
    b.box(0.16, 0.14, 2.4, M.greenLamp, 5.0, floor + 3.9, lz);
  }
  const vaultLightSpots: Array<[number, number]> = [
    [-3.0, -39],
    [5.0, -34],
    [-3.0, -29],
  ];
  for (const [lx, lz] of vaultLightSpots) {
    const l = new PointLight(P.greenLamp, 1.5, 15, 2);
    l.position.set(lx, floor + 3.7, lz);
    ctx.light(l);
    h.lights.push(l);
  }
  ctx.animate((_dt, t) => {
    // 日光灯在闪。不是特效，是这地方本来就这样。
    for (let i = 0; i < h.lights.length; i++) {
      const l = h.lights[i]!;
      if (l.color.getHex() !== P.greenLamp) continue;
      const flick = Math.sin(t * 31 + i * 7.3) > 0.96 ? 0.25 : 1;
      l.intensity = 1.5 * flick;
    }
  });

  // ── 可交互物 ─────────────────────────────────────────
  ctx.interact(
    interactable({
      id: 'vault-cash',
      x: -1.5,
      y: floor + 0.9,
      z: -31.4,
      radius: 2.8,
      label: '看那些钱',
      once: true,
      onInteract: (game) => {
        game.audio.paper();
        game.say('捆好的，橡皮筋都还在。一共二十几捆。', { narr: true });
        game.say('他收了一辈子的"供养"，从来不用记账。', { narr: true });
      },
    }),
  );

  ctx.interact(
    interactable({
      id: 'vault-watches',
      x: 3.6,
      y: floor + 0.9,
      z: -31.4,
      radius: 2.6,
      label: '看那些表',
      once: true,
      onInteract: (game) => {
        game.audio.latch();
        game.say('十二只。都停在不同的时间。', { narr: true });
      },
    }),
  );

  ctx.interact(
    interactable({
      id: 'vault-letters',
      x: VAULT.x0 + 6.0,
      y: floor + 1.5,
      z: VAULT.z1 - 0.6,
      radius: 3.4,
      label: '看墙上的信',
      once: true,
      onInteract: (game) => {
        game.audio.paper();
        game.say('一墙的信。每一封都在问同一个问题，每一封都没有回音。', { narr: true });
        game.flag('saw-letters', true);
      },
    }),
  );

  ctx.interact(
    interactable({
      id: 'vault-cage',
      x: cage.x1 + 0.6,
      y: floor + 1.0,
      z: (cage.z0 + cage.z1) / 2,
      radius: 2.8,
      label: '看铁栅栏后面',
      once: true,
      onInteract: (game) => {
        game.audio.childCry(0.8);
        game.say('一个小孩。蹲在角落里，抬头看你，没有哭。', { narr: true });
        game.say('他好像已经习惯了有人来看他一眼，然后走开。', { narr: true });
        game.flag('saw-child', true);
        game.objective('回到礼厅');
      },
    }),
  );

  // 名册：放在两排铁架之间那张小桌上，是玩家真的走得到的位置
  b.box(1.0, 0.75, 0.62, M.woodWorn, -3.6, floor + 0.375, -30.4);
  b.box(0.46, 0.04, 0.36, M.lacquerDark, -3.6, floor + 0.77, -30.4, 0.24);
  b.box(0.42, 0.05, 0.32, M.paper, -3.6, floor + 0.81, -30.4, 0.24);
  ctx.level.boxAt(-3.6, floor + 0.375, -30.4, 1.0, 0.75, 0.62, 'desk');

  ctx.interact(
    interactable({
      id: 'vault-ledger',
      x: -3.6,
      y: floor + 0.95,
      z: -30.4,
      radius: 2.6,
      label: '翻名册',
      once: true,
      onInteract: (game) => {
        game.audio.paper();
        game.say('一本名册。姓名、生日、捐了多少、什么时候"往生"。', { narr: true });
        game.say('最后一页只写了一行：「陈桂林，待处理。」', { narr: true });
      },
    }),
  );

  return h;
}

// ══════════════════════════════════════════════════════════
//  前院
// ══════════════════════════════════════════════════════════

export function buildYardProps(ctx: BuildCtx): PropHandles {
  const h = emptyHandles();
  const { b, M } = ctx;
  const floor = PLATEAU_Y;

  // 大门匾额
  sign(ctx, '新心靈舍', {
    x: 0,
    y: floor + 3.2,
    z: YARD.z1 + 0.3,
    width: 3.6,
    height: 0.9,
    ry: Math.PI,
    fontSize: 118,
    glow: true,
  });

  // 水缸
  for (const [vx, vz] of [
    [-14.5, 14.5],
    [5.4, 22.0],
  ] as Array<[number, number]>) {
    b.cyl(0.85, 0.72, 1.05, M.stoneDark, vx, floor + 0.52, vz, 10);
    b.cyl(0.74, 0.74, 0.06, M.seaDeep, vx, floor + 1.0, vz, 10);
    ctx.level.boxAt(vx, floor + 0.52, vz, 1.7, 1.05, 1.7, 'vat');
  }

  // 晾衣绳
  b.box(0.04, 0.04, 12, M.woodDark, -20, floor + 2.3, 17.5);
  for (let i = 0; i < 6; i++) {
    b.box(0.02, 0.9, 0.5, i % 2 === 0 ? M.cloth : M.clothDark, -19.4 + i * 2.2, floor + 1.82, 17.5);
  }

  // 石灯
  for (const [sx, sz] of [
    [-11.5, 11.5],
    [11.5, 11.5],
  ] as Array<[number, number]>) {
    b.box(0.7, 0.24, 0.7, M.stone, sx, floor + 0.12, sz);
    b.cyl(0.16, 0.2, 1.0, M.stone, sx, floor + 0.74, sz, 6);
    b.box(0.56, 0.42, 0.56, M.stone, sx, floor + 1.45, sz);
    b.box(0.42, 0.26, 0.42, M.muzzle, sx, floor + 1.45, sz);
    b.box(0.72, 0.14, 0.72, M.stoneDark, sx, floor + 1.73, sz);
    ctx.level.boxAt(sx, floor + 0.9, sz, 0.7, 1.8, 0.7, 'stonelamp');
  }

  // 蒲团堆
  for (let i = 0; i < 8; i++) {
    b.cyl(0.32, 0.34, 0.11, M.clothDark, 16.5 + (i % 4) * 0.7, floor + 0.055 * (1 + Math.floor(i / 4)), 13.0 + Math.floor(i / 4) * 0.4, 8);
  }

  // 靠在墙上的扫帚与水桶
  b.cyl(0.03, 0.03, 1.6, M.wood, -22.6, floor + 0.8, 20, 5);
  b.box(0.3, 0.4, 0.06, M.vegDry, -22.6, floor + 0.2, 20);
  b.cyl(0.2, 0.17, 0.34, M.steelDark, -21.6, floor + 0.17, 21.2, 8);

  // ── 可交互物 ─────────────────────────────────────────
  ctx.interact(
    interactable({
      id: 'yard-vat',
      x: -14.5,
      y: floor + 1.0,
      z: 14.5,
      radius: 2.6,
      label: '照一下水面',
      once: true,
      onInteract: (game) => {
        game.say('水里有个人。瘦了，颧骨高出来了。', { narr: true });
        game.say('他把手伸进去搅了一下，人就散了。', { narr: true });
      },
    }),
  );

  // 那块表：本章唯一强制的交互
  b.box(0.34, 0.06, 0.34, M.clothDark, -2.6, floor + 0.03, 20.4, 0.3);
  b.cyl(0.055, 0.055, 0.02, M.watch, -2.6, floor + 0.07, 20.4, 10);
  const watchInteract = interactable({
    id: 'yard-watch',
    x: -2.6,
    y: floor + 0.3,
    z: 20.4,
    radius: 2.6,
    label: '摘下手表',
    once: true,
    onInteract: (game) => {
      game.audio.latch();
      game.say('奶奶留下的那只表。表带已经磨白了。', { narr: true });
      game.say('他把它放在布上，推过去。', { narr: true });
      game.flag('gave-watch', true);
      game.objective('跟着师兄进礼厅');
    },
  });
  ctx.interact(watchInteract);

  sign(ctx, '止語', {
    x: -2.6,
    y: floor + 0.9,
    z: 19.0,
    width: 0.6,
    height: 1.4,
    ry: 0,
    vertical: true,
    fontSize: 92,
  });

  return h;
}
