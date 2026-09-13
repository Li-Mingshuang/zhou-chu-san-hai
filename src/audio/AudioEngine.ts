/**
 * AudioEngine —— 纯程序化（procedural）Web Audio 音频引擎。
 *
 * 全部声音在运行时合成：振荡器、噪声缓冲、BiquadFilter、WaveShaper、
 * ConvolverNode（脉冲响应由程序生成）、DynamicsCompressor、StereoPanner 与 GainNode 包络。
 * 不引用任何外部音频文件 —— 影迷同人作品不该背音频素材的版权风险。
 *
 * 三条贯穿全文件的原则：
 *   1) 惰性：AudioContext 只在 resume()（用户手势之后）创建；在此之前所有调用都是安静的 no-op。
 *   2) 不崩：创建失败（隐私模式、自动播放策略、上下文数量超限）一律退化为静音，绝不把异常抛进游戏循环。
 *   3) 不炸：瞬态经波形整形 + 总线限幅器，所有包络从 0 起、回 0 落，避免咔哒声与削波。
 */

// ─────────────────────────────────────────────────────────────
// 1. 公开类型
// ─────────────────────────────────────────────────────────────

export type AmbienceId = 'sea' | 'cicada' | 'hall' | 'vault' | 'wind' | 'silence' | 'chant';
export type FootMaterial = 'wood' | 'stone' | 'dirt' | 'sand' | 'grass' | 'water';

export interface AudioEngineOptions {
  volume?: number;
  muted?: boolean;
}

/** 空间预设。公开方法签名里写展开的联合类型，这里只用于内部状态与查表。 */
type SpaceKind = 'hall' | 'vault' | 'outdoor' | 'shore';

// ─────────────────────────────────────────────────────────────
// 2. 预设表与内部类型
// ─────────────────────────────────────────────────────────────

/** 混响脉冲响应规格：秒数 + 衰减指数（越大越"硬"，尾巴掉得越快）。 */
const IR_SPECS: Record<SpaceKind, { seconds: number; decay: number }> = {
  hall: { seconds: 1.2, decay: 2.4 },
  vault: { seconds: 0.7, decay: 3.6 },
  outdoor: { seconds: 0.25, decay: 1.4 },
  shore: { seconds: 0.9, decay: 1.8 },
};

/** 空间预设：湿声比例、湿声阻尼（低通）、额外的 50Hz 嗡鸣。 */
const SPACES: Record<SpaceKind, { wet: number; damp: number; hum: number }> = {
  hall: { wet: 0.4, damp: 6000, hum: 0 },
  vault: { wet: 0.34, damp: 3600, hum: 0.045 },
  outdoor: { wet: 0.1, damp: 9000, hum: 0 },
  shore: { wet: 0.3, damp: 5200, hum: 0.012 },
};

interface FootSpec {
  filter: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q: number;
  decay: number;
  gain: number;
  filter2?: BiquadFilterType;
  freq2?: number;
  q2?: number;
  verb: number;
}

/** 脚步的材质表：改变的是噪声的滤波中心频率与包络长度，而不是音量。 */
const FOOT: Record<FootMaterial, FootSpec> = {
  wood: { filter: 'bandpass', freq: 520, q: 1.1, decay: 0.075, gain: 1, filter2: 'lowpass', freq2: 1500, q2: 0.7, verb: 0.12 },
  stone: { filter: 'bandpass', freq: 1900, q: 0.85, decay: 0.06, gain: 0.95, filter2: 'highpass', freq2: 320, q2: 0.6, verb: 0.34 },
  dirt: { filter: 'lowpass', freq: 420, q: 0.9, decay: 0.1, gain: 1, verb: 0.05 },
  sand: { filter: 'bandpass', freq: 1400, q: 0.5, decay: 0.04, gain: 0.85, filter2: 'lowpass', freq2: 2400, q2: 0.5, verb: 0.02 },
  grass: { filter: 'highpass', freq: 3200, q: 0.7, decay: 0.05, gain: 0.6, verb: 0.05 },
  water: { filter: 'bandpass', freq: 900, freqEnd: 2600, q: 0.6, decay: 0.15, gain: 1, verb: 0.14 },
};

/** 儿童元音的共振峰近似（中心频率 / Q / 相对增益）：Q 越高越窄，越像人声。 */
const FORMANTS: readonly (readonly [number, number, number])[] = [
  [860, 8, 1],
  [2180, 10, 0.5],
  [3150, 12, 0.24],
];

/** 音频图：一次性建立，之后只改参数。所有声源最终汇入 mix。 */
interface Graph {
  ctx: AudioContext;
  /** 干声汇合点。 */
  mix: GainNode;
  /** 闷度：整体压低音量。 */
  muffle: GainNode;
  muffleLP: BiquadFilterNode;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  /** 房间混响支路（脚步、开门、金属等共用）。 */
  reverbSend: GainNode;
  conv: ConvolverNode;
  wetDamp: BiquadFilterNode;
  wet: GainNode;
  /** 枪声专用尾音支路：每次开枪可指定不同长度的脉冲响应，不干扰房间混响。 */
  shotSend: GainNode;
  shotConv: ConvolverNode;
  shotDamp: BiquadFilterNode;
  shotWet: GainNode;
  /** 日光灯 / 电流的 50Hz 嗡鸣。 */
  hum: GainNode;
  /** 耳鸣：直连 master，因此不会被闷度低通削弱。 */
  tinnitus: GainNode;
  /** 心跳的"血涌"低频床，电平由 update 驱动。 */
  heartBed: GainNode;
}

/** 一个持续环境层。 */
interface AmbienceVoice {
  readonly id: AmbienceId;
  readonly gain: GainNode;
  /** 释放完成的时间点（ctx 时间轴），到点后由引擎回收。 */
  stopAt: number;
  /** 每帧推进缓慢调制：LFO 相位、随机浪涌、滤波扫动。 */
  update(dt: number, now: number): void;
  /** 淡出并在 fade 秒后允许回收。 */
  release(fade: number): void;
  /** 立刻停止所有声源并断开内部节点。 */
  kill(): void;
}

// ─────────────────────────────────────────────────────────────
// 3. 小工具与合成辅助函数
// ─────────────────────────────────────────────────────────────

// 归一化一律把非有限输入当作 0：NaN 一旦进了 AudioParam，就会顺着整条链路污染成静音或爆音
const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
const clampPan = (v: number): number => (Number.isFinite(v) ? (v < -1 ? -1 : v > 1 ? 1 : v) : 0);
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Safari 只暴露 webkitAudioContext；拿不到就返回 null，由调用方静默降级。 */
function getAudioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * 白噪声缓冲。首尾各做几十个采样点的淡变，是为了让它能无缝 loop（否则每个循环接缝都会"啪"一下）。
 */
function makeNoiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(64, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const edge = Math.min(96, len >> 3);
  for (let i = 0; i < edge; i++) {
    const k = i / edge;
    d[i] *= k;
    d[len - 1 - i] *= k;
  }
  return buf;
}

/**
 * 程序生成脉冲响应：噪声 × 随距离变暗的一阶低通 × 幂次衰减。
 * 高频先于低频消失，是"房间"听感的物理来源；开头叠一点早期反射，房间才有边界感。
 */
function makeImpulseResponse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // 阻尼系数随时间下降 —— 尾巴越靠后越闷（空气与墙面吸收高频）
      const k = 0.9 - 0.78 * t;
      lp += (Math.random() * 2 - 1 - lp) * k;
      const early = 1 + 2.4 * Math.exp(-i / (0.004 * rate));
      const v = lp * Math.pow(1 - t, decay) * early;
      d[i] = v;
      energy += v * v;
    }
    // 归一化到固定 RMS：不同长度的 IR 在湿声电平上保持一致，切空间不会忽然变响
    const rms = Math.sqrt(energy / len) || 1;
    const norm = 0.075 / rms;
    for (let i = 0; i < len; i++) d[i] *= norm;
  }
  return buf;
}

/** tanh 软削波曲线：amount 越大越硬，用来做枪声的"炸"与低频的"推力"。 */
function driveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 1 + amount * 24;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** 断开整条链路；节点可能已被回收，所以吞掉异常。 */
function disconnectAll(nodes: readonly AudioNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      // 已断开或上下文已关闭：忽略
    }
  }
}

/**
 * 标准打击包络：0 → peak（线性）→ 近零（指数）→ 0（线性收尾）。
 * 尾部补一段线性到 0 是必要的 —— 指数只能逼近零，直接停在极小值会有残留直流。
 */
function env(param: AudioParam, peak: number, attack: number, decay: number, time: number): void {
  const a = Math.max(0.0008, attack);
  const d = Math.max(0.005, decay);
  const p = Math.max(0.0002, peak);
  param.cancelScheduledValues(time);
  param.setValueAtTime(0, time);
  param.linearRampToValueAtTime(p, time + a);
  param.exponentialRampToValueAtTime(p * 0.0008, time + a + d);
  param.linearRampToValueAtTime(0, time + a + d + 0.004);
}

