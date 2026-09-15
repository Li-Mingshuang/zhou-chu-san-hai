import { BufferGeometry, Group, Material, Object3D, type Light } from 'three';
import { Batcher } from '../render/Geo.js';
import type { MatLib } from '../render/Mats.js';
import type { Rng } from '../core/MathUtils.js';
import { Level } from './Collision.js';
import { createMatKeys, type BuildCtx, type MatKeys } from './ctx.js';
import { PLATEAU_Y, VAULT, terrainHeight } from './Layout.js';
import { POLICE_LOOK } from '../entities/Humanoid.js';
import { buildBackdrop, buildSea, buildSurf, buildTerrain } from './Terrain.js';
import { buildDock, buildNature } from './Nature.js';
import { buildHallShell, buildStairs, buildVaultShell, buildYardShell } from './Shell.js';
import {
  buildHallProps,
  buildVaultProps,
  buildYardProps,
  type PropHandles,
  type SeatSpot,
} from './Props.js';
import type { CultistSpawn } from '../entities/Cultist.js';
import { interactable, type Interactable } from '../systems/Interaction.js';
import { EXEC, buildExecutionGround } from './Execution.js';

/**
 * 把整座岛装起来。
 *
 * 顺序有讲究：先地形（它决定所有 y），再建筑（往 level 里写碰撞），
 * 最后道具与叙事物（它们要登记可交互物）。静态几何在最后统一合批，
 * 于是整座岛（地形除外）只剩下十来个 draw call。
 */

export interface Island {
  group: Group;
  level: Level;
  mats: MatLib;
  keys: MatKeys;
  /** 需要每帧推进的东西。 */
  animators: Array<(dt: number, elapsed: number) => void>;
  /** 需要单独释放的资源。 */
  tracked: Array<{ dispose(): void }>;
  /** 信徒出生点。 */
  spawns: CultistSpawn[];
  /** 长凳席位。 */
  seats: SeatSpot[];
  props: { hall: PropHandles; vault: PropHandles; yard: PropHandles };
  /** 世界注册的可交互物（由 Game 收进 InteractionSystem）。 */
  interactables: Interactable[];
  /** 场景里的灯（已挂在 group 下）。 */
  lights: Light[];
}

