import {
  Color,
  FogExp2,
  HalfFloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  WebGLRenderer,
  WebGLRenderTarget,
  type PerspectiveCamera,
} from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * 单 pass 胶片后处理。
 *
 * 管线：场景以线性空间渲染进低分辨率 RT（three 对渲染目标强制 working color space），
 * 本 pass 在线性空间做去饱和与曝光，再编码到 sRGB，
 * 最后在显示空间叠加抖动、暗角、颗粒、闪白与转场压黑。
 * Nearest 放大 + 抖动噪点是"低成本胶片"质感的主要来源。
 */
const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uFade;
uniform vec3  uFadeColor;
uniform float uFlash;
uniform vec3  uFlashColor;
uniform float uDesat;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uAberration;
uniform float uBarrel;
uniform float uDither;
uniform float uPulse;
uniform float uLinearIn;
uniform float uBands;

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);

  // 轻微的桶形畸变：镜头是旧的
  uv += cc * r2 * uBarrel;

  // 色差，靠近边缘更明显
  float ab = uAberration * (0.35 + r2 * 2.4) * (1.0 + uPulse * 2.2);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + cc * ab).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - cc * ab).b;

  // ── 线性空间：去饱和 + 曝光 ────────────────────────────
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(lum), clamp(uDesat, 0.0, 1.0));
  col *= uExposure;

  // ── 编码到显示空间 ─────────────────────────────────────
  col = mix(col, linearToSRGB(col), uLinearIn);

  // 有序抖动：把 8bit 的色带打碎成颗粒
  float d = bayer4(gl_FragCoord.xy) - 0.5;
  col += d * uDither * (1.0 + uPulse * 2.0);

  // 可选的低位深量化（更强的年代感）
  if (uBands > 1.0) {
    col = floor(col * uBands + 0.5) / uBands;
  }

  float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum2), clamp(uDesat, 0.0, 1.0) * 0.35);

  // 暗角
  float vig = 1.0 - smoothstep(0.40, 1.06, length(cc) * 1.42);
  col *= mix(1.0, vig, clamp(uVignette + uPulse * 0.45, 0.0, 1.0));

  // 胶片颗粒
  float g = hash12(gl_FragCoord.xy + vec2(uTime * 91.7, uTime * 47.3)) - 0.5;
  col += g * uGrain;

  // 闪白 / 闪红（枪口、被击中）
  col += uFlashColor * uFlash;

  // 转场压黑
  col = mix(uFadeColor, col, clamp(uFade, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface RenderTuning {
  exposure: number;
  saturation: number;
}

export interface LookOpts {
  grain?: number;
  aberration?: number;
  barrel?: number;
  dither?: number;
  vignette?: number;
  bands?: number;
}

/**
 * 渲染层：场景 → 低分辨率 RT → 后处理铺满画布。
 * 同时持有所有"胶片级"状态：转场、闪白、冲击脉冲。
 */
export class Renderer {
  readonly gl: WebGLRenderer;
  readonly fog = new FogExp2(0x1d1509, 0.02);

  private rt: WebGLRenderTarget;
  private quadScene = new Scene();
  private quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: ShaderMaterial;
  private readonly quad: Mesh;

  scale = 0.62;
  private width = 1;
  private height = 1;
  private rtIsLinear: boolean;

  private fade = 0;
  private fadeTarget = 0;
  private fadeSpeed = 1.6;
  private fadeColor = new Color(0x000000);
  private flash = 0;
  private flashColor = new Color(0xffffff);
  private pulse = 0;
  private time = 0;
  private sceneCalls = 0;
  private sceneTris = 0;
  private tuning: RenderTuning = { exposure: 1, saturation: 1 };
  private tuningCurrent: RenderTuning = { exposure: 1, saturation: 1 };
  private look: Required<LookOpts> = {
    grain: 0.032,
    aberration: 0.0018,
    barrel: 0.05,
    dither: 0.010,
    vignette: 0.5,
    bands: 0,
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.gl = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.gl.setPixelRatio(1);
    this.gl.setClearColor(0x050505, 1);
    this.gl.outputColorSpace = SRGBColorSpace;
    this.gl.autoClear = true;

    // 渲染目标是线性空间，用半浮点避免暗部断层；不支持时退回 8bit。
    const halfOk = this.gl.extensions.has('EXT_color_buffer_half_float');
    this.rtIsLinear = true;
    this.rt = new WebGLRenderTarget(2, 2, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      format: RGBAFormat,
      type: halfOk ? HalfFloatType : UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    void SRGBColorSpace;

    this.mat = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uTime: { value: 0 },
        uFade: { value: 0 },
        uFadeColor: { value: new Color(0x000000) },
        uFlash: { value: 0 },
        uFlashColor: { value: new Color(0xffffff) },
        uDesat: { value: 0 },
        uExposure: { value: 1 },
        uVignette: { value: this.look.vignette },
        uGrain: { value: this.look.grain },
        uAberration: { value: this.look.aberration },
        uBarrel: { value: this.look.barrel },
        uDither: { value: this.look.dither },
        uPulse: { value: 0 },
        uLinearIn: { value: this.rtIsLinear ? 1 : 0 },
        uBands: { value: this.look.bands },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  get domElement(): HTMLCanvasElement {
    return this.canvas;
  }

  get drawCalls(): number {
    return this.sceneCalls;
  }

  get triangles(): number {
    return this.sceneTris;
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    this.gl.setSize(this.width, this.height, false);
    this.resizeTarget();
  }

  setScale(s: number): void {
    this.scale = Math.min(1, Math.max(0.25, s));
    this.resizeTarget();
  }

  private resizeTarget(): void {
    const w = Math.max(2, Math.round(this.width * this.scale));
    const h = Math.max(2, Math.round(this.height * this.scale));
    this.rt.setSize(w, h);
    this.mat.uniforms.tDiffuse!.value = this.rt.texture;
  }

  setTuning(t: Partial<RenderTuning>, instant = false): void {
    this.tuning = { ...this.tuning, ...t };
    if (instant) this.tuningCurrent = { ...this.tuning };
  }

  setLook(o: LookOpts): void {
    this.look = { ...this.look, ...o };
  }

  // ── 转场 ──────────────────────────────────────────────
  setFade(v: number): void {
    this.fade = Math.min(1, Math.max(0, v));
    this.fadeTarget = this.fade;
  }

  fadeTo(target: number, seconds: number, color?: Color | number): void {
    this.fadeTarget = Math.min(1, Math.max(0, target));
    const dist = Math.abs(this.fadeTarget - this.fade);
    this.fadeSpeed = seconds > 0 ? Math.max(dist / seconds, 0.0001) : 1e6;
    if (color !== undefined) this.fadeColor = new Color(color);
  }

  get fadeValue(): number {
    return this.fade;
  }

  get isBlack(): boolean {
    return this.fade <= 0.002;
  }

  /** 闪白/闪红（枪口火光、被击中）。自动衰减。 */
  kick(amount: number, color: Color | number = 0xffffff): void {
    this.flash = Math.min(1.4, this.flash + amount);
    this.flashColor = new Color(color);
  }

  /** 冲击脉冲：色差 + 抖动 + 暗角瞬间放大。 */
  impulse(amount: number): void {
    this.pulse = Math.min(1.2, this.pulse + amount);
  }

  update(dt: number): void {
    this.time += dt;

    if (this.fade !== this.fadeTarget) {
      const step = this.fadeSpeed * dt;
      if (Math.abs(this.fadeTarget - this.fade) <= step) this.fade = this.fadeTarget;
      else this.fade += Math.sign(this.fadeTarget - this.fade) * step;
    }

    this.flash = Math.max(0, this.flash - dt * 6.5);
    this.pulse = Math.max(0, this.pulse - dt * 2.4);

    const k = 1 - Math.exp(-4 * dt);
    this.tuningCurrent.exposure += (this.tuning.exposure - this.tuningCurrent.exposure) * k;
    this.tuningCurrent.saturation += (this.tuning.saturation - this.tuningCurrent.saturation) * k;

    const u = this.mat.uniforms;
    u.uTime!.value = this.time;
    u.uFade!.value = this.fade;
    u.uFadeColor!.value = this.fadeColor;
    u.uFlash!.value = this.flash;
    u.uFlashColor!.value = this.flashColor;
    u.uExposure!.value = this.tuningCurrent.exposure;
    u.uDesat!.value = 1 - this.tuningCurrent.saturation;
    u.uGrain!.value = this.look.grain;
    u.uAberration!.value = this.look.aberration;
    u.uBarrel!.value = this.look.barrel;
    u.uDither!.value = this.look.dither;
    u.uVignette!.value = this.look.vignette;
    u.uBands!.value = this.look.bands;
    u.uPulse!.value = this.pulse;
  }

  render(scene: Scene, camera: PerspectiveCamera): void {
    this.gl.setRenderTarget(this.rt);
    this.gl.clear();
    this.gl.render(scene, camera);
    // three 每次 render() 都会重置 info，所以要在后处理之前把场景那一趟的数字留下。
    this.sceneCalls = this.gl.info.render.calls;
    this.sceneTris = this.gl.info.render.triangles;
    this.gl.setRenderTarget(null);
    this.gl.clear();
    this.gl.render(this.quadScene, this.quadCam);
  }

  dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
    this.quad.geometry.dispose();
    this.gl.dispose();
  }
}
