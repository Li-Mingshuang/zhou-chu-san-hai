import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, damp, easeInOutCubic } from '../core/MathUtils.js';
import type { GameCtx } from '../core/GameTypes.js';
import { HALL } from '../world/Layout.js';

/**
 * 视角导演。
 *
 * 这是本作最想做的事：镜头经常不是你。
 * 你可以按电影的方式把玩家推上过肩位、俯视位、侧位——
 * 因为他正在做的事，本来就该被人看着。
 *
 * 切换时不是硬切：把当前姿态冻结成 from，向新模式每帧实时算出的目标插值，
 * 配合 0.35s 的时间拉伸，于是"视角变了"这件事本身有重量。
 */

export type CameraModeId = 'fps' | 'topdown' | 'side' | 'cinematic';

export interface CinematicShot {
  /** 机位起止（世界坐标）。单点时 from 与 to 相同。 */
  from: [number, number, number];
  to?: [number, number, number];
  /** 注视点起止；'player' 表示持续跟随玩家。 */
  look?: [number, number, number] | 'player';
  lookFrom?: [number, number, number];
  lookTo?: [number, number, number];
  /** 时长（秒）。 */
  duration: number;
  fov?: number;
  /** 手持漂移幅度（米）。 */
  drift?: number;
  /** 进入这一镜时压黑一瞬（硬切的替代）。 */
  flash?: number;
  /** 这一镜的字幕。 */
  caption?: string;
  /** 字幕是否按旁白处理。 */
  narr?: boolean;
}

export interface TopDownOpts {
  /** 相机离地高度。 */
  height: number;
  /** 俯角（弧度，自水平面起算）。 */
  pitch: number;
  /** 跟随的惯性（越大越跟手）。 */
  lag: number;
  /** 视线前瞻距离：镜头看向玩家前方多远。 */
  lead: number;
  fov: number;
  /** 速度越快镜头拉得越高。 */
  heightBySpeed: number;
  /**
   * 俯视模式下"W 是哪个方向"的世界偏航。
   * 0 = 朝北(-Z)，π = 朝南(+Z)。逃跑段要往山下（+Z）走，所以设成 π，
   * 这样屏幕上"往上"就是他要去的方向。
   */
  forwardYaw: number;
}

export interface SideOpts {
  /** 玩家沿哪条轴移动。 */
  axis: 'x' | 'z';
  /** 相机放在玩家的哪一侧（+1 / -1）。决定屏幕上的"前进方向"。 */
  side: 1 | -1;
  /** 侧向距离（米）。 */
  distance: number;
  /** 高度。 */
  height: number;
  /** 注视点相对玩家脚底的高度。 */
  lookHeight: number;
  fov: number;
  lag: number;
}

export class CameraDirector {
  mode: CameraModeId = 'fps';
  /** 模式切换的通知（用于黑边、HUD、控制方案）。 */
  onModeChange: ((next: CameraModeId, prev: CameraModeId) => void) | null = null;

  topdown: TopDownOpts = {
    height: 15,
    pitch: 1.08,
    lag: 3.6,
    lead: 4.5,
    fov: 50,
    heightBySpeed: 0.55,
    forwardYaw: Math.PI,
  };

  side: SideOpts = {
    axis: 'z',
    side: -1,
    distance: 9.5,
    height: 2.1,
    lookHeight: 1.0,
    fov: 36,
    lag: 3.2,
  };

  private blend = 1;
  private blendDur = 0;
  private readonly fromPos = new Vector3();
  private readonly fromQuat = new Quaternion();
  private fromFov = 70;

  private readonly camPos = new Vector3();
  private readonly camQuat = new Quaternion();
  private camFov = 70;

  private readonly targetPos = new Vector3();
  private readonly targetQuat = new Quaternion();
  private targetFov = 70;

  private readonly shakeOffset = new Vector3();
  private shakeAmp = 0;
  private shakeDecay = 3;

  // 俯视跟随状态
  private readonly tdPos = new Vector3();
  private readonly tdLook = new Vector3();
  private tdYaw = 0;
  private tdInit = false;

  // 侧视跟随状态
  private readonly sdPos = new Vector3();

  // 电影镜头
  private shots: CinematicShot[] = [];
  private shotIndex = 0;
  private shotTime = 0;
  private shotsDone: (() => void) | null = null;
  private returnTo: CameraModeId | null = 'fps';
  private lastCaption = '';

  private readonly m4 = new Matrix4();
  private readonly up = new Vector3(0, 1, 0);
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpC = new Vector3();
  private readonly tmpQ = new Quaternion();
  private readonly tmpE = new Euler(0, 0, 0, 'YXZ');
  /** 第一人称基础视场角。 */
  fpsFov = 72;