interface BufOptions {
  time?: number;
  rate?: number;
  offset?: number;
  loop?: boolean;
  attack?: number;
  decay?: number;
  filter?: BiquadFilterType;
  freq?: number;
  /** 带扫动时与 sweep 一起使用：滤波中心频率从 freq 滑到 freqEnd。 */
  freqEnd?: number;
  sweep?: number;
  q?: number;
  filter2?: BiquadFilterType;
  freq2?: number;
  q2?: number;
  drive?: number;
  pan?: number;
  /** 送往房间混响的比例。 */
  verb?: number;
  /** 输出目标，默认进总线；枪声等需要独立子链时使用。 */
  dest?: AudioNode;
}

/**
 * 播放一段缓冲（噪声 / 任意素材）并自带包络、滤波、失真、声像与混响送出。
 * 播放结束由 onended 断链回收，调用方不需要持有任何句柄。
 * 外层吞异常：上下文被回收或资源耗尽时，只丢掉这一声，绝不让游戏循环看到。
 */
function playBuf(g: Graph, buffer: AudioBuffer, peak: number, opts: BufOptions = {}): void {
  try {
    spawnBufVoice(g, buffer, peak, opts);
  } catch {
    // 静默降级
  }
}

function spawnBufVoice(g: Graph, buffer: AudioBuffer, peak: number, opts: BufOptions): void {
  const ctx = g.ctx;
  const t0 = (opts.time ?? ctx.currentTime) + 0.002;
  const atk = opts.attack ?? 0.0012;
  const dec = opts.decay ?? 0.08;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = opts.rate ?? 1;
  src.loop = opts.loop ?? false;

  const chain: AudioNode[] = [src];
  let node: AudioNode = src;
  for (const stage of [0, 1] as const) {
    const type = stage === 0 ? opts.filter : opts.filter2;
    if (type === undefined) continue;
    const f = ctx.createBiquadFilter();
    f.type = type;
    const f0 = Math.max(20, (stage === 0 ? opts.freq : opts.freq2) ?? 1000);
    f.frequency.value = f0;
    f.Q.value = (stage === 0 ? opts.q : opts.q2) ?? 1;
    const fEnd = stage === 0 ? opts.freqEnd : undefined;
    if (fEnd !== undefined) {
      const end = t0 + Math.max(0.01, opts.sweep ?? atk + dec);
      f.frequency.setValueAtTime(f0, t0);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, fEnd), end);
    }
    node.connect(f);
    node = f;
    chain.push(f);
  }
  if (opts.drive !== undefined) {
    const w = ctx.createWaveShaper();
    w.curve = driveCurve(opts.drive);
    w.oversample = '2x';
    node.connect(w);
    node = w;
    chain.push(w);
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  node.connect(gain);
  chain.push(gain);

  let tail: AudioNode = gain;
  if (opts.pan !== undefined) {
    const p = ctx.createStereoPanner();
    p.pan.value = clampPan(opts.pan);
    gain.connect(p);
    tail = p;
    chain.push(p);
  }
  tail.connect(opts.dest ?? g.mix);
  if (opts.verb) {
    const send = ctx.createGain();
    send.gain.value = opts.verb;
    tail.connect(send);
    send.connect(g.reverbSend);
    chain.push(send);
  }

  env(gain.gain, peak, atk, dec, t0);
  src.start(t0, opts.offset ?? 0);
  src.stop(t0 + atk + dec + 0.06);
  src.onended = () => disconnectAll(chain);
}

interface OscOptions {
  type: OscillatorType;
  freq: number;
  /** 有值时做指数滑音：低频"胸震"与心跳都靠它。 */
  freqEnd?: number;
  time?: number;
  peak: number;
  attack?: number;
  decay?: number;
  detune?: number;
  filter?: BiquadFilterType;
  cutoff?: number;
  q?: number;
  drive?: number;
  pan?: number;
  verb?: number;
  dest?: AudioNode;
}

/** 单振荡器音符：与 playBuf 同构，只是声源换成振荡器（金属分音、低频冲击、UI 音）。 */
function playOsc(g: Graph, o: OscOptions): void {
  try {
    spawnOscVoice(g, o);
  } catch {
    // 静默降级
  }
}

function spawnOscVoice(g: Graph, o: OscOptions): void {
  const ctx = g.ctx;
  const t0 = (o.time ?? ctx.currentTime) + 0.002;
  const atk = o.attack ?? 0.004;
  const dec = o.decay ?? 0.15;

  const osc = ctx.createOscillator();
  osc.type = o.type;
  const f0 = Math.max(8, o.freq);
  osc.frequency.setValueAtTime(f0, t0);
  if (o.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(8, o.freqEnd), t0 + atk + dec * 0.7);
  }
  osc.detune.value = o.detune ?? 0;

  const chain: AudioNode[] = [osc];
  let node: AudioNode = osc;
  if (o.filter !== undefined) {
    const f = ctx.createBiquadFilter();
    f.type = o.filter;
    f.frequency.value = Math.max(20, o.cutoff ?? 1000);
    f.Q.value = o.q ?? 1;
    node.connect(f);
    node = f;
    chain.push(f);
  }
  if (o.drive !== undefined) {
    const w = ctx.createWaveShaper();
    w.curve = driveCurve(o.drive);
    w.oversample = '2x';
    node.connect(w);
    node = w;
    chain.push(w);
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  node.connect(gain);
  chain.push(gain);

  let tail: AudioNode = gain;
  if (o.pan !== undefined) {
    const p = ctx.createStereoPanner();
    p.pan.value = clampPan(o.pan);
    gain.connect(p);
    tail = p;
    chain.push(p);
  }
  tail.connect(o.dest ?? g.mix);
  if (o.verb) {
    const send = ctx.createGain();
    send.gain.value = o.verb;
    tail.connect(send);
    send.connect(g.reverbSend);
    chain.push(send);
  }

  env(gain.gain, o.peak, atk, dec, t0);
  osc.start(t0);
  osc.stop(t0 + atk + dec + 0.06);
  osc.onended = () => disconnectAll(chain);
}

// ─────────────────────────────────────────────────────────────
// 4. 引擎
// ─────────────────────────────────────────────────────────────

export class AudioEngine {
  private g: Graph | null = null;
  private disposed = false;

  private volume = 0.8;
  private muted = false;
  /** 0 = 不闷；1 = 最闷（仪式瞄准 / 耳鸣）。 */
  private muffleAmount = 0;
  private space: SpaceKind = 'hall';
  private ambience: AmbienceId = 'silence';

  private readonly voices = new Map<AmbienceId, AmbienceVoice>();
  private readonly noiseCache = new Map<number, AudioBuffer>();
  private readonly irCache = new Map<SpaceKind, AudioBuffer>();
  /** 需要延迟断开的临时节点（枪声子链、哭声人声链等）。 */
  private retired: { at: number; nodes: AudioNode[] }[] = [];
  /** 心跳余韵，由 update 自然衰减，用来驱动低频"血涌"床。 */
  private heartPulse = 0;

  constructor(opts?: AudioEngineOptions) {
    if (opts) {
      if (typeof opts.volume === 'number' && Number.isFinite(opts.volume)) this.volume = clamp01(opts.volume);
      this.muted = opts.muted === true;
    }
  }

  // ── 生命周期 ───────────────────────────────────────────────

  /** 用户手势之后调用；返回是否成功启动。可安全重复调用。 */
  async resume(): Promise<boolean> {
    if (this.disposed) return false;
    const g = this.ensureGraph();
    if (!g) return false;
    try {
      // 浏览器可能在页面不可见或策略收紧时把上下文挂起，这里每次都尝试唤醒
      if (g.ctx.state !== 'running') await g.ctx.resume();
    } catch {
      return false;
    }
    if (g.ctx.state !== 'running') return false;
    // 音频启动前调用方可能已经切换过空间与环境层，此时补上；补挂失败不影响"已启动"的结论
    try {
      this.applySpace(g);
      if (this.ambience !== 'silence') this.applyAmbience(this.ambience, 1.2);
    } catch {
      // 只有环境音缺失，游戏照常跑
    }
    return true;
  }

  get ready(): boolean {
    const g = this.g;
    return !this.disposed && g !== null && g.ctx.state === 'running';
  }

  setVolume(v: number): void {
    this.volume = Number.isFinite(v) ? clamp01(v) : 0;
    const g = this.g;
    if (!g) return;
    const t = g.ctx.currentTime;
    try {
      g.master.gain.setTargetAtTime(this.level(), t, 0.04);
    } catch {
      // 上下文已关闭：忽略
    }
  }

