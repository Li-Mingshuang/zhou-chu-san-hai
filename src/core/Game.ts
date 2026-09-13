import {
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
} from 'three';
import { clamp, rng } from './MathUtils.js';
import { EventBus, Ev } from './EventBus.js';
import { Input } from './Input.js';
import { Settings } from './Settings.js';
import { Save, type EndingId } from './Save.js';
import { readParams, type Params } from './Params.js';
import type { GameCtx } from './GameTypes.js';
import { Renderer } from '../render/Renderer.js';
import { MatLib } from '../render/Mats.js';
import { LIGHT_PRESETS, type LightPresetId } from '../render/Palette.js';
import { InteractionSystem, type Interactable } from '../systems/Interaction.js';
import { BeatRunner } from '../systems/Beat.js';
import { CameraDirector } from '../camera/CameraDirector.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { Ui, type SayOptions } from '../ui/Ui.js';
import { buildIsland, disposeTree, type Island } from '../world/Island.js';
import { ANCHORS, PLATEAU_Y } from '../world/Layout.js';
import type { Level } from '../world/Collision.js';
import { Player } from '../entities/Player.js';
import { Pistol } from '../entities/Pistol.js';
import { Cultist, remainingCount, type CultistSpawn } from '../entities/Cultist.js';
import { HumanoidFactory, PLAYER_LOOK, type Humanoid } from '../entities/Humanoid.js';
import { createChapter3 } from '../chapter3/script.js';

/**
 * 游戏主体。
 *
 * 它是唯一的"上帝对象"：所有系统都通过 GameCtx 拿到它，
 * 于是节拍脚本可以随手切换镜头、切换光照、说话、生成信徒，
 * 而系统之间互不认识。
 */
export class Game implements GameCtx {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: Renderer;
  readonly world = new Group();
  readonly player = new Player();
  readonly director: CameraDirector;
  readonly pistol: Pistol;
  readonly audio = new AudioEngine();
  readonly ui: Ui;
  readonly input: Input;
  readonly settings = new Settings();
  readonly save = new Save();
  readonly params: Params;
  readonly interactions = new InteractionSystem();
  readonly bus = new EventBus();
  readonly cultists: Cultist[] = [];

  // 世界与资源
  private readonly mats = new MatLib();
  private readonly humanoids: HumanoidFactory;
  private island: Island | null = null;
  private avatar: Humanoid | null = null;
  private avatarPhase = 0;

  // 光照
  private hemi: HemisphereLight;
  private sun: DirectionalLight;
  private readonly sunTarget = new Group();

  // 状态
  private readonly runner = new BeatRunner();
  private readonly flags = new Map<string, boolean>();
  private elapsedTime = 0;
  private cleansedValue = 1;
  private casualtiesValue = 0;
  private drewGunOnce = false;
  /** 剧本是否把控制权交还给玩家。镜头处于电影模式时一律无效。 */
  private scriptInput = true;
  private paused = true;
  private started = false;
  private finished = false;
  private lockEverHeld = false;
  private lastFrame = 0;
  private rafId = 0;
  private frameCount = 0;
  private fpsAccum = 0;
  private fpsTimer = 0;
  private fps = 0;
  private heartbeatTimer = 0;
  private preset: LightPresetId = 'yard';
  /** 分镜模式：加载后摆好姿势就冻结，只渲染。 */
  private frozen = false;

