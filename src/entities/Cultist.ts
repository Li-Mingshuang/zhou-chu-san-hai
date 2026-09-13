import { Vector3, type Object3D } from 'three';
import { clamp, damp, dampAngle } from '../core/MathUtils.js';
import type { GameCtx } from '../core/GameTypes.js';
import { Ev } from '../core/EventBus.js';
import { CULTIST_LOOKS, HumanoidFactory, addCap, type Humanoid, type HumanoidLook } from './Humanoid.js';
import { makeBroom, makeGuitar } from '../world/HandProps.js';
import type { RayHit } from '../systems/Ballistics.js';
import { HALL } from '../world/Layout.js';

/**
 * 信徒。
 *
 * 设计上他们不是敌人——没有血量、不会攻击、不掉东西。
 * 他们只有三种反应：走过来劝你、跪下去念、或者跑掉。
 * 你完全可以选择一个都不开枪，那是合法通关路径，结局文本不一样。
 */

export type CultistState =
  /** 坐在长凳上。 */
  | 'seated'
  /** 站起来，伸手向你走来。 */
  | 'exhort'
  /** 跪回原位，闭眼。 */
  | 'kneel'
  /** 尖叫着跑出礼厅。 */
  | 'flee'
  /** 僵在原地，发抖。 */
  | 'frozen'
  /** 倒地。 */
  | 'down';

export type CultistRole = 'follower' | 'elder' | 'idol' | 'police' | 'sweeper' | 'singer';

export interface CultistSpawn {
  x: number;
  z: number;
  y?: number;
  /** 面朝方向（0 = 朝北 / -Z）。 */
  yaw?: number;
  lookIndex?: number;
  look?: HumanoidLook;
  /** 一开始坐在长凳上。 */
  seated?: boolean;
  /** 按状态分组的台词。 */
  lines?: Partial<Record<CultistState, string[]>>;
  role?: CultistRole;
  name?: string;
  /** 0..1，越高越敢留下劝你。 */
  courage?: number;
  /** 反应延迟偏移（秒），用来把整场戏排成波次。 */
  reactionOffset?: number;
  scale?: number;
  /** 戴大檐帽（警察／法警）。 */
  cap?: boolean;
  /** 一开始就藏起来，等剧本点名再出现（警察在自首那场才登场）。 */
  hidden?: boolean;
}

const WALK_SPEED = 1.15;
const FLEE_SPEED = 3.4;

/** 逃跑路线：正门 → 前院 → 大门 → 石阶 → 山径。 */
const FLEE_ROUTE: Array<[number, number]> = [
  [0, 9.6],
  [0, 16],
  [0, 25],
  [0, 34],
  [0, 44],
  [0, 58],
];

const DEFAULT_LINES: Partial<Record<CultistState, string[]>> = {
  exhort: [
    '师兄，把枪放下。',
    '你也是来修行的。',
    '这里没有坏人，师兄。',
    '不要这样。求你了。',
    '你会好的，放下枪就好了。',
  ],
  kneel: ['感谢天地。', '感谢天地。', '感谢天地。'],
  flee: ['让我出去！', '不要——', '救命！'],
  frozen: ['……', '师兄？'],
};

let cultistCounter = 0;

export class Cultist {
  readonly id: string;
  readonly position = new Vector3();
  readonly height: number;
  radius = 0.34;
  alive = true;
  state: CultistState;
  /** 已经跑出这一章（不再更新、不再被算作场内的人）。 */
  retired = false;
  readonly role: CultistRole;
  readonly name: string;
  readonly humanoid: Humanoid;

  private readonly lines: Partial<Record<CultistState, string[]>>;
  private readonly courage: number;
  private readonly reactionOffset: number;
  private readonly seat: Vector3;
  private readonly seatYaw: number;
  private readonly vel = new Vector3();
  private routeIndex = 0;
  private walkPhase = 0;
  private terror = 0;
  private pendingReaction = 0;
  private armedReaction = false;
  private speechTimer = 0;
  private lineIndex = 0;
  private fallT = 0;
  private fallDir = 0;
  private tremble = 0;
  private readonly tmp = new Vector3();