  /** 主音量整体压低 + 低通闷住（"仪式瞄准"/耳鸣时使用）。amount 0..1 */
  setMuffled(on: boolean, amount?: number): void {
    this.muffleAmount = on ? clamp01(amount ?? 0.65) : 0;
    const g = this.g;
    if (g) this.applyMuffle(g);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const g = this.g;
    this.g = null;
    for (const item of this.retired) disconnectAll(item.nodes);
    this.retired = [];
    if (!g) return;
    const t = g.ctx.currentTime;
    try {
      g.master.gain.cancelScheduledValues(t);
      g.master.gain.setValueAtTime(g.master.gain.value, t);
      g.master.gain.linearRampToValueAtTime(0, t + 0.15);
    } catch {
      // 忽略
    }
    for (const v of this.voices.values()) v.release(0.15);
    this.voices.clear();
    this.noiseCache.clear();
    this.irCache.clear();
    const ctx = g.ctx;
    const teardown = (): void => {
      disconnectAll([g.mix, g.muffle, g.muffleLP, g.master, g.limiter, g.reverbSend, g.conv, g.wetDamp, g.wet, g.shotSend, g.shotConv, g.shotDamp, g.shotWet, g.hum, g.tinnitus, g.heartBed]);
      void ctx.close().catch(() => undefined);
    };
    // 直接 close 会"啪"一声：先让主音量走完 150ms 的淡出再拆图
    try {
      setTimeout(teardown, 320);
    } catch {
      teardown();
    }
  }

  // ── 一次性音效 ─────────────────────────────────────────────

  /** 手枪射击：噪声爆破 + 低频冲击 + 尾部混响。这是全作最重的一声。 */
  gunshot(space?: 'hall' | 'vault' | 'outdoor'): void {
    try {
      this.spawnShot(space);
    } catch {
      // 静默降级：枪声不响也不能让游戏崩
    }
  }

  private spawnShot(space?: 'hall' | 'vault' | 'outdoor'): void {
    const g = this.live();
    if (!g) return;
    const ctx = g.ctx;
    const t0 = ctx.currentTime + 0.004;
    const kind: SpaceKind = space ?? (this.space === 'shore' ? 'outdoor' : this.space);

    // 枪声用独立卷积器：脉冲响应可以按每一声的 space 换，而不会把房间混响的尾巴一起换掉
    const ir = this.ir(g, kind);
    if (g.shotConv.buffer !== ir) g.shotConv.buffer = ir;
    g.shotWet.gain.setValueAtTime(kind === 'outdoor' ? 0.5 : 0.95, t0);

    // 所有层先汇入本地的干声母线，再一并送往干声总线与枪声尾音支路。
    // 母线压到 0.62：五层的瞬时峰值加在一起仍然要低于 1.0，剩下的"重"交给限幅器去表达
    const bus = ctx.createGain();
    bus.gain.value = 0.62;
    const send = ctx.createGain();
    send.gain.value = kind === 'outdoor' ? 0.45 : 1;
    bus.connect(g.mix);
    bus.connect(send);
    send.connect(g.shotSend);
    this.retire([bus, send], t0 + IR_SPECS[kind].seconds + 0.8);

    const noise = this.noise(g, 0.5);
    // ① 宽带噪声瞬态：40ms 指数衰减，经波形整形削出"炸"的硬度
    playBuf(g, noise, 0.9, {
      dest: bus, time: t0, offset: Math.random() * 0.3, rate: rand(0.95, 1.05),
      filter: 'highpass', freq: 190, q: 0.6, filter2: 'lowpass', freq2: 9000, q2: 0.7,
      drive: 0.7, attack: 0.0006, decay: 0.04, pan: rand(-0.05, 0.05),
    });
    // ② 超音速爆响：更窄更高的一小撮噪声，负责"锐"，也保证在小喇叭上仍听得见
    playBuf(g, noise, 0.35, {
      dest: bus, time: t0 + 0.001, offset: Math.random() * 0.3,
      filter: 'bandpass', freq: 3800, q: 0.9, drive: 0.3, attack: 0.0005, decay: 0.02,
    });
    // ③ 80–120Hz 正弦"胸震"：向下滑音 + 低频推力，是"胸口被推了一下"的来源
    playOsc(g, {
      dest: bus, type: 'sine', freq: rand(108, 122), freqEnd: 58, peak: 0.95,
      time: t0, attack: 0.003, decay: 0.12, filter: 'lowpass', cutoff: 420, q: 0.9, drive: 0.25,
    });
    playOsc(g, { dest: bus, type: 'sine', freq: 46, freqEnd: 34, peak: 0.5, time: t0, attack: 0.006, decay: 0.2 });
    // ④ 击发机构的金属余振，短暂但决定了这是"枪"而不是"爆竹"
    playOsc(g, { dest: bus, type: 'triangle', freq: 1320, freqEnd: 900, peak: 0.1, time: t0, attack: 0.001, decay: 0.06 });
  }

  /** 空仓击发：金属咔哒，干、短、无处可去。 */
  dryFire(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    // 刻意不做混响送出：这一声的意义就在于"没有回响"
    playBuf(g, this.noise(g, 0.2), 0.45, { time: t0, filter: 'bandpass', freq: 2600, q: 6, attack: 0.0005, decay: 0.012, pan: rand(-0.1, 0.1) });
    playOsc(g, { type: 'triangle', freq: 2100, freqEnd: 1650, peak: 0.16, attack: 0.001, decay: 0.035, time: t0 });
    playOsc(g, { type: 'sine', freq: 3180, peak: 0.08, attack: 0.001, decay: 0.02, time: t0 });
    playOsc(g, { type: 'sine', freq: 188, freqEnd: 132, peak: 0.12, attack: 0.002, decay: 0.025, time: t0, filter: 'lowpass', cutoff: 400, q: 0.8 });
  }

  shellDrop(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    const pan = rand(0.05, 0.45);
    // 三跳，一跳比一跳轻、一跳比一跳远：听觉上就形成了"弹壳在地上弹开"
    this.brassTinkle(g, t0, 0.28, pan);
    this.brassTinkle(g, t0 + rand(0.09, 0.16), 0.15, pan + 0.12);
    this.brassTinkle(g, t0 + rand(0.2, 0.3), 0.07, pan + 0.2);
  }

  /** 套筒拉动 / 上膛 */
  reload(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    // ① 退弹匣：金属壳体的短促碰撞
    playBuf(g, this.noise(g, 0.3), 0.3, { time: t0, filter: 'bandpass', freq: 1150, q: 3, attack: 0.0008, decay: 0.035, verb: 0.2, pan: -0.1 });
    playOsc(g, { type: 'triangle', freq: 172, freqEnd: 118, peak: 0.18, attack: 0.002, decay: 0.06, time: t0, filter: 'lowpass', cutoff: 900, q: 0.8 });
    // ② 拉套筒：噪声带通从 900 扫到 3200 —— 扫动本身就在表达"金属在滑动"
    playBuf(g, this.noise(g, 0.5), 0.28, { time: t0 + 0.12, filter: 'bandpass', freq: 900, freqEnd: 3200, sweep: 0.11, q: 1.8, attack: 0.008, decay: 0.12, verb: 0.25, pan: 0.05 });
    for (const f of [1450, 2350]) {
      playOsc(g, { type: 'sine', freq: f * rand(0.99, 1.01), peak: 0.07, attack: 0.002, decay: 0.09, time: t0 + 0.12, pan: 0.05 });
    }
    // ③ 复进到位：更硬更短的一记闷响，收束整段动作
    playBuf(g, this.noise(g, 0.3), 0.38, { time: t0 + 0.3, filter: 'lowpass', freq: 900, q: 1.2, drive: 0.2, attack: 0.001, decay: 0.05, verb: 0.25 });
    playOsc(g, { type: 'sine', freq: 148, freqEnd: 96, peak: 0.24, attack: 0.002, decay: 0.08, time: t0 + 0.3, filter: 'lowpass', cutoff: 320, q: 0.8 });
  }

