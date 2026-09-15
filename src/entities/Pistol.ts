import {
  Group,
  Mesh,
  PointLight,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp } from '../core/MathUtils.js';
import type { GameCtx } from '../core/GameTypes.js';
import { Ev } from '../core/EventBus.js';
import { boxGeo, cylGeo, trs } from '../render/Geo.js';
import type { MatLib } from '../render/Mats.js';
import { P } from '../render/Palette.js';
import { Particles } from '../render/Particles.js';
import { castShot, hitZone, type CylinderTarget } from '../systems/Ballistics.js';
import { HALL, VAULT } from '../world/Layout.js';
import type { Cultist } from './Cultist.js';

/**
 * 那把枪。
 *
 * 本章只有六发，没有备用弹。设计上它更像一个"决定"而不是一件武器：
 * 后坐力很大、回声很长、开完枪会耳鸣，而且没有任何命中反馈的数字。
 * 枪身模型挂在相机下作为视图模型，非第一人称镜头时自动隐藏。
 */

const HIP_POS = new Vector3(0.2, -0.145, -0.4);
const HIP_ROT = new Vector3(0.02, -0.1, 0);
const AIM_POS = new Vector3(0.0, -0.062, -0.34);
const AIM_ROT = new Vector3(0.0, 0.0, 0);
const MUZZLE_HIP = new Vector3(0.2, -0.1, -0.62);
const MUZZLE_AIM = new Vector3(0.0, 0.016, -0.55);

const FIRE_INTERVAL = 0.28;
const DRAW_TIME = 0.52;

export interface ShotReport {
  ammoLeft: number;
  hitWhat: string;
  killed: boolean;
}

export class Pistol {
  drawn = false;
  aiming = false;
  ammo: number;
  readonly capacity: number;
  shotsFired = 0;
  /** 本章是否已经拿到枪。 */
  enabled = true;

  readonly view = new Group();
  private readonly smoke: Particles;
  private readonly dust: Particles;
  private readonly flashLight: PointLight;
  private readonly flashMesh: Mesh;
  private readonly slide: Object3D;
  private readonly root: Object3D;

  private drawT = 0;
  private aimBlend = 0;
  private cooldown = 0;
  private slideBack = 0;
  private flashTimer = 0;
  private tinnitusTimer = 0;
  private swayPhase = 0;
  private bob = 0;

  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpDir = new Vector3();
  private readonly tmpOrigin = new Vector3();
  private readonly targets: CylinderTarget[] = [];

  constructor(
    private readonly mats: MatLib,
    parent: Object3D,
    capacity = 6,
  ) {
    this.capacity = capacity;
    this.ammo = capacity;

    this.root = this.buildViewModel();
    this.view.add(this.root);
    this.view.name = 'pistol-viewmodel';
    this.view.visible = false;
    parent.add(this.view);

    // 枪口火光：一盏短促的点光源 + 一小片自发光几何
    this.flashLight = new PointLight(P.lantern, 0, 16, 2);
    this.flashLight.visible = false;
    this.view.add(this.flashLight);

    const flashGeo = mergeGeometries(
      [
        boxGeo(0.5, 0.07, 0.07),
        boxGeo(0.07, 0.34, 0.07),
        boxGeo(0.07, 0.07, 0.3),
      ].map((g) => g.clone()),
      false,
    );
    this.flashMesh = new Mesh(flashGeo ?? boxGeo(0.3, 0.3, 0.3), mats.get(mats.key(P.muzzle, { unlit: true, emissive: P.muzzle, emissiveIntensity: 1 })));
    this.flashMesh.name = 'muzzle-flash';
    this.flashMesh.visible = false;
    this.view.add(this.flashMesh);

    this.smoke = new Particles(parent, 72, 0xc8c2b2, { opacity: 0.34 });
    this.dust = new Particles(parent, 96, 0xa9a294, { opacity: 0.42 });

    this.slide = this.root.getObjectByName('slide') ?? this.root;
  }