  constructor(private readonly camera: PerspectiveCamera) {
    this.camFov = camera.fov;
    this.targetFov = camera.fov;
    this.fromFov = camera.fov;
  }

  get isBlending(): boolean {
    return this.blend < 1;
  }

  get cinematicTime(): number {
    return this.shotTime;
  }

  get cinematicDone(): boolean {
    return this.mode === 'cinematic' && this.shotIndex >= this.shots.length;
  }

  /** 切镜。fade 为过渡秒数（0 = 硬切）。 */
  setMode(next: CameraModeId, fade = 0.38, game?: GameCtx): void {
    if (next === this.mode) return;
    const prev = this.mode;
    this.captureFrom();
    this.mode = next;
    this.blendDur = fade;
    this.blend = fade > 0 ? 0 : 1;
    this.tdInit = false;
    if (game) game.player.control = controlOf(next);
    this.onModeChange?.(next, prev);
  }

  private captureFrom(): void {
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.fromFov = this.camera.fov;
  }

  /**
   * 播放一段电影镜头。玩家在此期间失去控制。
   * returnTo 不为 null 时，最后一镜结束后自动切回该模式。
   */
  playShots(
    shots: CinematicShot[],
    game?: GameCtx,
    returnTo: CameraModeId | null = 'fps',
  ): Promise<void> {
    this.shots = shots;
    this.shotIndex = 0;
    this.shotTime = 0;
    this.lastCaption = '';
    this.returnTo = returnTo;
    this.setMode('cinematic', 0.5, game);
    return new Promise((resolve) => {
      this.shotsDone = resolve;
    });
  }

  /** 立刻摆一个定格机位（分镜截图模式用）。 */
  setPose(pos: [number, number, number], look: [number, number, number], fov?: number): void {
    this.mode = 'cinematic';
    this.blend = 1;
    this.camPos.set(pos[0], pos[1], pos[2]);
    this.lookQuat(this.camPos, this.tmpA.set(look[0], look[1], look[2]), this.camQuat);
    this.camFov = fov ?? this.camFov;
    this.shots = [];
    this.shotIndex = 0;
    this.apply();
  }

  shake(amount: number, seconds = 0.3): void {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
    this.shakeDecay = 1 / Math.max(0.05, seconds);
  }

  update(dt: number, game: GameCtx): void {
    switch (this.mode) {
      case 'fps':
        this.updateFps(game);
        break;
      case 'topdown':
        this.updateTopDown(dt, game);
        break;
      case 'side':
        this.updateSide(dt, game);
        break;
      case 'cinematic':
        this.updateCinematic(dt, game);
        break;
      default:
        break;
    }

    // 混合
    if (this.blend < 1) {
      this.blendDur = Math.max(1e-4, this.blendDur);
      this.blend = Math.min(1, this.blend + dt / this.blendDur);
      const t = easeInOutCubic(this.blend);
      this.camPos.copy(this.fromPos).lerp(this.targetPos, t);
      this.camQuat.copy(this.fromQuat).slerp(this.targetQuat, t);
      this.camFov = this.fromFov + (this.targetFov - this.fromFov) * t;
    } else {
      this.camPos.copy(this.targetPos);
      this.camQuat.copy(this.targetQuat);
      this.camFov = this.targetFov;
    }

    // 抖动
    if (this.shakeAmp > 0.0002) {
      const t = game.elapsed * 47;
      this.shakeOffset.set(
        Math.sin(t * 1.13) * 0.6 + Math.sin(t * 2.7) * 0.4,
        Math.sin(t * 1.61 + 1.7) * 0.6 + Math.sin(t * 3.3 + 0.4) * 0.4,
        Math.sin(t * 0.97 + 3.1) * 0.5,
      );
      const a = this.shakeAmp * (game.settings.data.shake ? 1 : 0);
      this.camPos.addScaledVector(this.shakeOffset, a * 0.09);
      this.tmpA.set(
        this.shakeOffset.y * a * 0.012,
        this.shakeOffset.x * a * 0.014,
        this.shakeOffset.z * a * 0.02,
      );
      this.camQuat.multiply(this.tmpQ.setFromEuler(this.tmpE.set(this.tmpA.x, this.tmpA.y, this.tmpA.z, 'YXZ')));
      this.shakeAmp = Math.max(0, this.shakeAmp - this.shakeDecay * this.shakeAmp * dt * 3.2 - dt * 0.15);
    }

    this.apply();
  }

