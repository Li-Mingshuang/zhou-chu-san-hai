import { Euler, Quaternion, Vector3 } from 'three';
import { clamp, damp, dampAngle } from '../core/MathUtils.js';
import type { GameCtx } from '../core/GameTypes.js';
import { Ev } from '../core/EventBus.js';
import { HALL, PLATEAU_Y, STAIRS, VAULT, YARD, onPath } from '../world/Layout.js';
import type { FootMaterial } from '../audio/AudioEngine.js';

/** 玩家控制方案。由 CameraDirector 在切镜时改写。 */
export type PlayerControl =
  /** 第一人称：鼠标转视角，WASD 相对朝向。 */
  | 'fps'
  /** 俯视跑步：WASD 相对世界轴，角色自动转向移动方向。 */
  | 'topdown'
  /** 横版侧视：只沿一条轴前后。 */
  | 'side'
  /** 完全交给脚本。 */
  | 'none';

const WALK = 2.75;
const RUN = 5.4;
const CROUCH = 1.35;
/** 俯视逃跑时他跑得更快，也更难看。 */
const PANIC_RUN = 6.4;
const GRAVITY = 19;
const SNAP_DOWN = 0.5;

/**
 * 玩家。没有跳跃——这一章不需要，而且"迈不上去"本身就是一种表达。
 * 视角、脚步、呼吸、后坐力都集中在 update() 里，任何镜头模式都复用同一份运动数据。
 */
export class Player {
  /** 脚底位置。 */
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  yaw = 0;
  pitch = 0;

  control: PlayerControl = 'fps';
  /** 脚本接管时为 false（受刑、被按在长凳上）。 */
  inputEnabled = true;
  /** 强制朝向：坐下、被按住、电影镜头里看向指定方向。 */
  lookLock: { yaw: number; pitch: number } | null = null;
  /** 强制跑步（俯视逃跑段）。 */
  forcedRun = false;
  /** 俯视模式下的角色朝向。 */
  facing = 0;

  radius = 0.36;
  standHeight = 1.78;
  crouchHeight = 1.14;
  eyeOffset = 0.14;

  crouching = false;
  running = false;
  onGround = true;
  /** 当前水平速度，供头部摆动、脚步与音频使用。 */
  speed = 0;

  // 视角层
  private bobPhase = 0;
  private bobAmount = 0;
  private stepFlag = false;
  private breathe = 0;
  /** 后坐力：俯仰弹簧。 */
  recoilPitch = 0;
  private recoilVel = 0;
  /** 外部冲击（被击中、受刑、枪口）。 */
  readonly punchPos = new Vector3();
  punchPitch = 0;
  punchYaw = 0;
  private punchPosTarget = new Vector3();
  private punchPitchTarget = 0;
  private punchYawTarget = 0;
  /** 侧倾（横移与俯视转弯时）。 */
  roll = 0;
  private rollTarget = 0;

  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private footMat: FootMaterial = 'dirt';

  get height(): number {
    return this.crouching ? this.crouchHeight : this.standHeight;
  }

  get eyeHeight(): number {
    return this.height - this.eyeOffset;
  }