export function buildIsland(mats: MatLib, rnd: Rng): Island {
  const group = new Group();
  group.name = 'island';
  const dynamic = new Group();
  dynamic.name = 'dynamic';
  group.add(dynamic);

  const level = new Level();
  level.terrain = terrainHeight;

  const keys = createMatKeys(mats);
  const b = new Batcher(mats);
  const animators: Island['animators'] = [];
  const tracked: Island['tracked'] = [];
  const interactables: Interactable[] = [];
  const lights: Light[] = [];

  const ctx: BuildCtx = {
    b,
    level,
    M: keys,
    mats,
    rnd,
    dynamic,
    animate: (fn) => {
      animators.push(fn);
    },
    interact: (i) => {
      interactables.push(i);
      return i;
    },
    light: (l) => {
      lights.push(l);
      return l;
    },
    track: (res) => {
      tracked.push(res);
      return res;
    },
  };

  // ── 地形与海 ─────────────────────────────────────────
  group.add(buildTerrain(ctx));
  group.add(buildSea(ctx));

  // ── 自然景物 ─────────────────────────────────────────
  buildNature(ctx);
  buildDock(ctx);
  buildBackdrop(ctx);
  buildSurf(ctx);

  // ── 建筑壳体 ─────────────────────────────────────────
  buildHallShell(ctx);
  buildVaultShell(ctx);
  buildYardShell(ctx);
  buildStairs(ctx);

  // ── 刑场（岛外的一块孤立场地，靠雾与硬切把它和岛分开） ──
  buildExecutionGround(ctx);

  // ── 道具与叙事物 ─────────────────────────────────────
  const hall = buildHallProps(ctx);
  const vault = buildVaultProps(ctx);
  const yard = buildYardProps(ctx);

  // 后山铁门：剧情没走到就打不开
  ctx.interact(
    interactable({
      id: 'vault-door',
      x: 9.8,
      y: PLATEAU_Y + 1.2,
      z: VAULT.z1 + 0.6,
      radius: 3.2,
      label: '推开铁门',
      onInteract: (game) => {
        if (game.flag('vault-open')) {
          game.say('门开着。里面还是那股味道。', { narr: true });
          return;
        }
        if (!game.flag('allowed-backstage')) {
          game.audio.metalDoor();
          game.say('上了锁。', { narr: true });
          return;
        }
        game.audio.metalDoor();
        game.flag('vault-open', true);
        game.say('他推开了那扇门。里面不是仓库。', { narr: true });
        game.objective('走下去看看');
      },
    }),
  );

  // ── 信徒出生点 ───────────────────────────────────────
  const spawns: CultistSpawn[] = [];

  // 院子门口迎客的师姐，不参与礼厅那场戏
  spawns.push({
    x: -3.0,
    z: 21.5,
    yaw: Math.PI,
    role: 'elder',
    name: '师姐',
    seated: false,
    courage: 1,
    lookIndex: 1,
    lines: {
      frozen: ['师兄，第一次来吧。', '把东西放在这里就好。', '心诚，就什么都放得下。'],
      flee: ['你会遭报应的。'],
    },
  });

  // 大门口扫地的人。你进门的时候他在扫地，没有抬头。
  spawns.push({
    x: 4.4,
    z: 23.4,
    yaw: -Math.PI * 0.62,
    role: 'sweeper',
    name: '扫地的',
    seated: false,
    courage: 0.9,
    lookIndex: 3,
    scale: 0.98,
    lines: {
      frozen: ['……', '尘是扫不完的。', '扫地就是扫心。'],
      flee: ['别过来。'],
    },
  });

  // 礼厅里弹吉他唱歌的人。整场戏的背景音就是他。
  // 位置必须落在地板上：讲台只到 x∈[-6,6]、z∈[-18,-13]，
  // 之前给的是 (-8.6, -11.6) —— 已经出了讲台，他就那样悬在离地半米的地方。
  spawns.push({
    x: -8.8,
    z: -11.2,
    y: PLATEAU_Y,
    yaw: -2.45,
    role: 'singer',
    name: '唱歌的',
    seated: true,
    courage: 0.5,
    lookIndex: 0,
    scale: 0.96,
    reactionOffset: 1.2,
    lines: {
      frozen: [
        '天地为证，放下就轻了。',
        '跟着我唱，不要想。',
        '念到心里什么都不剩。',
        '感谢天地。',
      ],
      flee: ['我不唱了。'],
    },
  });

  // 礼厅：每两排坐四个人，都靠过道
  for (const seat of hall.seats) {
    spawns.push({
      x: seat.x,
      z: seat.z,
      yaw: seat.yaw,
      seated: true,
      courage: rnd.range(0.15, 0.85),
      reactionOffset: rnd.range(0, 2.6),
      lookIndex: rnd.int(0, 3),
      scale: rnd.range(0.94, 1.06),
    });
  }

  // 尊者：站在讲台最前沿。不坐、不跑、不劝。他只是看着你。
  // 位置故意压到台口，正对大门——从门口走进来的第一眼就该是他。
  spawns.push({
    x: 0,
    z: -13.6,
    y: PLATEAU_Y + 0.5,
    yaw: 0,
    role: 'idol',
    name: '尊者',
    seated: false,
    courage: 1,
    lookIndex: 2,
    scale: 1.08,
    lines: {
      frozen: [
        '你也是来求道的。',
        '你病了。眼睛里都是灰。',
        '把枪放下。我们一起念。',
        '你打不开这个结的，陈先生。',
      ],
    },
  });

  // ── 码头上等他的警察（自首那场戏） ───────────────────
  // 站在岸边，脸朝着海。玩家从码头上走下来的时候，他们不动。
  const policeLine: Array<[number, number, number]> = [
    [-6.2, 0.15, 97.5],
    [-3.8, 0.15, 96.4],
    [-1.4, 0.15, 96.0],
    [1.4, 0.15, 96.0],
    [3.8, 0.15, 96.4],
    [6.2, 0.15, 97.5],
    [-2.6, 0.15, 92.6],
    [2.6, 0.15, 92.6],
  ];
  for (const [px, py, pz] of policeLine) {
    spawns.push({
      x: px,
      z: pz,
      y: py,
      yaw: Math.PI,
      role: 'police',
      look: POLICE_LOOK,
      seated: false,
      courage: 1,
      scale: 1.02,
      cap: true,
      hidden: true,
    });
  }

  // ── 刑场上的法警 ─────────────────────────────────────
  const execGuards: Array<[number, number]> = [
    [EXEC.x - 4.5, EXEC.z + 6],
    [EXEC.x - 1.5, EXEC.z + 6],
    [EXEC.x + 1.5, EXEC.z + 6],
    [EXEC.x + 4.5, EXEC.z + 6],
  ];
  for (const [px, pz] of execGuards) {
    spawns.push({
      x: px,
      z: pz,
      y: 0,
      yaw: 0,
      role: 'police',
      look: POLICE_LOOK,
      seated: false,
      courage: 1,
      scale: 1.02,
      cap: true,
      hidden: true,
    });
  }

  // ── 合批 ─────────────────────────────────────────────
  group.add(b.build('island-static'));
  for (const l of lights) group.add(l);

  return {
    group,
    level,
    mats,
    keys,
    animators,
    tracked,
    spawns,
    seats: hall.seats,
    props: { hall, vault, yard },
    interactables,
    lights,
  };
}

/** 递归释放整棵树里的几何与材质。 */
export function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as { geometry?: BufferGeometry; material?: Material | Material[] };
    mesh.geometry?.dispose?.();
    const m = mesh.material;
    if (Array.isArray(m)) for (const mm of m) mm.dispose();
    else m?.dispose?.();
  });
}