  footstep(material: FootMaterial, strength: number): void {
    const g = this.live();
    if (!g) return;
    const s = clamp01(strength);
    if (s < 0.02) return;
    const t0 = g.ctx.currentTime + 0.003;
    const m = FOOT[material];
    const pan = rand(-0.22, 0.22);
    const peak = 0.3 * s * m.gain;

    playBuf(g, this.noise(g, 0.4), peak, {
      time: t0, offset: Math.random() * 0.25, rate: rand(0.92, 1.08),
      filter: m.filter, freq: m.freq, freqEnd: m.freqEnd, q: m.q,
      filter2: m.filter2, freq2: m.freq2, q2: m.q2,
      attack: 0.0016, decay: m.decay, verb: m.verb, pan,
    });

    switch (material) {
      case 'wood':
        // 200Hz 箱体共振：木地板被踩响时，声音来自地板下的空腔而不只是鞋底
        playOsc(g, { type: 'sine', freq: rand(190, 215), peak: peak * 0.55, attack: 0.002, decay: 0.055, time: t0, filter: 'lowpass', cutoff: 500, q: 1.2, verb: m.verb, pan });
        break;
      case 'stone':
        playOsc(g, { type: 'sine', freq: rand(3900, 4600), peak: peak * 0.18, attack: 0.0008, decay: 0.02, time: t0, verb: 0.4, pan });
        break;
      case 'grass':
        // 高频碎裂：几次极短的噪声脉冲，间隔随机，才像踩断草茎而不是一声闷响
        for (let i = 0; i < 4; i++) {
          playBuf(g, this.noise(g, 0.2), peak * rand(0.25, 0.5), {
            time: t0 + rand(0, 0.035), offset: Math.random() * 0.15,
            filter: 'highpass', freq: rand(2600, 4200), q: 0.8, attack: 0.0008, decay: rand(0.012, 0.028), pan: pan + rand(-0.1, 0.1),
          });
        }
        break;
      case 'water':
        // 溅水：一个向上扫的带通给"水花"，几颗水滴给"溅开"
        for (let i = 0; i < 3; i++) {
          playOsc(g, { type: 'sine', freq: rand(900, 1700), freqEnd: rand(600, 900), peak: peak * 0.22, attack: 0.001, decay: rand(0.03, 0.06), time: t0 + rand(0.04, 0.15), pan: pan + rand(-0.15, 0.15) });
        }
        playOsc(g, { type: 'sine', freq: 220, freqEnd: 140, peak: peak * 0.3, attack: 0.004, decay: 0.1, time: t0, filter: 'lowpass', cutoff: 400, q: 0.8 });
        break;
      case 'dirt':
      case 'sand':
        // 松散材质没有共振，只有被压实的那一下：给一点极低频的"沉"
        playOsc(g, { type: 'sine', freq: rand(110, 150), freqEnd: 80, peak: peak * 0.22, attack: 0.003, decay: 0.05, time: t0, filter: 'lowpass', cutoff: 260, q: 0.8 });
        break;
    }
  }

  /** 身体倒地：闷响 + 布料摩擦 */
  bodyFall(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    playOsc(g, { type: 'sine', freq: 92, freqEnd: 42, peak: 0.8, attack: 0.006, decay: 0.22, time: t0, filter: 'lowpass', cutoff: 300, q: 0.9, drive: 0.2, verb: 0.5 });
    playBuf(g, this.noise(g, 0.6), 0.2, { time: t0, filter: 'bandpass', freq: 900, q: 0.8, attack: 0.02, decay: 0.3, verb: 0.45, pan: rand(-0.2, 0.2) });
    // 四肢随后落地的第二下：少了它，倒下去会像一袋米而不是一个人
    playOsc(g, { type: 'sine', freq: 128, freqEnd: 78, peak: 0.2, attack: 0.004, decay: 0.1, time: t0 + 0.07, filter: 'lowpass', cutoff: 340, q: 0.8, verb: 0.3, pan: 0.18 });
  }

  doorCreak(): void {
    try {
      this.spawnDoorCreak();
    } catch {
      // 静默降级
    }
  }

  private spawnDoorCreak(): void {
    const g = this.live();
    if (!g) return;
    const ctx = g.ctx;
    const t0 = ctx.currentTime + 0.004;
    const dur = rand(0.9, 1.5);

    const bus = ctx.createGain();
    bus.gain.value = 0.5;
    bus.connect(g.mix);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    bus.connect(send);
    send.connect(g.reverbSend);

    // 声源：锯齿波。门轴的"吱呀"本质是粘滑振动，用一条不规则的频率曲线去逼近它
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const steps = 32;
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const k = i / (steps - 1);
      curve[i] = 95 + 150 * k + 45 * Math.sin(i * 1.9) + rand(-14, 14);
    }
    osc.frequency.setValueCurveAtTime(curve, t0, dur);
    // 粘滑的颗粒感：音频速率的 AM，比单纯的低频更"木"
    const grain = ctx.createGain();
    grain.gain.value = 0.62;
    const grainLfo = ctx.createOscillator();
    grainLfo.type = 'triangle';
    grainLfo.frequency.value = rand(16, 27);
    const grainAmt = ctx.createGain();
    grainAmt.gain.value = 0.34;
    grainLfo.connect(grainAmt);
    grainAmt.connect(grain.gain);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 780;
    bp.Q.value = 5.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    lp.Q.value = 0.7;

    osc.connect(bp);
    bp.connect(lp);
    lp.connect(grain);
    grain.connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    grainLfo.start(t0);
    grainLfo.stop(t0 + dur + 0.05);
    this.retire([bus, send, osc, grain, grainLfo, grainAmt, bp, lp], t0 + dur + 0.3);