  private apply(): void {
    this.camera.position.copy(this.camPos);
    this.camera.quaternion.copy(this.camQuat);
    if (Math.abs(this.camera.fov - this.camFov) > 0.01) {
      this.camera.fov = this.camFov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private lookQuat(eye: Vector3, target: Vector3, out: Quaternion): Quaternion {
    this.m4.lookAt(eye, target, this.up);
    return out.setFromRotationMatrix(this.m4);
  }

  // ── 第一人称 ─────────────────────────────────────────────
  private updateFps(game: GameCtx): void {
    const eye = game.player.getEyePosition(this.tmpA);
    this.targetPos.copy(eye);
    game.player.getViewQuaternion(this.targetQuat);
    const aiming = game.pistol.aiming;
    const running = game.player.running;
    this.targetFov = this.fpsFov + (aiming ? -12 : 0) + (running ? 4 : 0);
  }

  // ── 俯视跑步 ─────────────────────────────────────────────
  private updateTopDown(dt: number, game: GameCtx): void {
    const p = game.player.position;
    const v = game.player.velocity;
    const speed = Math.hypot(v.x, v.z);

    if (!this.tdInit) {
      this.tdPos.copy(this.camera.position);
      this.tdLook.copy(p);
      // 从玩家当前朝向起步，否则切镜那一瞬间镜头会以为他要往回跑
      this.tdYaw = game.player.facing;
      this.lastYaw = this.tdYaw;
      this.tdInit = true;
    }

    // 朝向：优先用速度方向，站住时保持上一次
    let dirX = 0;
    let dirZ = 0;
    if (speed > 0.35) {
      dirX = v.x / speed;
      dirZ = v.z / speed;
      this.tdYaw = Math.atan2(-dirX, -dirZ);
    } else {
      dirX = -Math.sin(this.tdYaw);
      dirZ = -Math.cos(this.tdYaw);
    }

    const o = this.topdown;
    const height = o.height + speed * o.heightBySpeed;
    const back = height / Math.tan(o.pitch);

    // 看向玩家前方 lead 米处，相机在其后上方 —— 于是你看得见你要去的地方
    this.tmpB.set(p.x + dirX * o.lead, p.y + 0.6, p.z + dirZ * o.lead);
    this.tmpC.set(this.tmpB.x - dirX * back, p.y + height, this.tmpB.z - dirZ * back);

    this.tdPos.x = damp(this.tdPos.x, this.tmpC.x, o.lag, dt);
    this.tdPos.y = damp(this.tdPos.y, this.tmpC.y, o.lag * 0.7, dt);
    this.tdPos.z = damp(this.tdPos.z, this.tmpC.z, o.lag, dt);
    this.tdLook.x = damp(this.tdLook.x, this.tmpB.x, o.lag * 1.3, dt);
    this.tdLook.y = damp(this.tdLook.y, this.tmpB.y, o.lag, dt);
    this.tdLook.z = damp(this.tdLook.z, this.tmpB.z, o.lag * 1.3, dt);

    // ── 镜头避障 ────────────────────────────────────────
    // 逃跑是从礼厅门口开始的，而镜头在玩家背后——不处理的话它会直接从
    // 屋顶穿出去，玩家看到一片天花板。做法是常规的：从注视点朝理想机位
    // 打一条射线，撞到东西就把镜头拉到撞点前面。
    this.avoidWalls(game);

    this.targetPos.copy(this.tdPos);
    this.lookQuat(this.targetPos, this.tdLook, this.targetQuat);

    // 转弯时镜头轻微侧倾，速度感靠这个
    const turned = this.turnRate(this.tdYaw);
    this.targetQuat.multiply(
      this.tmpQ.setFromAxisAngle(FORWARD, clamp(-turned * 0.28, -0.14, 0.14)),
    );

    this.targetFov = o.fov + speed * 0.9;
  }

  private lastYaw = 0;
  private turnRate(yaw: number): number {
    let d = yaw - this.lastYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.lastYaw = yaw;
    return d * 12;
  }

  /**
   * 把俯视镜头从墙里拉出来，并且不允许它钻到地面以下。
   * 只处理"注视点 → 机位"这一条射线：够用了，而且不会让镜头乱抖。
   */
  private avoidWalls(game: GameCtx): void {
    const from = this.tmpA.set(this.tdLook.x, this.tdLook.y, this.tdLook.z);
    const to = this.tmpB.copy(this.tdPos);
    const delta = this.tmpC.copy(to).sub(from);
    const dist = delta.length();
    if (dist > 0.01) {
      delta.multiplyScalar(1 / dist);
      const hit = game.level.ray(from, delta, dist, { sight: true });
      if (hit && hit.t < dist - 0.15) {
        const pull = Math.max(1.8, hit.t - 0.35);
        this.tdPos.copy(from).addScaledVector(delta, pull);
      }
    }
    // 贴着山坡跑的时候，镜头不能低于地面
    const floor = game.level.terrain(this.tdPos.x, this.tdPos.z) + 1.6;
    if (this.tdPos.y < floor) this.tdPos.y = floor;
  }

  // ── 横版侧视 ─────────────────────────────────────────────
  private updateSide(dt: number, game: GameCtx): void {
    const p = game.player.position;
    const o = this.side;
    if (!this.tdInit) {
      this.sdPos.copy(this.camera.position);
      this.tdInit = true;
    }
    const along = o.axis === 'x' ? p.x : p.z;
    const lagAlong = o.axis === 'x' ? this.sdPos.x : this.sdPos.z;
    const damped = damp(lagAlong, along, o.lag, dt);

    if (o.axis === 'x') {
      this.sdPos.set(damped, p.y + o.height, p.z + o.distance * o.side);
      this.tmpB.set(damped, p.y + o.lookHeight, p.z);
    } else {
      this.sdPos.set(p.x + o.distance * o.side, p.y + o.height, damped);
      this.tmpB.set(p.x, p.y + o.lookHeight, damped);
    }

    this.targetPos.copy(this.sdPos);
    this.lookQuat(this.targetPos, this.tmpB, this.targetQuat);
    this.targetFov = o.fov;
  }

  // ── 电影镜头 ─────────────────────────────────────────────
  private updateCinematic(dt: number, game: GameCtx): void {
    const shot = this.shots[this.shotIndex];
    if (!shot) {
      this.targetPos.copy(this.camera.position);
      this.targetQuat.copy(this.camera.quaternion);
      return;
    }

    this.shotTime += dt;
    // 一镜的字幕
    if (shot.caption && shot.caption !== this.lastCaption) {
      this.lastCaption = shot.caption;
      game.say(shot.caption, shot.narr ? { narr: true } : undefined);
    }

    const raw = clamp(this.shotTime / Math.max(0.001, shot.duration), 0, 1);
    const t = easeInOutCubic(raw);

    const from = shot.to ? this.tmpA.set(shot.from[0], shot.from[1], shot.from[2]).lerp(
      this.tmpB.set(shot.to[0], shot.to[1], shot.to[2]),
      t,
    ) : this.tmpA.set(shot.from[0], shot.from[1], shot.from[2]);

    const drift = shot.drift ?? 0;
    if (drift > 0) {
      const tt = game.elapsed;
      from.x += Math.sin(tt * 0.62) * drift;
      from.y += Math.sin(tt * 0.83 + 1.1) * drift * 0.6;
      from.z += Math.cos(tt * 0.55 + 2.3) * drift;
    }
    this.targetPos.copy(from);

    if (shot.look === 'player') {
      const p = game.player.position;
      const eye = game.player.eyeHeight;
      this.tmpC.set(p.x, p.y + eye * 0.86, p.z);
    } else if (shot.lookFrom || shot.lookTo) {
      const a = shot.lookFrom ?? shot.lookTo ?? [0, 0, 0];
      const b = shot.lookTo ?? shot.lookFrom ?? [0, 0, 0];
      this.tmpC.set(a[0], a[1], a[2]).lerp(this.tmpB.set(b[0], b[1], b[2]), t);
    } else if (Array.isArray(shot.look)) {
      this.tmpC.set(shot.look[0], shot.look[1], shot.look[2]);
    } else {
      this.tmpC.set(0, HALL.floor + 1.6, 0);
    }
    this.lookQuat(this.targetPos, this.tmpC, this.targetQuat);
    this.targetFov = shot.fov ?? 42;

    if (this.shotTime >= shot.duration) {
      this.shotIndex++;
      this.shotTime = 0;
      this.lastCaption = '';
      const next = this.shots[this.shotIndex];
      if (next?.flash !== undefined && next.flash > 0 && game) {
        game.renderer.kick(next.flash, 0x000000);
      }
      if (this.shotIndex >= this.shots.length) {
        const done = this.shotsDone;
        this.shotsDone = null;
        const back = this.returnTo;
        this.returnTo = null;
        if (back) this.setMode(back, 0.7, game);
        done?.();
      }
    }
  }
}

function controlOf(mode: CameraModeId): 'fps' | 'topdown' | 'side' | 'none' {
  if (mode === 'fps') return 'fps';
  if (mode === 'topdown') return 'topdown';
  if (mode === 'side') return 'side';
  return 'none';
}

const FORWARD = new Vector3(0, 0, -1);