  constructor(spawn: CultistSpawn, factory: HumanoidFactory, mats?: import('../render/Mats.js').MatLib) {
    this.id = `cultist-${cultistCounter++}`;
    const look =
      spawn.look ?? CULTIST_LOOKS[(spawn.lookIndex ?? cultistCounter) % CULTIST_LOOKS.length]!;
    this.humanoid = factory.make(look, { full: false, scale: spawn.scale ?? 1 });
    if (spawn.cap && mats) addCap(this.humanoid, mats);
    this.height = this.humanoid.height;
    this.role = spawn.role ?? 'follower';
    this.name = spawn.name ?? '';
    this.lines = { ...DEFAULT_LINES, ...(spawn.lines ?? {}) };
    this.courage = spawn.courage ?? 0.4;
    this.reactionOffset = spawn.reactionOffset ?? 0;
    this.state = spawn.seated ? 'seated' : 'frozen';

    const y = spawn.y ?? HALL.floor;
    this.position.set(spawn.x, y, spawn.z);
    this.seat = new Vector3(spawn.x, y, spawn.z);
    this.seatYaw = spawn.yaw ?? 0;

    this.humanoid.root.position.copy(this.position);
    this.humanoid.root.rotation.y = this.seatYaw;
    if (this.state === 'seated') this.humanoid.sit();
    if (spawn.hidden) this.humanoid.setVisible(false);
    this.hidden = spawn.hidden ?? false;

    // 手里拿着的东西：门口那把扫帚，礼厅里那把吉他
    if (mats) {
      if (this.role === 'sweeper') this.humanoid.hold('torso', makeBroom(mats));
      if (this.role === 'singer') this.humanoid.hold('torso', makeGuitar(mats));
    }
  }

  /** 扫地与弹唱各自的相位。 */
  private idlePhase = Math.random() * 6.28;

  /** 剧本点名时才出现（警察）。 */
  hidden = false;

  /** 让整批人一起显形。 */
  reveal(): void {
    this.hidden = false;
    this.visible = true;
    this.humanoid.setVisible(true);
  }

  /** 是否在渲染距离内。 */
  visible = true;

  attach(parent: Object3D): void {
    parent.add(this.humanoid.root);
    this.humanoid.setVisible(!this.hidden);
  }

  setVisible(v: boolean): void {
    this.humanoid.setVisible(v && !this.hidden);
  }

  detach(): void {
    this.humanoid.root.removeFromParent();
  }

  /** 让他彻底离开这一章（不再更新、不再被算作场内的人）。 */
  retire(): void {
    this.retired = true;
    this.detach();
  }

  /** 枪被拔出来时：有人站起来，有人立刻开始念。 */
  onGunDrawn(game: GameCtx): void {
    if (!this.alive || this.role === 'idol' || this.role === 'police' || this.armedReaction) return;
    if (this.state !== 'seated' && this.state !== 'frozen') return;
    this.armedReaction = true;
    this.queueReaction(0.45 + this.reactionOffset * 0.7);
    void game;
  }

  /** 有人倒下了：附近的重新做一次决定，越近越慌。 */
  onNeighborDown(distance: number): void {
    if (!this.alive || this.role === 'idol' || this.role === 'police' || this.retired) return;
    const close = clamp(1 - distance / 6.5, 0, 1);
    this.terror = clamp(this.terror + 0.3 + close * 0.55, 0, 1.3);
    if (this.state === 'flee' || this.state === 'down') return;
    this.queueReaction(0.12 + Math.random() * Math.max(0.25, 1.5 - this.terror));
  }

  private queueReaction(delay: number): void {
    if (this.pendingReaction <= 0) this.pendingReaction = delay;
    else this.pendingReaction = Math.min(this.pendingReaction, delay);
  }

  /** 按恐怖程度与胆量抽一个新状态。 */
  private decide(game: GameCtx): void {
    if (this.role === 'idol') {
      this.setState('frozen', game);
      return;
    }
    const t = this.terror;
    const roll = Math.random();
    const fleeChance = clamp(0.14 + t * 0.6 - this.courage * 0.45, 0.04, 0.9);
    const kneelChance = clamp(0.3 + this.courage * 0.34 - t * 0.16, 0.08, 0.72);
    if (roll < fleeChance) {
      this.routeIndex = 0;
      this.setState('flee', game);
    } else if (roll < fleeChance + kneelChance) {
      this.setState('kneel', game);
    } else {
      this.setState('exhort', game);
    }
    this.terror = clamp(this.terror + 0.12, 0, 1.3);
  }