    // 门到位后的那一记木响，没有它门像是飘着的
    playBuf(g, this.noise(g, 0.3), 0.24, { time: t0 + dur, filter: 'lowpass', freq: 320, q: 1.1, attack: 0.002, decay: 0.1, verb: 0.4, pan: -0.1 });
  }

  latch(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    playBuf(g, this.noise(g, 0.2), 0.3, { time: t0, filter: 'bandpass', freq: 2100, q: 8, attack: 0.0005, decay: 0.014, pan: 0.1 });
    for (const f of [1380, 2060]) {
      playOsc(g, { type: 'sine', freq: f * rand(0.99, 1.01), peak: 0.08, attack: 0.001, decay: rand(0.03, 0.06), time: t0 + 0.001, pan: 0.1 });
    }
    playOsc(g, { type: 'sine', freq: 128, freqEnd: 96, peak: 0.15, attack: 0.002, decay: 0.05, time: t0, filter: 'lowpass', cutoff: 260, q: 0.8 });
  }

  metalDoor(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    const pan = rand(-0.3, 0.3);
    playBuf(g, this.noise(g, 0.5), 0.45, { time: t0, filter: 'lowpass', freq: 320, q: 0.7, drive: 0.25, attack: 0.002, decay: 0.14, verb: 0.5, pan });
    // 非谐分音：金属的"音高感"来自这些互不成整数比的频率，越靠后越弱越快
    const partials = [187, 293, 447, 719, 1087, 1531];
    for (let i = 0; i < partials.length; i++) {
      const f = partials[i] * rand(0.99, 1.01);
      playOsc(g, {
        type: 'sine', freq: f, peak: 0.2 / (1 + i * 0.55), attack: 0.004, decay: Math.max(0.2, rand(0.55, 0.95) - i * 0.08),
        time: t0 + i * 0.002, filter: 'bandpass', cutoff: f, q: 2.5, verb: 0.6, pan,
      });
    }
    // 拖尾的刮擦：噪声带通缓慢上扫，暗示门在重力和铰链之间挣扎了一下
    playBuf(g, this.noise(g, 1), 0.12, { time: t0 + 0.02, filter: 'bandpass', freq: 420, freqEnd: 1900, sweep: 0.4, q: 1.6, attack: 0.05, decay: 0.42, verb: 0.4, pan: pan * 0.6 });
  }

  paper(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    // 纸是"许多极短的脆响"，所以用多次错开的窄脉冲而不是一段连续噪声
    for (let i = 0; i < 5; i++) {
      playBuf(g, this.noise(g, 0.3), 0.14 * rand(0.6, 1), {
        time: t0 + i * rand(0.025, 0.06), offset: Math.random() * 0.25, rate: rand(0.9, 1.15),
        filter: 'highpass', freq: rand(2400, 3400), q: 0.7, filter2: 'lowpass', freq2: 7200, q2: 0.6,
        attack: 0.003, decay: rand(0.025, 0.06), verb: 0.12, pan: rand(-0.3, 0.3),
      });
    }
  }

  pickUp(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.004;
    playBuf(g, this.noise(g, 0.4), 0.18, { time: t0, filter: 'bandpass', freq: 760, q: 1.4, attack: 0.006, decay: 0.06, verb: 0.22, pan: rand(-0.15, 0.15) });
    playBuf(g, this.noise(g, 0.2), 0.06, { time: t0 + 0.012, filter: 'highpass', freq: 3200, q: 0.7, attack: 0.002, decay: 0.03 });
  }

  /** UI 点击 */
  click(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.003;
    playBuf(g, this.noise(g, 0.1), 0.16, { time: t0, filter: 'bandpass', freq: 1800, q: 6, attack: 0.0005, decay: 0.015 });
    playOsc(g, { type: 'sine', freq: 880, freqEnd: 760, peak: 0.05, attack: 0.001, decay: 0.02, time: t0 });
  }

  /** 心跳，intensity 0..1，设计为每拍调用一次（约 0.85s 一次） */
  heartbeat(intensity: number): void {
    const g = this.live();
    if (!g) return;
    const i = clamp01(intensity);
    if (i < 0.02) return;
    const t0 = g.ctx.currentTime + 0.012;
    // 交给 update 去衰减：低频"血涌"床的电平是心跳余韵的积分，不需要调用方管理状态
    this.heartPulse = Math.max(this.heartPulse, i);
    this.thump(g, t0, i, 1);
    this.thump(g, t0 + 0.26, i * 0.72, 0.88);
  }

  /** 呼吸，intensity 0..1 */
  breath(intensity: number): void {
    const g = this.live();
    if (!g) return;
    const i = clamp01(intensity);
    if (i < 0.02) return;
    const t0 = g.ctx.currentTime + 0.01;
    // 吸气：带通上扫、起音慢；呼气：带通下扫、更长更闷 —— 方向感来自扫动而不是音量
    playBuf(g, this.noise(g, 2), 0.15 * i, {
      time: t0, offset: Math.random(), filter: 'bandpass', freq: 420, freqEnd: 1500, sweep: 0.45,
      q: 0.9, attack: 0.16, decay: 0.42, pan: -0.05, verb: 0.1,
    });
    playBuf(g, this.noise(g, 2), 0.12 * i, {
      time: t0 + 0.62, offset: Math.random(), filter: 'bandpass', freq: 1300, freqEnd: 330, sweep: 0.55,
      q: 0.8, attack: 0.1, decay: 0.6, pan: 0.05, verb: 0.1,
    });
  }

  /** 被鞭打/击打：皮肉闷响 */
  lash(): void {
    const g = this.live();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.003;
    const pan = rand(-0.25, 0.25);
    // 鞭梢的破空声：极短、极窄，只有 20ms
    playBuf(g, this.noise(g, 0.2), 0.38, { time: t0, filter: 'bandpass', freq: 2200, q: 1.5, attack: 0.0004, decay: 0.02, pan });
    // 落在皮肉上：低频闷响 + 低通过的噪声（身体的"软组织"没有金属分音）
    playOsc(g, { type: 'sine', freq: 105, freqEnd: 62, peak: 0.45, attack: 0.003, decay: 0.12, time: t0, filter: 'lowpass', cutoff: 240, q: 0.9, drive: 0.2, verb: 0.2, pan });
    playBuf(g, this.noise(g, 0.4), 0.26, { time: t0, filter: 'lowpass', freq: 300, q: 0.9, attack: 0.002, decay: 0.18, verb: 0.2, pan });
    // 皮肤上的灼痛尾音
    playBuf(g, this.noise(g, 0.2), 0.08, { time: t0 + 0.01, filter: 'bandpass', freq: 3400, q: 2, attack: 0.001, decay: 0.06, pan });
  }

  /** 小孩的哭声（合成，不要用采样；用共振峰滤波的脉冲串近似呜咽） */
  childCry(intensity: number): void {
    try {
      this.spawnChildCry(intensity);
    } catch {
      // 静默降级
    }
  }

  private spawnChildCry(intensity: number): void {
    const g = this.live();
    if (!g) return;
    const i = clamp01(intensity);
    if (i < 0.03) return;
    const ctx = g.ctx;
    const t0 = ctx.currentTime + 0.02;
    const sobs = i > 0.6 ? 3 : 2;
    const sobDur = 0.55;
    const total = sobs * 0.62 + 0.4;

    const bus = ctx.createGain();
    bus.gain.value = 0.42;
    bus.connect(g.mix);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    bus.connect(send);
    send.connect(g.reverbSend);

    // 声源：锯齿波 ≈ 声带的脉冲串；真正让它变成"人声"的是后面那组共振峰
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const vib = ctx.createOscillator();
    vib.type = 'sine';
    vib.frequency.value = rand(5.2, 6.4);
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = rand(9, 16); // cents
    vib.connect(vibAmt);
    vibAmt.connect(osc.detune);

    // 呼吸噪声：混一点气声，哭声才不会像合成器
    const breathSrc = ctx.createBufferSource();
    breathSrc.buffer = this.noise(g, 1.5);
    breathSrc.loop = true;
    const breathBp = ctx.createBiquadFilter();
    breathBp.type = 'bandpass';
    breathBp.frequency.value = 2400;
    breathBp.Q.value = 0.8;
    const breathGain = ctx.createGain();
    breathGain.gain.value = 0;

    const amp = ctx.createGain();
    amp.gain.value = 0;
    osc.connect(amp);
    const formantNodes: AudioNode[] = [];
    for (const [f, q, fg] of FORMANTS) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const fGain = ctx.createGain();
      fGain.gain.value = fg;
      amp.connect(bp);
      bp.connect(fGain);
      fGain.connect(bus);
      formantNodes.push(bp, fGain);
    }
    breathBp.connect(breathGain);
    breathGain.connect(bus);

    // 每一声呜咽：音高从高滑落（哭腔的"拐点"），强度随疲劳递减
    for (let k = 0; k < sobs; k++) {
      const ts = t0 + k * 0.62;
      const base = rand(360, 430) * (1 - 0.06 * k);
      osc.frequency.setValueAtTime(base * 1.05, ts);
      osc.frequency.exponentialRampToValueAtTime(base * 0.78, ts + sobDur);
      const a = 0.55 * i * (1 - 0.22 * k);
      amp.gain.setValueAtTime(0.0001, ts);
      amp.gain.linearRampToValueAtTime(a, ts + 0.09);
      amp.gain.setValueAtTime(a, ts + 0.22);
      amp.gain.exponentialRampToValueAtTime(0.0005, ts + sobDur);
      amp.gain.linearRampToValueAtTime(0.0001, ts + sobDur + 0.03);
      breathGain.gain.setValueAtTime(0.0001, ts);
      breathGain.gain.linearRampToValueAtTime(a * 0.2, ts + 0.1);
      breathGain.gain.linearRampToValueAtTime(0.0001, ts + sobDur);
    }

    osc.start(t0);
    vib.start(t0);
    breathSrc.start(t0, Math.random());
    osc.stop(t0 + total);
    vib.stop(t0 + total);
    breathSrc.stop(t0 + total);
    this.retire([bus, send, osc, vib, vibAmt, amp, breathSrc, breathBp, breathGain, ...formantNodes], t0 + total + 0.3);
  }

  // ── 持续层 ─────────────────────────────────────────────────

  /** 切换环境层，带交叉淡化。 */
  setAmbience(id: AmbienceId, fadeSeconds?: number): void {
    this.ambience = id; // 先记录意图：音频没启动时，resume 之后会补上
    const g = this.g;
    if (!g) return;
    if (g.ctx.state !== 'running') return;
    this.applyAmbience(id, fadeSeconds ?? 1.5);
  }

  /** 光照/空间预设切换时改变混响与闷度（'hall' | 'vault' | 'outdoor' | 'shore'）。 */
  setSpace(id: 'hall' | 'vault' | 'outdoor' | 'shore'): void {
    this.space = id;
    const g = this.g;
    if (g) this.applySpace(g);
  }

  update(dt: number): void {
    if (this.disposed) return;
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    const now = g.ctx.currentTime;
    const d = dt > 0 ? Math.min(dt, 0.1) : 0; // 钳制掉帧：慢调制不能因为一帧卡顿就跳变
    for (const v of this.voices.values()) v.update(d, now);
    this.pruneVoices(now);
    this.collectRetired(now);
    // 心跳余韵自然衰减，并驱动低频"血涌"床：压迫感只在实际心跳密集时出现。
    // 这里顺手自愈非有限值，保证任何一次异常输入都不会永久污染低频床
    const pulse = Number.isFinite(this.heartPulse) ? Math.max(0, this.heartPulse - d * 0.85) : 0;
    this.heartPulse = pulse;
    g.heartBed.gain.setTargetAtTime(0.045 * pulse * pulse, now, 0.9);
  }

  // ── 内部：图与状态 ─────────────────────────────────────────

  /** 只在音频真正可用（running）时返回图；否则返回 null，所有发声方法据此静默降级。 */
  private live(): Graph | null {
    if (this.disposed) return null;
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return null;
    // 顺手回收到期节点：即使调用方从不调用 update()，也不会长期泄漏
    this.collectRetired(g.ctx.currentTime);
    return g;
  }

  private ensureGraph(): Graph | null {
    if (this.disposed) return null;
    if (this.g) return this.g;
    const Ctor = getAudioContextCtor();
    if (!Ctor) return null;
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.g = this.buildGraph(ctx);
      return this.g;
    } catch {
      // 隐私模式、自动播放策略、上下文数量超限：一律退化为静音
      return null;
    }
  }

  private buildGraph(ctx: AudioContext): Graph {
    const mix = ctx.createGain();
    mix.gain.value = 1;
    const muffle = ctx.createGain();
    muffle.gain.value = 1;
    const muffleLP = ctx.createBiquadFilter();
    muffleLP.type = 'lowpass';
    muffleLP.frequency.value = 18000;
    muffleLP.Q.value = 0.7;
    const master = ctx.createGain();
    master.gain.value = 0;
    // 总线限幅器：枪声这类瞬态的峰值叠加必须在这里被按住，否则会在输出端硬削波
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.15;

    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 1;
    const conv = ctx.createConvolver();
    conv.normalize = true;
    const wetDamp = ctx.createBiquadFilter();
    wetDamp.type = 'lowpass';
    wetDamp.frequency.value = 6000;
    wetDamp.Q.value = 0.6;
    const wet = ctx.createGain();
    wet.gain.value = 0;

    const shotSend = ctx.createGain();
    shotSend.gain.value = 1;
    const shotConv = ctx.createConvolver();
    shotConv.normalize = true;
    const shotDamp = ctx.createBiquadFilter();
    shotDamp.type = 'lowpass';
    shotDamp.frequency.value = 7000;
    shotDamp.Q.value = 0.6;
    const shotWet = ctx.createGain();
    shotWet.gain.value = 0;

    const hum = ctx.createGain();
    hum.gain.value = 0;
    const humA = ctx.createOscillator();
    humA.type = 'sine';
    humA.frequency.value = 50;
    const humB = ctx.createOscillator();
    humB.type = 'sine';
    humB.frequency.value = 100;
    const humBGain = ctx.createGain();
    humBGain.gain.value = 0.28;

    const tinnitus = ctx.createGain();
    tinnitus.gain.value = 0;
    const tinA = ctx.createOscillator();
    tinA.type = 'sine';
    tinA.frequency.value = 4180;
    const tinB = ctx.createOscillator();
    tinB.type = 'sine';
    tinB.frequency.value = 6320;
    const tinBGain = ctx.createGain();
    tinBGain.gain.value = 0.6;

    const heartBed = ctx.createGain();
    heartBed.gain.value = 0;
    const hbA = ctx.createOscillator();
    hbA.type = 'sine';
    hbA.frequency.value = 38;
    const hbB = ctx.createOscillator();
    hbB.type = 'sine';
    hbB.frequency.value = 41.5;
    const hbLP = ctx.createBiquadFilter();
    hbLP.type = 'lowpass';
    hbLP.frequency.value = 120;
    hbLP.Q.value = 0.8;

    mix.connect(muffle);
    muffle.connect(muffleLP);
    muffleLP.connect(master);
    master.connect(limiter);
    limiter.connect(ctx.destination);

    reverbSend.connect(conv);
    conv.connect(wetDamp);
    wetDamp.connect(wet);
    wet.connect(mix);

    shotSend.connect(shotConv);
    shotConv.connect(shotDamp);
    shotDamp.connect(shotWet);
    shotWet.connect(mix);

    humA.connect(hum);
    humB.connect(humBGain);
    humBGain.connect(hum);
    hum.connect(mix);

    // 耳鸣与血涌床直连 master：它们要绕过闷度低通（耳鸣本来就是高频）
    tinA.connect(tinnitus);
    tinB.connect(tinBGain);
    tinBGain.connect(tinnitus);
    tinnitus.connect(master);

    hbA.connect(hbLP);
    hbB.connect(hbLP);
    hbLP.connect(heartBed);
    heartBed.connect(mix);

    humA.start();
    humB.start();
    tinA.start();
    tinB.start();
    hbA.start();
    hbB.start();

    const graph: Graph = {
      ctx, mix, muffle, muffleLP, master, limiter,
      reverbSend, conv, wetDamp, wet,
      shotSend, shotConv, shotDamp, shotWet,
      hum, tinnitus, heartBed,
    };
    master.gain.value = this.level();
    this.applySpace(graph);
    this.applyMuffle(graph);
    return graph;
  }

  private level(): number {
    if (this.muted) return 0;
    const v = clamp01(this.volume);
    // 平方映射：响度感知更接近功率而非线性；0.9 是留给瞬态叠加的固定余量
    return 0.9 * v * v;
  }

  private applyMuffle(g: Graph): void {
    const a = this.muffleAmount;
    const t = g.ctx.currentTime;
    // 只压到一半：全压会变成"耳朵被塞住"，而我们要的是"隔了一段距离"
    g.muffle.gain.setTargetAtTime(1 - 0.5 * a, t, 0.12);
    g.muffleLP.frequency.setTargetAtTime(18000 * Math.pow(0.025, a), t, 0.12);
    g.tinnitus.gain.setTargetAtTime(0.02 * a * a, t, 0.6);
  }

  private applySpace(g: Graph): void {
    const p = SPACES[this.space];
    try {
      const t = g.ctx.currentTime;
      const ir = this.ir(g, this.space);
      // 换 buffer 会让卷积器重置，尾巴上会有一处极短的断裂；湿声比例同时做渐变，把它掩过去
      if (g.conv.buffer !== ir) g.conv.buffer = ir;
      g.wet.gain.setTargetAtTime(p.wet, t, 0.4);
      g.wetDamp.frequency.setTargetAtTime(p.damp, t, 0.4);
      g.hum.gain.setTargetAtTime(p.hum, t, 0.5);
    } catch {
      // 上下文已回收：保持旧空间参数即可
    }
  }

  private applyAmbience(id: AmbienceId, fadeSeconds: number): void {
    const g = this.g;
    if (!g) return;
    const fade = Math.max(0.02, Math.min(10, Number.isFinite(fadeSeconds) ? fadeSeconds : 1.5));
    const existing = this.voices.get(id);

    // 先让其它层淡出：交叉淡化靠两条独立包络叠加，而不是共享一个总音量
    for (const [key, v] of this.voices) {
      if (key !== id) v.release(fade);
    }
    if (id === 'silence') return;

    let voice = existing;
    if (!voice) {
      const built = this.buildVoice(g, id);
      if (!built) return;
      voice = built;
      this.voices.set(id, voice);
    }
    const t = g.ctx.currentTime;
    voice.stopAt = Number.POSITIVE_INFINITY;
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(Math.max(0, voice.gain.gain.value), t);
    voice.gain.gain.linearRampToValueAtTime(1, t + fade);
  }

  private buildVoice(g: Graph, id: AmbienceId): AmbienceVoice | null {
    try {
      switch (id) {
        case 'sea':
          return this.buildSea(g);
        case 'cicada':
          return this.buildCicada(g);
        case 'hall':
          return this.buildHallTone(g);
        case 'vault':
          return this.buildVaultTone(g);
        case 'wind':
          return this.buildWind(g);
        case 'chant':
          return this.buildChant(g);
        case 'silence':
          return null;
      }
    } catch {
      // 建层失败就当作静音：宁可没有环境音，也不能把异常抛给调用方
      return null;
    }
  }

  private pruneVoices(now: number): void {
    if (this.voices.size === 0) return;
    const dead: AmbienceId[] = [];
    for (const [id, v] of this.voices) {
      if (v.stopAt <= now) dead.push(id);
    }
    for (const id of dead) {
      const v = this.voices.get(id);
      if (!v) continue;
      v.kill();
      this.voices.delete(id);
    }
  }

  /** 登记一批到期即可断开的临时节点。 */
  private retire(nodes: AudioNode[], at: number): void {
    this.retired.push({ at, nodes });
  }

  private collectRetired(now: number): void {
    if (this.retired.length === 0) return;
    const keep: { at: number; nodes: AudioNode[] }[] = [];
    for (const item of this.retired) {
      if (item.at <= now) disconnectAll(item.nodes);
      else keep.push(item);
    }
    this.retired = keep;
  }

  // ── 内部：资源缓存 ─────────────────────────────────────────

  /** 噪声缓冲按长度复用：每次发声都新建 buffer 会带来持续的 GC 压力。 */
  private noise(g: Graph, seconds: number): AudioBuffer {
    let buf = this.noiseCache.get(seconds);
    if (!buf) {
      buf = makeNoiseBuffer(g.ctx, seconds);
      this.noiseCache.set(seconds, buf);
    }
    return buf;
  }

  private ir(g: Graph, kind: SpaceKind): AudioBuffer {
    let buf = this.irCache.get(kind);
    if (!buf) {
      const spec = IR_SPECS[kind];
      buf = makeImpulseResponse(g.ctx, spec.seconds, spec.decay);
      this.irCache.set(kind, buf);
    }
    return buf;
  }

  // ── 内部：音效零件 ─────────────────────────────────────────

  /** 弹壳/黄铜小件的叮当：几个非谐高频分音错开几十毫秒，听感上就是"弹壳在跳"。 */
  private brassTinkle(g: Graph, t: number, amp: number, pan: number): void {
    const partials = [2860, 4120, 5310];
    for (let i = 0; i < partials.length; i++) {
      playOsc(g, {
        type: 'sine', freq: partials[i] * rand(0.98, 1.02), peak: amp * (0.5 - i * 0.12),
        attack: 0.001, decay: rand(0.05, 0.12), time: t, verb: 0.25, pan: pan + rand(-0.08, 0.08),
      });
    }
    playBuf(g, this.noise(g, 0.2), amp * 0.25, { time: t, offset: Math.random() * 0.1, filter: 'bandpass', freq: 4200, q: 3, attack: 0.0006, decay: 0.02, pan });
  }

  /** 心跳的单一下：低频正弦包络 + 一点点低通噪声，给"肉"的质感。 */
  private thump(g: Graph, t: number, amp: number, pitch: number): void {
    const peak = 0.55 * amp;
    playOsc(g, { type: 'sine', freq: 62 * pitch, freqEnd: 34 * pitch, peak, attack: 0.012, decay: 0.17, time: t, filter: 'lowpass', cutoff: 180, q: 0.7, drive: 0.15 });
    playBuf(g, this.noise(g, 0.5), peak * 0.22, { time: t, offset: Math.random() * 0.3, filter: 'lowpass', freq: 160, q: 0.8, attack: 0.01, decay: 0.12 });
  }

  // ── 内部：环境层实现 ───────────────────────────────────────

  /** 环境层的公共外壳：统一的淡入淡出、回收与断链语义。 */
  private makeVoice(
    id: AmbienceId,
    out: GainNode,
    nodes: AudioNode[],
    sources: AudioScheduledSourceNode[],
    update: (dt: number, now: number) => void,
  ): AmbienceVoice {
    const voice: AmbienceVoice = {
      id,
      gain: out,
      stopAt: Number.POSITIVE_INFINITY,
      update,
      release: (fade) => {
        const t = out.context.currentTime;
        const f = Math.max(0.02, fade);
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(Math.max(0, out.gain.value), t);
        out.gain.linearRampToValueAtTime(0, t + f);
        voice.stopAt = t + f + 0.2;
      },
      kill: () => {
        for (const s of sources) {
          try {
            s.stop();
          } catch {
            // 尚未 start 或已停止：忽略
          }
        }
        disconnectAll(nodes);
      },
    };
    return voice;
  }

  /** 新建一个环境层的输出段：干声 + 固定比例的混响送出。 */
  private makeBed(g: Graph, verb: number): { out: GainNode; panner: StereoPannerNode; nodes: AudioNode[] } {
    const ctx = g.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = 0;
    out.connect(panner);
    panner.connect(g.mix);
    const send = ctx.createGain();
    send.gain.value = verb;
    panner.connect(send);
    send.connect(g.reverbSend);
    return { out, panner, nodes: [out, panner, send] };
  }

  /** 海：低频噪声经缓慢移动的低通 + 随机浪涌包络。 */
  private buildSea(g: Graph): AmbienceVoice {
    const ctx = g.ctx;
    const { out, panner, nodes } = this.makeBed(g, 0.3);
    const sources: AudioScheduledSourceNode[] = [];

    // 主体：两层低通叠出"水"的厚度，频率随浪涌一起移动
    const body = ctx.createBufferSource();
    body.buffer = this.noise(g, 4);
    body.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    lp.Q.value = 0.9;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 180;
    lp2.Q.value = 0.7;
    const swell = ctx.createGain();
    swell.gain.value = 0.3;
    body.connect(lp);
    lp.connect(lp2);
    lp2.connect(swell);
    swell.connect(out);
    body.start(ctx.currentTime, Math.random() * 3);

    // 泡沫：高频窄带噪声，只在浪头涌上来时出现，是"近岸"的关键
    const foam = ctx.createBufferSource();
    foam.buffer = this.noise(g, 3);
    foam.loop = true;
    const foamBp = ctx.createBiquadFilter();
    foamBp.type = 'bandpass';
    foamBp.frequency.value = 2600;
    foamBp.Q.value = 0.55;
    const foamGain = ctx.createGain();
    foamGain.gain.value = 0.02;
    foam.connect(foamBp);
    foamBp.connect(foamGain);
    foamGain.connect(out);
    foam.start(ctx.currentTime, Math.random() * 2);

    sources.push(body, foam);
    nodes.push(body, lp, lp2, swell, foam, foamBp, foamGain);

    // 两个不成整数比的慢相位 → 浪与浪之间的间隔不规则，像真的海
    let p1 = Math.random() * 6.283;
    let p2 = Math.random() * 6.283;
    let p3 = Math.random() * 6.283;
    return this.makeVoice('sea', out, nodes, sources, (dt, now) => {
      p1 += dt * 0.052;
      p2 += dt * 0.031;
      p3 += dt * 0.017;
      const s = clamp01(0.5 + 0.34 * Math.sin(p1) + 0.26 * Math.sin(p2));
      lp.frequency.setTargetAtTime(160 + 780 * s, now, 0.7);
      swell.gain.setTargetAtTime(0.14 + 0.7 * s, now, 0.55);
      foamGain.gain.setTargetAtTime(0.015 + 0.55 * s * s * s, now, 0.4);
      panner.pan.setTargetAtTime(0.28 * Math.sin(p3), now, 0.9);
    });
  }

  /** 蝉：带通噪声（3–5kHz）+ 高频 AM 调制，音量缓慢起伏。 */
  private buildCicada(g: Graph): AmbienceVoice {
    const ctx = g.ctx;
    const { out, panner, nodes } = this.makeBed(g, 0.18);
    const sources: AudioScheduledSourceNode[] = [];
    const swell = ctx.createGain();
    swell.gain.value = 0.5;
    swell.connect(out);
    nodes.push(swell);

    // 两路不同中心频率与调制速率的鸣声错开，避免整片林子变成一台机器
    const bands: readonly (readonly [number, number, number])[] = [
      [4300, 1.1, 46],
      [3400, 1.4, 37],
    ];
    for (const [freq, q, amRate] of bands) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise(g, 3);
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;
      const am = ctx.createGain();
      am.gain.value = 0.5;
      const buzz = ctx.createOscillator();
      buzz.type = 'sine';
      buzz.frequency.value = amRate;
      const buzzAmt = ctx.createGain();
      buzzAmt.gain.value = 0.45;
      buzz.connect(buzzAmt);
      buzzAmt.connect(am.gain);
      src.connect(bp);
      bp.connect(am);
      am.connect(swell);
      src.start(ctx.currentTime, Math.random() * 2);
      buzz.start(ctx.currentTime);
      sources.push(src, buzz);
      nodes.push(src, bp, am, buzz, buzzAmt);
    }

    let p1 = Math.random() * 6.283;
    let p2 = Math.random() * 6.283;
    let p3 = Math.random() * 6.283;
    return this.makeVoice('cicada', out, nodes, sources, (dt, now) => {
      p1 += dt * 0.09;
      p2 += dt * 0.043;
      p3 += dt * 0.021;
      const s = clamp01(0.5 + 0.36 * Math.sin(p1) + 0.24 * Math.sin(p2));
      // 蝉鸣的"起伏"是整片林子同时安静下来又同时响起，所以只调总电平与亮度
      swell.gain.setTargetAtTime(0.18 + 0.72 * s, now, 0.9);
      panner.pan.setTargetAtTime(0.35 * Math.sin(p3), now, 1.1);
    });
  }

  /** 礼厅的室内底噪：空调与人群的低频轰鸣 + 一点点空气感。 */
  private buildHallTone(g: Graph): AmbienceVoice {
    const ctx = g.ctx;
    const { out, panner, nodes } = this.makeBed(g, 0.45);
    const sources: AudioScheduledSourceNode[] = [];

    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise(g, 4);
    rumble.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.Q.value = 0.6;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.2;
    rumble.connect(lp);
    lp.connect(rumbleGain);
    rumbleGain.connect(out);
    rumble.start(ctx.currentTime, Math.random() * 3);

    const air = ctx.createBufferSource();
    air.buffer = this.noise(g, 3);
    air.loop = true;
    const airBp = ctx.createBiquadFilter();
    airBp.type = 'bandpass';
    airBp.frequency.value = 5200;
    airBp.Q.value = 0.5;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.015;
    air.connect(airBp);
    airBp.connect(airGain);
    airGain.connect(out);
    air.start(ctx.currentTime, Math.random() * 2);

    // 结构低频：大空间里那两条几乎听不见、但"在场"的正弦
    for (const f of [62, 93]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = 0.014;
      osc.connect(og);
      og.connect(out);
      osc.start(ctx.currentTime);
      sources.push(osc);
      nodes.push(osc, og);
    }

    sources.push(rumble, air);
    nodes.push(rumble, lp, rumbleGain, air, airBp, airGain);

    let p1 = Math.random() * 6.283;
    let p2 = Math.random() * 6.283;
    return this.makeVoice('hall', out, nodes, sources, (dt, now) => {
      p1 += dt * 0.021;
      p2 += dt * 0.009;
      // 极慢的呼吸：房间不能是静止的，否则会被听成"一条循环音频"
      lp.frequency.setTargetAtTime(190 + 90 * (0.5 + 0.5 * Math.sin(p1)), now, 1.6);
      airGain.gain.setTargetAtTime(0.012 + 0.012 * (0.5 + 0.5 * Math.sin(p2)), now, 1.6);
      panner.pan.setTargetAtTime(0.08 * Math.sin(p1 * 0.7), now, 2);
    });
  }

  /** 日光灯的 50Hz 嗡鸣 + 极轻的电流噪声。 */
  private buildVaultTone(g: Graph): AmbienceVoice {
    const ctx = g.ctx;
    const { out, nodes } = this.makeBed(g, 0.12);
    const sources: AudioScheduledSourceNode[] = [];

    const buzz = ctx.createGain();
    buzz.gain.value = 0.05;
    buzz.connect(out);
    nodes.push(buzz);
    // 50Hz 基频 + 100/150 谐波：镇流器的嗡鸣从来不是纯正弦
    const parts: readonly (readonly [number, number])[] = [
      [50, 1],
      [100, 0.32],
      [150, 0.12],
    ];
    for (const [f, level] of parts) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = level;
      osc.connect(og);
      og.connect(buzz);
      osc.start(ctx.currentTime);
      sources.push(osc);
      nodes.push(osc, og);
    }

    const current = ctx.createBufferSource();
    current.buffer = this.noise(g, 3);
    current.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 2.5;
    const curGain = ctx.createGain();
    curGain.gain.value = 0.012;
    current.connect(bp);
    bp.connect(curGain);
    curGain.connect(out);
    current.start(ctx.currentTime, Math.random() * 2);
    sources.push(current);
    nodes.push(current, bp, curGain);

    let p1 = Math.random() * 6.283;
    let flicker = 1;
    let nextFlicker = 0;
    return this.makeVoice('vault', out, nodes, sources, (dt, now) => {
      p1 += dt * 0.7;
      // 随机游走的闪烁：灯管的抖动不是正弦，而是一次次电平小跳
      if (now >= nextFlicker) {
        flicker = rand(0.82, 1.14);
        nextFlicker = now + rand(0.6, 2.4);
      }
      buzz.gain.setTargetAtTime(0.05 * flicker, now, 0.06);
      curGain.gain.setTargetAtTime(0.012 * (0.85 + 0.15 * Math.sin(p1)) * flicker, now, 0.08);
    });
  }

  /** 风：噪声经中心频率缓慢扫动的带通，加不规则的阵风包络。 */
  private buildWind(g: Graph): AmbienceVoice {
    const ctx = g.ctx;
    const { out, panner, nodes } = this.makeBed(g, 0.2);
    const sources: AudioScheduledSourceNode[] = [];

    const body = ctx.createBufferSource();
    body.buffer = this.noise(g, 4);
    body.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 600;
    bp.Q.value = 0.7;
    const gust = ctx.createGain();
    gust.gain.value = 0.5;
    body.connect(bp);
    bp.connect(gust);
    gust.connect(out);
    body.start(ctx.currentTime, Math.random() * 3);

    // 低频层：只有它，风才有体积
    const low = ctx.createBufferSource();
    low.buffer = this.noise(g, 4);
    low.loop = true;
    const lowLP = ctx.createBiquadFilter();
    lowLP.type = 'lowpass';
    lowLP.frequency.value = 160;
    lowLP.Q.value = 0.7;
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0.12;
    low.connect(lowLP);
    lowLP.connect(lowGain);
    lowGain.connect(out);
    low.start(ctx.currentTime, Math.random() * 3);

    // 掠过缝隙时的哨音：极窄的带通，只在阵风峰值附近出现
    const edge = ctx.createBufferSource();
    edge.buffer = this.noise(g, 3);
    edge.loop = true;
    const edgeBp = ctx.createBiquadFilter();
    edgeBp.type = 'bandpass';
    edgeBp.frequency.value = 780;
    edgeBp.Q.value = 6;
    const edgeGain = ctx.createGain();
    edgeGain.gain.value = 0;
    edge.connect(edgeBp);
    edgeBp.connect(edgeGain);
    edgeGain.connect(out);
    edge.start(ctx.currentTime, Math.random() * 2);

    sources.push(body, low, edge);
    nodes.push(body, bp, gust, low, lowLP, lowGain, edge, edgeBp, edgeGain);

    let p1 = Math.random() * 6.283;
    let p2 = Math.random() * 6.283;
    let p3 = Math.random() * 6.283;
    let p4 = Math.random() * 6.283;
    return this.makeVoice('wind', out, nodes, sources, (dt, now) => {
      p1 += dt * 0.061;
      p2 += dt * 0.028;
      p3 += dt * 0.043;
      p4 += dt * 0.012;
      const g1 = clamp01(0.45 + 0.4 * Math.sin(p1) + 0.3 * Math.sin(p2));
      bp.frequency.setTargetAtTime(300 + 1300 * g1, now, 1.1);
      gust.gain.setTargetAtTime(0.1 + 0.8 * g1, now, 0.8);
      const w = Math.max(0, Math.sin(p3));
      edgeGain.gain.setTargetAtTime(0.05 * Math.pow(w, 4) * (0.4 + g1), now, 0.5);
      panner.pan.setTargetAtTime(0.35 * Math.sin(p4), now, 1.4);
    });
  }

  /** 礼厅里信徒齐声的低频哼鸣：靠"分叉的音高 + 各自的漂移"伪造人数。 */
  private buildChant(g: Graph): AmbienceVoice {
    const ctx = g.ctx;
    const { out, panner, nodes } = this.makeBed(g, 0.45);
    const sources: AudioScheduledSourceNode[] = [];

    const swell = ctx.createGain();
    swell.gain.value = 0.85;
    swell.connect(out);
    nodes.push(swell);

    // 音高刻意不成整数比：齐唱里"没对准"的那几个人，正是合唱感的来源
    const pitches = [78.2, 87.6, 96.4, 104.9];
    const voiceGains: GainNode[] = [];
    const voiceBase: number[] = [];
    const drift: number[] = [];

    for (let i = 0; i < pitches.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i < 2 ? 'sawtooth' : 'sine';
      osc.frequency.value = pitches[i] * rand(0.995, 1.005);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300 + i * 45;
      lp.Q.value = 0.9;
      // 锯齿谐波丰富，电平要压得比正弦更低
      const base = i < 2 ? 0.075 : 0.11;
      const vg = ctx.createGain();
      vg.gain.value = base;
      // 每个人的颤音频率与深度都不同：相位一错开，就不再像"一台合成器"
      const vib = ctx.createOscillator();
      vib.type = 'sine';
      vib.frequency.value = rand(4.3, 6.1);
      const vibAmt = ctx.createGain();
      vibAmt.gain.value = rand(3, 7); // cents
      vib.connect(vibAmt);
      vibAmt.connect(osc.detune);
      osc.connect(lp);
      lp.connect(vg);
      vg.connect(swell);
      osc.start(ctx.currentTime);
      vib.start(ctx.currentTime);
      sources.push(osc, vib);
      nodes.push(osc, vib, vibAmt, lp, vg);
      voiceGains.push(vg);
      voiceBase.push(base);
      drift.push(rand(0.07, 0.16));
    }

    // 人声底噪：呼吸、衣料、厅堂里的人体，把"电子嗡鸣"往"一群人"的方向拉
    const crowd = ctx.createBufferSource();
    crowd.buffer = this.noise(g, 4);
    crowd.loop = true;
    const crowdLP = ctx.createBiquadFilter();
    crowdLP.type = 'lowpass';
    crowdLP.frequency.value = 420;
    crowdLP.Q.value = 0.7;
    const crowdGain = ctx.createGain();
    crowdGain.gain.value = 0.05;
    crowd.connect(crowdLP);
    crowdLP.connect(crowdGain);
    crowdGain.connect(swell);
    crowd.start(ctx.currentTime, Math.random() * 3);
    sources.push(crowd);
    nodes.push(crowd, crowdLP, crowdGain);

    let p1 = Math.random() * 6.283;
    let p2 = Math.random() * 6.283;
    let p3 = Math.random() * 6.283;
    const phases = drift.map(() => Math.random() * 6.283);
    return this.makeVoice('chant', out, nodes, sources, (dt, now) => {
      p1 += dt * 0.13;
      p2 += dt * 0.047;
      p3 += dt * 0.019;
      const s = 0.5 + 0.3 * Math.sin(p1) + 0.2 * Math.sin(p2);
      swell.gain.setTargetAtTime(0.7 + 0.3 * s, now, 0.8);
      for (let i = 0; i < voiceGains.length; i++) {
        phases[i] += dt * drift[i];
        // 各自的音量漂移：让"齐声"始终在轻微地互相咬合
        voiceGains[i].gain.setTargetAtTime(voiceBase[i] * (0.72 + 0.28 * Math.sin(phases[i])), now, 0.6);
      }
      panner.pan.setTargetAtTime(0.18 * Math.sin(p3), now, 1.2);
    });
  }
}