  private buildViewModel(): Object3D {
    const kBody = this.mats.key(P.gunBody, { metalness: 0.7, roughness: 0.42 });
    const kSlide = this.mats.key(P.gunSlide, { metalness: 0.8, roughness: 0.28 });
    const kGrip = this.mats.key(P.gunGrip, { metalness: 0.1, roughness: 0.85 });

    const group = new Group();
    group.name = 'pistol';

    // 套筒（开火时会后退）
    const slideGroup = new Group();
    slideGroup.name = 'slide';
    const slideGeo = mergeGeometries(
      [
        boxGeo(0.05, 0.058, 0.24).clone().applyMatrix4(trs(0, 0.028, -0.03)),
        boxGeo(0.03, 0.016, 0.02).clone().applyMatrix4(trs(0, 0.062, 0.085)),
        boxGeo(0.034, 0.014, 0.014).clone().applyMatrix4(trs(0, 0.062, -0.13)),
        cylGeo(0.011, 0.011, 0.05, 6).clone().applyMatrix4(trs(0, 0.028, -0.155, 0, 1, 1, 1, Math.PI / 2)),
      ],
      false,
    );
    slideGroup.add(new Mesh(slideGeo ?? boxGeo(0.05, 0.06, 0.24), this.mats.get(kSlide)));
    group.add(slideGroup);

    // 机匣 / 握把 / 扳机护圈
    const bodyGeo = mergeGeometries(
      [
        boxGeo(0.046, 0.05, 0.18).clone().applyMatrix4(trs(0, -0.02, -0.02)),
        boxGeo(0.048, 0.155, 0.072).clone().applyMatrix4(trs(0.002, -0.098, 0.072, 0, 1, 1, 1, 0.26)),
        boxGeo(0.028, 0.012, 0.062).clone().applyMatrix4(trs(0, -0.058, 0.02)),
        boxGeo(0.028, 0.012, 0.02).clone().applyMatrix4(trs(0, -0.09, 0.008)),
      ],
      false,
    );
    group.add(new Mesh(bodyGeo ?? boxGeo(0.05, 0.1, 0.2), this.mats.get(kBody)));

    const gripGeo = boxGeo(0.052, 0.18, 0.078).clone().applyMatrix4(trs(0.002, -0.1, 0.075, 0, 1, 1, 1, 0.26));
    group.add(new Mesh(gripGeo, this.mats.get(kGrip)));

    // ── 两只手与前臂 ─────────────────────────────────────
    // 只有一把枪浮在画面里是很怪的：手是"你在这里"的唯一证据。
    // 手做成两段（掌 + 前臂），前臂从画面下缘伸进来。
    const kSkin = this.mats.key(P.skinDark, { metalness: 0.05, roughness: 0.9 });
    const kSleeve = this.mats.key(P.jacketDark, { metalness: 0.05, roughness: 0.95 });

    // 右手：握住握把
    const rightHand = mergeGeometries(
      [
        // 掌
        boxGeo(0.075, 0.085, 0.115).clone().applyMatrix4(trs(0.004, -0.1, 0.078, 0, 1, 1, 1, 0.28)),
        // 拇指
        boxGeo(0.03, 0.032, 0.085).clone().applyMatrix4(trs(-0.038, -0.072, 0.05, 0, 1, 1, 1, 0.4)),
        // 食指压在扳机护圈上
        boxGeo(0.026, 0.028, 0.075).clone().applyMatrix4(trs(-0.006, -0.062, 0.012, 0, 1, 1, 1, 0.1)),
      ],
      false,
    );
    if (rightHand) group.add(new Mesh(rightHand, this.mats.get(kSkin)));

    // 右前臂（袖子）：从手往画面右下后方去
    const rightArm = mergeGeometries(
      [
        boxGeo(0.1, 0.095, 0.34).clone().applyMatrix4(trs(0.055, -0.215, 0.235, 0, 1, 1, 1, 0.62)),
      ],
      false,
    );
    if (rightArm) group.add(new Mesh(rightArm, this.mats.get(kSleeve)));

    // 左手：托在握把下方
    const leftHand = mergeGeometries(
      [
        boxGeo(0.072, 0.075, 0.105).clone().applyMatrix4(trs(-0.05, -0.135, 0.045, 0, 1, 1, 1, 0.18)),
        boxGeo(0.028, 0.03, 0.07).clone().applyMatrix4(trs(-0.086, -0.115, 0.075, 0, 1, 1, 1, 0.3)),
      ],
      false,
    );
    if (leftHand) group.add(new Mesh(leftHand, this.mats.get(kSkin)));

    // 左前臂
    const leftArm = mergeGeometries(
      [
        boxGeo(0.095, 0.09, 0.3).clone().applyMatrix4(trs(-0.115, -0.245, 0.2, 0, 1, 1, 1, 0.55)),
      ],
      false,
    );
    if (leftArm) group.add(new Mesh(leftArm, this.mats.get(kSleeve)));

    group.scale.setScalar(0.92);
    return group;
  }