  setState(s: CultistState, game: GameCtx): void {
    if (this.state === s) return;
    this.state = s;
    this.speechTimer = Math.random() * 1.8;
    this.lineIndex = 0;

    if (s === 'kneel') this.humanoid.kneel();
    else if (s === 'seated') this.humanoid.sit();
    else if (s === 'frozen') {
      this.humanoid.reset();
      this.humanoid.root.rotation.set(0, this.seatYaw, 0);
    } else {
      this.humanoid.reset();
    }

    if (s === 'flee' || s === 'exhort') {
      game.bus.emit(Ev.CultistStateChange, { cultist: this, state: s });
    }
  }

  /** 中弹。返回是否因此倒下。 */
  onShot(game: GameCtx, hit: RayHit, _zone: 'head' | 'chest' | 'gut' | 'leg'): boolean {
    if (!this.alive) return false;
    this.alive = false;
    this.state = 'down';
    this.fallT = 0;
    const dx = this.position.x - hit.x;
    const dz = this.position.z - hit.z;
    this.fallDir = Math.atan2(-dx, -dz);
    this.vel.set(0, 0, 0);
    game.audio.bodyFall();
    game.bus.emit(Ev.CultistDie, { cultist: this });
    return true;
  }

  private speak(game: GameCtx): void {
    // 分镜截图模式下不要抢台词，否则每张图都会被同一句字幕污染
    if (game.params.scripted) return;
    // 隔着半座道场的人不该被听见
    if (this.distanceTo(game.player.position) > 16) return;
    const pool = this.lines[this.state];
    if (!pool || pool.length === 0) return;
    if (game.ui.subtitleBusy) return;
    const line = pool[this.lineIndex % pool.length]!;
    this.lineIndex++;
    game.say(line, this.name ? { who: this.name } : undefined);
  }