  teleport(x: number, y: number, z: number, yaw?: number, pitch = 0): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
    this.pitch = pitch;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.recoilPitch = 0;
    this.recoilVel = 0;
    this.punchPos.set(0, 0, 0);
    this.punchPosTarget.set(0, 0, 0);
    this.punchPitch = 0;
    this.punchPitchTarget = 0;
    this.punchYaw = 0;
    this.punchYawTarget = 0;
    this.roll = 0;
    this.rollTarget = 0;
    this.facing = yaw ?? 0;
  }

  /** 看向世界坐标中的一点。 */
  lookAt(x: number, y: number, z: number): void {
    const dx = x - this.position.x;
    const dy = y - (this.position.y + this.eyeHeight);
    const dz = z - this.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -1.45, 1.45);
  }

  /** 后坐力：向上抬，然后靠弹簧回落。 */
  applyRecoil(pitch: number, yaw = 0): void {
    this.recoilVel += pitch * 9;
    this.punchYawTarget += yaw;
  }

  /** 一次性冲击：位置偏移 + 角度偏移，随后自动衰减回零。 */
  punch(px: number, py: number, pz: number, pitch: number, yaw: number): void {
    this.punchPosTarget.x += px;
    this.punchPosTarget.y += py;
    this.punchPosTarget.z += pz;
    this.punchPitchTarget += pitch;
    this.punchYawTarget += yaw;
  }

  getForward(out: Vector3): Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  /** 相机位置：脚底 + 眼高 + 冲击偏移（冲击偏移按朝向旋转，否则转向时会跳）。 */
  getEyePosition(out: Vector3): Vector3 {
    const bob = this.bobAmount * Math.sin(this.bobPhase) * 0.045;
    const sway = this.bobAmount * Math.cos(this.bobPhase * 0.5) * 0.03;
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const px = this.punchPos.x;
    const pz = this.punchPos.z;
    out.set(
      this.position.x + px * cy + pz * sy,
      this.position.y + this.eyeHeight + bob + this.breathe + this.punchPos.y,
      this.position.z - px * sy + pz * cy,
    );
    out.x += cy * sway;
    out.z += -sy * sway;
    return out;
  }

  /** 相机四元数。 */
  getViewQuaternion(out: Quaternion): Quaternion {
    this.euler.set(
      this.pitch + this.recoilPitch + this.punchPitch,
      this.yaw + this.punchYaw,
      this.roll,
      'YXZ',
    );
    return out.setFromEuler(this.euler);
  }

  update(dt: number, game: GameCtx): void {
    const input = game.input;
    const settings = game.settings.data;

    // ── 视角 ──────────────────────────────────────────────
    if (this.control === 'fps' && this.inputEnabled) {
      if (this.lookLock) {
        this.yaw = dampAngle(this.yaw, this.lookLock.yaw, 9, dt);
        this.pitch = damp(this.pitch, this.lookLock.pitch, 9, dt);
      } else if (!game.ui.overlayVisible) {
        const s = settings.sensitivity * 0.0021;
        const inv = settings.invertY ? -1 : 1;
        this.yaw -= input.mouseDX * s;
        this.pitch -= input.mouseDY * s * inv;
        this.pitch = clamp(this.pitch, -1.42, 1.42);
      }
    }

    // ── 移动意图 ──────────────────────────────────────────
    let ix = 0;
    let iz = 0;
    if (this.inputEnabled && this.control !== 'none' && !game.ui.overlayVisible) {
      if (input.down('forward')) iz -= 1;
      if (input.down('back')) iz += 1;
      if (input.down('left')) ix -= 1;
      if (input.down('right')) ix += 1;
    }

    const wantCrouch =
      this.control === 'fps' && this.inputEnabled && input.down('crouch') && this.onGround;
    this.crouching = wantCrouch;

    let wx = 0;
    let wz = 0;
    if (this.control === 'fps') {
      const f = -iz;
      const sy = Math.sin(this.yaw);
      const cy = Math.cos(this.yaw);
      wx = -sy * f + cy * ix;
      wz = -cy * f - sy * ix;
    } else if (this.control === 'topdown') {
      // 世界轴，但按镜头导演给的"前进方向"旋转过：
      // 逃跑段 W 就是往山下跑，屏幕上"往上"= 他要去的地方。
      const a = game.director.topdown.forwardYaw;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      wx = ix * ca - iz * sa;
      wz = ix * sa + iz * ca;
    } else if (this.control === 'side') {
      // 横版：W 就是"画面里的前进方向"，往右走
      const prim = -iz;
      if (game.director.side.axis === 'z') {
        wz = prim;
        wx = 0;
      } else {
        wx = prim;
        wz = 0;
      }
    }

    const mag = Math.hypot(wx, wz);
    if (mag > 1e-4) {
      wx /= mag;
      wz /= mag;
    }

    const wantRun = this.forcedRun || (this.inputEnabled && input.down('run'));
    this.running = wantRun && mag > 1e-4 && !this.crouching;
    const target =
      mag > 1e-4 ? (this.crouching ? CROUCH : this.running ? (this.forcedRun ? PANIC_RUN : RUN) : WALK) : 0;

    const accel = this.onGround ? 13 : 3.5;
    const desiredX = wx * target;
    const desiredZ = wz * target;
    this.velocity.x = damp(this.velocity.x, desiredX, accel, dt);
    this.velocity.z = damp(this.velocity.z, desiredZ, accel, dt);
    if (mag < 1e-4) {
      this.velocity.x = damp(this.velocity.x, 0, 16, dt);
      this.velocity.z = damp(this.velocity.z, 0, 16, dt);
    }

    // ── 垂直 ──────────────────────────────────────────────
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    // 水平推出
    game.level.resolve(this.position, this.radius, this.height);

    const ground = game.level.groundAt(this.position.x, this.position.z, this.position.y);
    if (this.position.y - ground > SNAP_DOWN && this.velocity.y <= 0.01) {
      // 离地：开始下落
      this.velocity.y -= GRAVITY * dt;
      this.position.y += this.velocity.y * dt;
      this.onGround = false;
      if (this.position.y <= ground) {
        this.position.y = ground;
        const impact = -this.velocity.y;
        this.velocity.y = 0;
        this.onGround = true;
        if (impact > 4.5) {
          game.shake(Math.min(0.35, impact * 0.03));
          this.punch(0, -0.1, 0, -0.05, 0);
          game.audio.footstep(this.footMat, 1.4);
        }
      }
    } else {
      // 贴地（含上坡、下坡与台阶）
      this.position.y = ground;
      this.velocity.y = 0;
      this.onGround = true;
    }
    // 掉进海里的兜底
    if (this.position.y < -6) {
      this.position.y = ground;
    }

    // ── 脚步、摆动与呼吸 ──────────────────────────────────
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    const maxSpeed = this.running ? (this.forcedRun ? PANIC_RUN : RUN) : WALK;
    const bobTarget = this.onGround ? clamp(this.speed / maxSpeed, 0, 1) : 0;
    this.bobAmount = damp(this.bobAmount, bobTarget, 7, dt);
    this.bobPhase += dt * (5.6 + this.speed * 1.5);
    this.breathe = Math.sin(game.elapsed * 1.15) * 0.012;

    if (this.speed > 0.4 && this.onGround && this.bobAmount > 0.25) {
      // 每一步的落点是 bobPhase 的整周期
      const phase = this.bobPhase / Math.PI;
      const nowStep = Math.floor(phase) % 2 === 0;
      if (nowStep !== this.stepFlag) {
        this.stepFlag = nowStep;
        this.footMat = footMaterialAt(this.position.x, this.position.z, this.position.y);
        game.audio.footstep(this.footMat, this.running ? 1 : 0.62);
        game.bus.emit(Ev.PlayerBump, { strength: this.bobAmount });
      }
    }

    // ── 视角表现层 ────────────────────────────────────────
    const settingShake = settings.shake ? 1 : 0;

    // 后坐力弹簧
    this.recoilVel -= this.recoilPitch * 130 * dt;
    this.recoilVel *= Math.exp(-13 * dt);
    this.recoilPitch += this.recoilVel * dt;
    this.recoilPitch = clamp(this.recoilPitch, -0.5, 0.5);

    // 冲击回零
    this.punchPos.lerp(this.punchPosTarget, 1 - Math.exp(-12 * dt));
    this.punchPitchTarget = damp(this.punchPitchTarget, 0, 9, dt);
    this.punchYawTarget = damp(this.punchYawTarget, 0, 9, dt);
    this.punchPitch = this.punchPitchTarget * settingShake;
    this.punchYaw = this.punchYawTarget * settingShake;

    // 侧倾：横移与俯视转弯
    if (this.control === 'fps') this.rollTarget = -ix * 0.022 * this.bobAmount;
    else this.rollTarget = 0;
    this.roll = damp(this.roll, this.rollTarget * settingShake, 8, dt);

    // 俯视模式下角色朝向移动方向
    if (this.control === 'topdown') {
      if (mag > 1e-3) {
        const want = Math.atan2(-wx, -wz);
        this.facing = dampAngle(this.facing, want, 11, dt);
      }
      this.yaw = this.facing;
    } else if (this.control === 'side') {
      if (mag > 1e-3) {
        const want = Math.atan2(-wx, -wz);
        this.facing = dampAngle(this.facing, want, 8, dt);
      }
      this.yaw = this.facing;
    }
  }

  /** 当前所在的脚步材质（供音频预判）。 */
  get footMaterial(): FootMaterial {
    return footMaterialAt(this.position.x, this.position.z, this.position.y);
  }
}

/** 按位置判断踩在什么上。室内是木地板，院子是夯土，坡道是石头。 */
export function footMaterialAt(x: number, z: number, y: number): FootMaterial {
  if (y > PLATEAU_Y - 1.5) {
    if (x > HALL.x0 && x < HALL.x1 && z > HALL.z0 && z < HALL.z1) return 'wood';
    if (x > VAULT.x0 && x < VAULT.x1 && z > VAULT.z0 && z < VAULT.z1) return 'stone';
    if (x > YARD.x0 && x < YARD.x1 && z > YARD.z0 && z < YARD.z1) return 'dirt';
    if (x > STAIRS.x0 - 2 && x < STAIRS.x1 + 2 && z > STAIRS.zTop - 1 && z < STAIRS.zBottom + 1)
      return 'stone';
    return 'grass';
  }
  if (y < 1.2) {
    if (onPath(x, z, 2.5)) return 'dirt';
    return 'sand';
  }
  return 'grass';
}