  private get muzzleLocal(): Vector3 {
    return this.aiming ? MUZZLE_AIM : MUZZLE_HIP;
  }

  /** 枪口的世界坐标（用于闪光与烟）。 */
  computeMuzzle(camera: PerspectiveCamera, out: Vector3): Vector3 {
    return out.copy(this.muzzleLocal).applyMatrix4(camera.matrixWorld);
  }

  setDrawn(on: boolean, game: GameCtx): void {
    if (this.drawn === on) return;
    this.drawn = on;
    if (on) {
      game.audio.latch();
      game.bus.emit(Ev.Draw);
    } else {
      this.aiming = false;
      game.ui.setAiming(false);
      game.audio.latch();
      game.bus.emit(Ev.Holster);
    }
  }

  toggle(game: GameCtx): void {
    if (!this.enabled) return;
    this.setDrawn(!this.drawn, game);
  }

  setAiming(on: boolean, game: GameCtx): void {
    const want = on && this.drawn && this.enabled;
    if (this.aiming === want) return;
    this.aiming = want;
    game.ui.setAiming(want);
    game.audio.setMuffled(want, want ? 0.55 : 0);
    game.bus.emit(want ? Ev.AimStart : Ev.AimEnd);
  }

  /** 开一枪（或空仓击发）。返回是否消耗了一次输入。 */
  tryFire(game: GameCtx): ShotReport | null {
    if (!this.enabled || !this.drawn) return null;
    if (this.cooldown > 0) return null;
    this.cooldown = FIRE_INTERVAL;

    const camera = game.camera;
    const origin = this.tmpOrigin.copy(game.player.position);
    origin.y += game.player.eyeHeight;

    // 射线沿视线（准星即弹道），扩散很小：他不是在打靶，他是在点名。
    const spread = this.aiming ? 0.0009 : 0.0055;
    const dir = this.tmpDir.copy(this.tmpA.set(0, 0, -1).applyQuaternion(camera.quaternion));
    if (spread > 0) {
      dir.x += (Math.random() - 0.5) * spread * 2;
      dir.y += (Math.random() - 0.5) * spread * 2;
      dir.z += (Math.random() - 0.5) * spread * 2;
    }
    dir.normalize();

    const muzzle = this.computeMuzzle(camera, this.tmpB);

    // 枪口表现
    this.slideBack = 1;
    this.flashTimer = 0.05;
    this.flashMesh.position.copy(muzzle).sub(camera.position).applyQuaternion(camera.quaternion.clone().invert());
    this.flashMesh.visible = true;
    this.flashLight.position.copy(this.flashMesh.position);
    this.flashLight.intensity = 26;
    this.flashLight.visible = true;

    game.renderer.kick(0.5, 0xffdcae);
    game.renderer.impulse(0.7);
    game.player.applyRecoil(0.052, (Math.random() - 0.5) * 0.006);
    game.player.punch(0, 0.012, 0.05, 0, 0);
    game.shake(0.4, 0.16);
    this.smoke.burst(muzzle.x, muzzle.y, muzzle.z, 5, {
      size: 0.03,
      grow: 0.12,
      life: 0.9,
      vy: 0.3,
      gravity: -0.1,
      drag: 1.1,
    });

    const space = this.spaceAt(game.player.position.x, game.player.position.z, game.player.position.y);
    this.tinnitusTimer = 2.6;

    if (this.ammo <= 0) {
      this.audioDry(game);
      return { ammoLeft: 0, hitWhat: 'dry', killed: false };
    }

    this.ammo--;
    this.shotsFired++;
    game.audio.gunshot(space);
    game.bus.emit(Ev.ShotFired, { ammoLeft: this.ammo });

    // 收集目标
    this.targets.length = 0;
    for (const c of game.cultists) {
      if (!c.alive) continue;
      this.targets.push({
        id: c.id,
        x: c.position.x,
        z: c.position.z,
        y0: c.position.y,
        y1: c.position.y + c.height,
        radius: c.radius,
        alive: c.alive,
        ref: c,
      });
    }

    const hit = castShot(game.level, origin, dir, 60, this.targets);
    let killed = false;
    let hitWhat = 'none';

    if (hit) {
      hitWhat = hit.what;
      if (hit.target) {
        const cultist = hit.target as Cultist;
        const zone = hitZone(hit.y, cultist.position.y);
        killed = cultist.onShot(game, hit, zone);
        game.renderer.impulse(0.35);
        this.dust.burst(hit.x, hit.y, hit.z, 6, {
          size: 0.035,
          grow: 0.1,
          life: 0.55,
          gravity: -3,
          drag: 2.4,
        });
      } else {
        // 打在墙上：一小撮灰，然后什么都没有
        this.dust.burst(hit.x, hit.y, hit.z, 8, {
          size: 0.03,
          grow: 0.09,
          life: 0.7,
          gravity: -2.6,
          drag: 2.8,
        });
        game.audio.footstep('stone', 0.5);
      }
    }

    return { ammoLeft: this.ammo, hitWhat, killed };
  }