  constructor(canvas: HTMLCanvasElement) {
    this.params = readParams();
    this.camera = new PerspectiveCamera(72, 16 / 9, 0.08, 280);
    this.renderer = new Renderer(canvas);
    this.director = new CameraDirector(this.camera);

    this.ui = new Ui({
      onStart: () => void this.startRun(),
      onResume: () => this.setPaused(false),
      onRestart: () => this.restart(),
      onAgain: () => this.restart(),
    });

    this.humanoids = new HumanoidFactory(this.mats);
    this.pistol = new Pistol(this.mats, this.camera, 6);

    this.scene.add(this.camera);
    this.scene.add(this.world);

    // 光照：一盏半球光定基调，一盏平行光给方向。
    this.hemi = new HemisphereLight(0xffffff, 0x444444, 1);
    this.sun = new DirectionalLight(0xffffff, 1);
    this.sun.position.set(40, 80, 30);
    this.scene.add(this.hemi, this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    this.input = new Input(canvas, (locked) => this.onLockChange(locked));
    // 镜头离开电影模式时必须把控制权还回去，否则过场一放完人就动不了了。
    this.director.onModeChange = () => this.applyInputEnabled();

    this.bus.on(Ev.CultistDie, (p) => this.onCultistDown(p as { cultist: Cultist }));
    this.bus.on(Ev.Draw, () => {
      this.drewGunOnce = true;
    });
    // 换节拍时把上一拍的字幕清掉，否则上一场戏的台词会跟着走进下一场
    this.bus.on(Ev.BeatEnter, () => this.ui.clearSubtitles());

    this.applyPreset('yard', true);
    window.addEventListener('resize', this.onResize);
  }

  // ══════════════════════════════════════════════════════
  //  加载
  // ══════════════════════════════════════════════════════

  load(): void {
    const seed = this.params.seed;
    this.island = buildIsland(this.mats, rng(seed));
    this.world.add(this.island.group);

    for (const i of this.island.interactables) this.interactions.add(i);
    for (const spec of this.island.spawns) this.spawnCultist(spec);

    this.runner.setBeats(createChapter3());

    this.renderer.setScale(this.params.pixel ?? this.settings.data.pixelScale);
    this.onResize();

    // 分镜模式：摆好姿势就冻结
    if (this.params.scripted) {
      this.enterShotMode();
    } else {
      // 出生点：先摆在岸上，等节拍接管
      this.player.teleport(ANCHORS.shoreArrive!.x, ANCHORS.shoreArrive!.y, ANCHORS.shoreArrive!.z, 0);
      this.ui.setHudVisible(false);
      this.ui.setCleansed(this.cleansedValue, false);
      if (this.params.intro) {
        this.ui.showTitle();
      } else {
        this.ui.clearOverlay();
        void this.startRun();
      }
    }
  }

  private enterShotMode(): void {
    this.frozen = true;
    this.input.enabled = false;
    this.ui.clearOverlay();
    this.ui.hideOverlay();
    this.ui.setHudVisible(true);
    this.audio.setVolume(0);

    const target = this.params.shot;
    const beatId = target ?? this.params.beat ?? 'arrival';
    const index = this.runner.find(beatId);
    // 直接摆拍：enter 会把场景带到这一拍的开场状态
    this.runner.start(index >= 0 ? index : 0, this);
    const beat = this.runner.list[this.runner.index];
    beat?.shot?.(this);
    // 让一些节拍的进场序列跑到第 t 秒的状态
    if (this.params.t > 0) {
      for (let i = 0; i < Math.ceil(this.params.t * 60); i++) {
        this.runner.update(1 / 60, this);
        this.player.update(1 / 60, this);
        for (const c of this.cultists) c.update(1 / 60, this);
      }
    }
    this.renderer.setFade(1);
    this.cullCultists();
    this.ui.setDebug(this.debugLine());
    (window as unknown as { __SHOT_READY__?: boolean }).__SHOT_READY__ = true;
  }

  // ══════════════════════════════════════════════════════
  //  GameCtx 实现
  // ══════════════════════════════════════════════════════

  get elapsed(): number {
    return this.elapsedTime;
  }

  /** 碰撞体与地表。岛建好之后才可用。 */
  get level(): Level {
    if (!this.island) throw new Error('[game] level requested before the island was built');
    return this.island.level;
  }

  get beatTime(): number {
    return this.runner.time;
  }

  get beatId(): string {
    return this.runner.current?.id ?? '';
  }

  get cleansed(): number {
    return this.cleansedValue;
  }

  get shotsFired(): number {
    return this.pistol.shotsFired;
  }

  get casualties(): number {
    return this.casualtiesValue;
  }

  goto(id?: string): void {
    this.runner.goto(id, this);
  }

  addCleansed(): void {
    this.cleansedValue = Math.min(3, this.cleansedValue + 1);
    this.ui.setCleansed(this.cleansedValue, true);
  }

  resolveEnding(): EndingId {
    if (!this.drewGunOnce && this.pistol.shotsFired === 0) return 'silent';
    if (this.casualtiesValue === 0) return 'refused';
    return 'counted';
  }

  finish(ending: EndingId): void {
    if (this.finished) return;
    this.finished = true;
    this.cleansedValue = 3;
    this.save.recordEnding(ending);
    this.save.setBeat('ending');
    this.setPaused(true);
    this.input.exitLock();
    this.ui.setCleansed(3, false);
    this.ui.setHudVisible(false);
    this.ui.setCrosshair(false, false);

    const spared = remainingCount(this.cultists);
    const count = `已除 3 / 3　·　开枪 ${this.pistol.shotsFired} 次　·　倒下 ${this.casualtiesValue} 人　·　留下 ${spared} 人`;

    if (ending === 'counted') {
      this.ui.showEnding(
        '第三害',
        '他数着数走完了整条过道。\n\n船靠岸的时候，码头上站着等他的人。他把手举起来，笑了一下。\n\n名单上的三个名字，最后一个是他自己。',
        count,
      );
    } else if (ending === 'refused') {
      this.ui.showEnding(
        '不开枪的人',
        '他举着枪站在那里，直到礼厅里只剩下他一个人。\n\n没有人替他数数。枪一直是热的，一发都没打出去。\n\n后来他把枪放回腰后，走了。',
        count,
      );
    } else {
      this.ui.showEnding(
        '什么都没做',
        '他从头到尾没有把枪拿出来。\n\n他看着他们念完，看着他们散场，然后跟着人流走出去。\n\n岛上什么也没发生。',
        count,
      );
    }
  }

  setInputEnabled(on: boolean): void {
    this.scriptInput = on;
    this.applyInputEnabled();
  }

  /**
   * 玩家能不能动，由两件事共同决定：剧本放不放手，以及镜头是不是电影模式。
   * 之所以要在这里统一裁决，是因为过场放完之后必须自动把控制权还回去——
   * 否则一次 setInputEnabled(false) 就会把玩家永久锁死。
   */
  private applyInputEnabled(): void {
    this.player.inputEnabled = this.scriptInput && this.director.mode !== 'cinematic';
  }

  shake(amount: number, seconds = 0.3): void {
    this.director.shake(amount, seconds);
  }

  hitFx(shakeAmount: number, flashAmount: number): void {
    this.renderer.kick(flashAmount, 0x7c1f18);
    this.renderer.impulse(0.9);
    this.player.punch(
      (Math.random() - 0.5) * 0.1,
      -0.05,
      0,
      (Math.random() - 0.5) * 0.06,
      (Math.random() - 0.5) * 0.08,
    );
    this.ui.flashHurt();
    this.shake(shakeAmount, 0.45);
  }

  setLightPreset(id: LightPresetId): void {
    this.applyPreset(id);
  }

  say(text: string, opts?: SayOptions): void {
    this.ui.say(text, opts);
  }

  objective(text: string | null): void {
    this.ui.setObjective(text);
  }

  flag(name: string, value?: boolean): boolean {
    if (value === undefined) return this.flags.get(name) ?? false;
    this.flags.set(name, value);
    this.bus.emit(Ev.Flag, { name, value });
    return value;
  }

  addInteractable(i: Interactable): Interactable {
    return this.interactions.add(i);
  }

  removeInteractable(i: Interactable): void {
    this.interactions.remove(i);
  }

  spawnCultist(opts: CultistSpawn): Cultist {
    const c = new Cultist(opts, this.humanoids);
    c.attach(this.world);
    this.cultists.push(c);
    return c;
  }

  // ══════════════════════════════════════════════════════
  //  运行
  // ══════════════════════════════════════════════════════

  private async startRun(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 浏览器只在用户手势里允许启动音频；headless 或自动开场时
    // ctx.resume() 会一直挂着不兑现，所以必须给它一个上限。
    await Promise.race([
      this.audio.resume().catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1200)),
    ]);
    this.audio.setVolume(this.settings.data.volume);
    this.ui.clearOverlay();
    this.ui.hideOverlay();
    this.ui.setHudVisible(true);
    this.ui.setCleansed(this.cleansedValue, true);
    this.setPaused(false);
    this.input.requestLock();
    this.runner.start(this.params.beat ?? 0, this);
    this.lastFrame = performance.now();
    if (!this.rafId) this.rafId = requestAnimationFrame(this.frame);
  }

  private restart(): void {
    const url = new URL(window.location.href);
    url.search = '';
    window.location.replace(url.toString());
  }

  private setPaused(on: boolean): void {
    if (this.finished) {
      this.paused = true;
      return;
    }
    this.paused = on;
    this.input.enabled = !on && !this.params.scripted;
    if (on) {
      this.ui.showPause();
      this.ui.syncSettingsInputs(this.settings);
      this.input.flush();
    } else {
      this.ui.hidePause();
      this.ui.clearOverlay();
      this.audio.setVolume(this.settings.data.volume);
    }
  }

  private onLockChange(locked: boolean): void {
    if (this.params.scripted) return;
    if (!this.started || this.finished) return;
    if (locked) {
      this.lockEverHeld = true;
      return;
    }
    // 只有"拿到过锁又丢了"才暂停——否则自动驾驶打开页面时会被自己按暂停。
    if (this.lockEverHeld && !this.paused) this.setPaused(true);
  }

  private onResize = (): void => {
    const w = Math.max(320, window.innerWidth);
    const h = Math.max(240, window.innerHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private applyPreset(id: LightPresetId, instant = false): void {
    const p = LIGHT_PRESETS[id];
    this.preset = id;
    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    const [dx, dy, dz] = p.sunDir;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.sun.position.set((dx / len) * 90, (dy / len) * 90, (dz / len) * 90);
    this.sunTarget.position.set(0, PLATEAU_Y, 0);

    this.renderer.fog.color.set(p.fog);
    this.renderer.fog.density = p.fogDensity;
    this.scene.fog = this.renderer.fog;
    this.scene.background = new Color(p.fog).multiplyScalar(id === 'vault' ? 0.14 : 0.42);
    this.renderer.setTuning({ exposure: p.exposure, saturation: p.saturation }, instant);
  }

  private onCultistDown(p: { cultist: Cultist }): void {
    this.casualtiesValue++;
    // 附近的人重新做决定：整场戏是从一个人倒下开始崩的
    for (const c of this.cultists) {
      if (c === p.cultist || !c.alive) continue;
      const d = c.distanceTo(p.cultist.position);
      if (d < 9) c.onNeighborDown(d);
    }
  }

  /** 隔了半座岛的信徒不必再画——室外镜头里这一下能省掉上百个 draw call。 */
  private cullCultists(): void {
    const near = 46 * 46;
    const px = this.player.position.x;
    const pz = this.player.position.z;
    for (const c of this.cultists) {
      if (c.retired) continue;
      const dx = c.position.x - px;
      const dz = c.position.z - pz;
      const visible = dx * dx + dz * dz < near;
      if (c.visible !== visible) {
        c.visible = visible;
        c.setVisible(visible);
      }
    }
  }

  private updateAvatar(dt: number): void {
    const mode = this.director.mode;
    const visible = mode === 'topdown' || mode === 'side';
    if (!visible) {
      if (this.avatar) this.avatar.setVisible(false);
      return;
    }
    if (!this.avatar) {
      this.avatar = this.humanoids.make(PLAYER_LOOK, { full: true });
      this.avatar.setVisible(false);
      this.world.add(this.avatar.root);
    }
    this.avatar.setVisible(true);
    this.avatar.root.position.copy(this.player.position);
    this.avatar.root.rotation.set(0, this.player.facing, 0);
    const speed = this.player.speed;
    this.avatarPhase += dt * (4.2 + speed * 1.7);
    if (speed > 0.25) this.avatar.pose(this.avatarPhase, clamp(speed / 3.2, 0, 1.4), 0.1);
    else this.avatar.pose(this.avatarPhase, 0.05, 0);
  }

  private handleActions(): void {
    if (this.paused || this.params.scripted || this.finished || !this.scriptInput) return;
    const input = this.input;

    if (input.justPressed('pause')) {
      this.setPaused(true);
      return;
    }
    if (this.ui.overlayVisible) return;

    if (input.justPressed('interact')) this.interactions.trigger(this);

    if (input.justPressed('holster')) this.pistol.toggle(this);

    if (input.justPressed('reload')) {
      if (this.pistol.enabled) {
        this.audio.dryFire();
        this.say('没有备用弹。', { narr: true });
      }
    }

    if (input.justPressed('fire')) {
      if (!this.pistol.enabled) {
        // 还没到那一刻
        return;
      }
      if (!this.pistol.drawn) this.pistol.setDrawn(true, this);
      else this.pistol.tryFire(this);
    }

    if (input.justPressed('aim')) this.pistol.setAiming(true, this);
    if (input.justReleased('aim')) this.pistol.setAiming(false, this);
  }

  private update(dt: number): void {
    this.elapsedTime += dt;
    this.audio.update(dt);

    if (this.frozen) {
      this.renderer.update(dt);
      this.ui.update(dt);
      return;
    }

    if (this.paused) {
      this.renderer.update(dt);
      this.ui.update(dt);
      return;
    }

    this.handleActions();

    // 心跳：枪拔出来之后，礼厅里只剩下这个声音
    if (this.pistol.drawn) {
      this.heartbeatTimer -= dt;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = 0.82;
        this.audio.heartbeat(clamp(0.5 + this.casualtiesValue * 0.1, 0.4, 1));
      }
    }

    this.player.update(dt, this);
    this.pistol.update(dt, this);

    for (const c of this.cultists) c.update(dt, this);
    this.cullCultists();

    this.interactions.update(dt, this);
    this.runner.update(dt, this);
    this.director.update(dt, this);
    this.updateAvatar(dt);

    for (const fn of this.island?.animators ?? []) fn(dt, this.elapsedTime);

    this.renderer.update(dt);
    this.ui.update(dt);
    this.input.endFrame();

    if (this.params.debug) {
      this.fpsAccum += dt;
      this.fpsTimer += dt;
      this.frameCount++;
      if (this.fpsTimer > 0.4) {
        this.fps = this.frameCount / this.fpsAccum;
        this.fpsAccum = 0;
        this.frameCount = 0;
        this.fpsTimer = 0;
        this.ui.setDebug(this.debugLine());
      }
    }
  }

  private debugLine(): string {
    const p = this.player.position;
    return [
      `fps ${this.fps.toFixed(0)}  draws ${this.renderer.drawCalls}  tris ${this.renderer.triangles}`,
      `beat ${this.beatId}  t ${this.beatTime.toFixed(1)}s  mode ${this.director.mode}`,
      `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  yaw ${this.player.yaw.toFixed(2)}`,
      `ammo ${this.pistol.ammo}/${this.pistol.capacity}  drawn ${this.pistol.drawn ? 'Y' : 'N'}  aim ${this.pistol.aiming ? 'Y' : 'N'}`,
      `casualties ${this.casualtiesValue}  alive ${remainingCount(this.cultists)}  preset ${this.preset}`,
    ].join('\n');
  }

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    const dt = clamp((now - this.lastFrame) / 1000, 0.0005, 0.05);
    this.lastFrame = now;
    // 时间倍数用"多跑几步"实现，而不是把 dt 放大——放大 dt 会让玩家穿过薄墙。
    const steps = this.params.timeScale > 1 ? Math.round(this.params.timeScale) : 1;
    for (let i = 0; i < steps; i++) this.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /** 开始主循环（标题卡阶段也要渲染，否则标题背后是黑的）。 */
  boot(): void {
    this.load();
    this.lastFrame = performance.now();
    if (!this.rafId) this.rafId = requestAnimationFrame(this.frame);
    if (!this.params.intro) this.ui.hideOverlay();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.pistol.dispose();
    this.audio.dispose();
    this.ui.dispose();
    if (this.island) {
      disposeTree(this.island.group);
      for (const r of this.island.tracked) r.dispose();
    }
    this.humanoids.dispose();
    this.mats.dispose();
    this.renderer.dispose();
  }
}