  update(dt: number, game: GameCtx): void {
    if (this.retired) return;

    // 警察／法警：只站着。不劝、不跪、不跑、不说话。
    if (this.role === 'police') {
      this.humanoid.root.position.copy(this.position);
      this.humanoid.root.rotation.set(0, this.seatYaw, 0);
      return;
    }

    // 扫地的与弹吉他唱歌的：在事没闹大之前，他们一直在做自己的事。
    // 这正是"新心灵舍"最日常、也最让人不安的地方——你进门的时候，
    // 有人在扫地，有人在唱歌，没有人抬头。
    if (
      (this.role === 'sweeper' || this.role === 'singer') &&
      (this.state === 'frozen' || this.state === 'seated')
    ) {
      this.idlePhase += dt * (this.role === 'singer' ? 3.1 : 0.85);
      this.humanoid.root.position.copy(this.position);
      this.humanoid.root.rotation.set(0, this.seatYaw, 0);
      if (this.role === 'singer') this.humanoid.strum(this.idlePhase);
      else this.humanoid.sweep(this.idlePhase);

      this.speechTimer -= dt;
      if (this.speechTimer <= 0) {
        this.speechTimer = (this.role === 'singer' ? 4.5 : 7) + Math.random() * 6;
        this.speak(game);
      }
      return;
    }

    // 第一声枪响之后，整场戏分波次炸开
    if (this.state === 'down') {
      this.fallT = Math.min(1, this.fallT + dt * 2.1);
      this.humanoid.fall(this.fallDir, this.fallT);
      return;
    }

    if (game.shotsFired > 0 && !this.armedReaction && this.role !== 'idol') {
      this.armedReaction = true;
      this.queueReaction(0.1 + this.reactionOffset);
    }

    if (this.pendingReaction > 0) {
      this.pendingReaction -= dt;
      if (this.pendingReaction <= 0) {
        this.pendingReaction = 0;
        this.decide(game);
      }
    }

    this.speechTimer -= dt;
    if (this.speechTimer <= 0 && this.state !== 'seated') {
      this.speechTimer = 2.8 + Math.random() * 6;
      this.speak(game);
    }

    switch (this.state) {
      case 'seated':
      case 'kneel': {
        this.humanoid.root.rotation.y = dampAngle(this.humanoid.root.rotation.y, this.seatYaw, 4, dt);
        this.humanoid.root.rotation.z = 0;
        this.humanoid.root.position.copy(this.position);
        break;
      }

      case 'frozen': {
        this.tremble += dt * 22;
        this.humanoid.reset();
        this.humanoid.root.rotation.y = dampAngle(this.humanoid.root.rotation.y, this.seatYaw, 5, dt);
        this.humanoid.root.rotation.z = Math.sin(this.tremble) * 0.014 * (0.4 + this.terror);
        this.humanoid.root.position.copy(this.position);
        this.humanoid.root.position.y += Math.sin(this.tremble * 1.7) * 0.006;
        break;
      }

      case 'exhort': {
        const dx = game.player.position.x - this.position.x;
        const dz = game.player.position.z - this.position.z;
        const dist = Math.hypot(dx, dz);
        const want = Math.atan2(-dx, -dz);
        this.humanoid.root.rotation.y = dampAngle(this.humanoid.root.rotation.y, want, 3.2, dt);
        if (dist > 1.9) {
          this.step(dt, game, dx / Math.max(1e-4, dist), dz / Math.max(1e-4, dist), WALK_SPEED, true);
        } else {
          this.vel.multiplyScalar(Math.exp(-6 * dt));
          this.walkPhase += dt * 1.2;
          this.humanoid.pose(this.walkPhase, 0.05);
        }
        this.humanoid.reach(clamp(1 - dist / 5, 0.25, 1));
        break;
      }

      case 'flee': {
        const target = FLEE_ROUTE[Math.min(this.routeIndex, FLEE_ROUTE.length - 1)]!;
        const dx = target[0] - this.position.x;
        const dz = target[1] - this.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1.8 && this.routeIndex < FLEE_ROUTE.length - 1) this.routeIndex++;
        const want = Math.atan2(-dx, -dz);
        this.humanoid.root.rotation.y = dampAngle(this.humanoid.root.rotation.y, want, 7, dt);
        this.step(dt, game, dx / Math.max(1e-4, dist), dz / Math.max(1e-4, dist), FLEE_SPEED, false);
        this.humanoid.pose(this.walkPhase, 1.3, 0.14);
        if (this.position.z > 50) {
          this.detach();
          this.retired = true;
          game.bus.emit(Ev.CultistStateChange, { cultist: this, state: 'escaped' });
        }
        break;
      }

      default:
        break;
    }
  }

  private step(
    dt: number,
    game: GameCtx,
    dx: number,
    dz: number,
    speed: number,
    allowAvoid: boolean,
  ): void {
    let mx = dx;
    let mz = dz;
    if (allowAvoid) {
      const probe = 0.95;
      const blocked = (nx: number, nz: number): boolean =>
        game.level.occupied(
          this.position.x + nx * probe,
          this.position.y,
          this.position.z + nz * probe,
          this.radius + 0.1,
          this.height,
        );
      if (blocked(mx, mz)) {
        const a = Math.atan2(mx, mz);
        let found = false;
        for (const off of [0.6, -0.6, 1.2, -1.2, Math.PI / 2, -Math.PI / 2]) {
          const nx = Math.sin(a + off);
          const nz = Math.cos(a + off);
          if (!blocked(nx, nz)) {
            mx = nx;
            mz = nz;
            found = true;
            break;
          }
        }
        if (!found) {
          mx = 0;
          mz = 0;
        }
      }
    }

    this.vel.x = damp(this.vel.x, mx * speed, 6, dt);
    this.vel.z = damp(this.vel.z, mz * speed, 6, dt);
    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.z * dt;
    game.level.resolve(this.position, this.radius, this.height);
    this.position.y = game.level.groundAt(this.position.x, this.position.z, this.position.y);

    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase += dt * (4.4 + sp * 1.6);
    if (allowAvoid) this.humanoid.pose(this.walkPhase, clamp(sp / 2.4, 0, 1.4), 0);
    this.humanoid.root.position.copy(this.position);
  }

  /** 回到座位上，用于分镜重置。 */
  reset(): void {
    this.position.copy(this.seat);
    this.humanoid.root.position.copy(this.seat);
    this.humanoid.root.rotation.set(0, this.seatYaw, 0);
    this.humanoid.root.visible = true;
    this.humanoid.sit();
    this.state = 'seated';
    this.alive = true;
    this.retired = false;
    this.terror = 0;
    this.pendingReaction = 0;
    this.armedReaction = false;
    this.fallT = 0;
    this.vel.set(0, 0, 0);
    this.routeIndex = 0;
    this.speechTimer = Math.random() * 2;
  }

  distanceTo(v: Vector3): number {
    return this.tmp.copy(this.position).sub(v).length();
  }
}

/** 场上还站着的（含跪着与坐在原位的）信徒人数。警察不算。 */
export function remainingCount(list: readonly Cultist[]): number {
  let n = 0;
  for (const c of list) {
    if (!c.alive || c.retired || c.state === 'down') continue;
    if (c.role === 'police') continue;
    n++;
  }
  return n;
}