  private audioDry(game: GameCtx): void {
    game.audio.dryFire();
    game.player.applyRecoil(0.008);
  }

  private spaceAt(x: number, z: number, y: number): 'hall' | 'vault' | 'outdoor' {
    if (y > 7 && x > HALL.x0 - 1 && x < HALL.x1 + 1 && z > HALL.z0 - 1 && z < HALL.z1 + 1) return 'hall';
    if (x > VAULT.x0 - 1 && x < VAULT.x1 + 1 && z > VAULT.z0 - 1 && z < VAULT.z1 + 1) return 'vault';
    return 'outdoor';
  }

  update(dt: number, game: GameCtx): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.slideBack = Math.max(0, this.slideBack - dt * 7);
    this.smoke.update(dt);
    this.dust.update(dt);

    // 耳鸣：开完枪的两秒半里，世界被闷住
    if (this.tinnitusTimer > 0) {
      this.tinnitusTimer -= dt;
      if (this.tinnitusTimer <= 0 && !this.aiming) game.audio.setMuffled(false, 0);
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.flashMesh.visible = false;
        this.flashLight.visible = false;
        this.flashLight.intensity = 0;
      } else {
        const k = this.flashTimer / 0.05;
        this.flashLight.intensity = 26 * k;
        this.flashMesh.scale.setScalar(0.7 + Math.random() * 0.6);
      }
    }

    // 拔枪/收枪
    const target = this.drawn ? 1 : 0;
    this.drawT = damp(this.drawT, target, 1 / (DRAW_TIME * 0.32), dt);
    if (Math.abs(this.drawT - target) < 0.002) this.drawT = target;
    this.view.visible = this.drawT > 0.02;

    const aimBlend = damp(this.aimBlend, this.aiming ? 1 : 0, 10, dt);
    this.aimBlend = aimBlend;

    // 位置与姿态：走动时会晃，瞄准则稳住
    this.swayPhase += dt * (2.4 + game.player.speed * 0.9);
    this.bob = damp(this.bob, clamp(game.player.speed / 5, 0, 1), 6, dt);
    const swayX = Math.sin(this.swayPhase) * 0.014 * this.bob * (1 - aimBlend);
    const swayY = Math.cos(this.swayPhase * 2) * 0.011 * this.bob * (1 - aimBlend);

    const px = HIP_POS.x + (AIM_POS.x - HIP_POS.x) * aimBlend + swayX * 0.4;
    const py = HIP_POS.y + (AIM_POS.y - HIP_POS.y) * aimBlend + swayY;
    const pz = HIP_POS.z + (AIM_POS.z - HIP_POS.z) * aimBlend;
    const rx = HIP_ROT.x + (AIM_ROT.x - HIP_ROT.x) * aimBlend;
    const ry = HIP_ROT.y + (AIM_ROT.y - HIP_ROT.y) * aimBlend;

    // 收枪时整把枪向下沉出画面
    const holsterDrop = (1 - this.drawT) * 0.42;
    const drawTilt = (1 - this.drawT) * -0.5;

    const child = this.root;
    child.position.set(px, py - holsterDrop, pz);
    child.rotation.set(rx + drawTilt, ry, 0.08 + (1 - this.drawT) * 0.3);

    // 套筒后座
    const slideZ = this.slideBack * 0.55;
    this.slide.position.z = 0.05 * slideZ;
    this.slide.position.y = -0.006 * slideZ;
  }

  /** 在世界里为俯视/侧视模式留下一把枪的替身位置。 */
  getWorldMuzzle(camera: PerspectiveCamera, out: Vector3): Vector3 {
    return this.computeMuzzle(camera, out);
  }

  refill(n = this.capacity): void {
    this.ammo = Math.min(n, this.capacity);
  }

  dispose(): void {
    this.smoke.dispose();
    this.dust.dispose();
  }
}
