/**
 * 全片配色。取自片中三处光线：礼厅的灯笼暖黄、密室的惨绿日光灯、
 * 海边的过曝灰白。整体压饱和，接近低成本胶片的偏色。
 */
export const P = {
  // ── 建筑 ───────────────────────────────────────────────
  concrete: 0x9d978a,
  concreteDark: 0x6d685e,
  concreteWet: 0x585349,
  plaster: 0xb4ab99,
  plasterStain: 0x8a8172,
  stone: 0x8b8577,
  stoneDark: 0x5d584e,
  tile: 0x7c5a4a,
  tileDark: 0x4d3a30,
  wood: 0x6d4c2f,
  woodDark: 0x3d2a1a,
  woodWorn: 0x574433,
  lacquer: 0x75302a,
  lacquerDark: 0x4a1d19,

  // ── 光与布 ─────────────────────────────────────────────
  lantern: 0xe3b055,
  lanternDim: 0xa87c38,
  cloth: 0xb3a68d,
  clothDark: 0x6f6552,
  banner: 0x8c3227,
  incense: 0x6a4a30,

  // ── 植被与地形 ─────────────────────────────────────────
  veg: 0x4f5f3b,
  vegDark: 0x333f28,
  vegDry: 0x6d6a3e,
  sand: 0xbcae92,
  sandWet: 0x8b7f68,
  rock: 0x767065,
  hill: 0x6a6b52,

  // ── 天与海 ─────────────────────────────────────────────
  sky: 0xb0b8b4,
  skyDusk: 0x8e8189,
  skyNight: 0x1a1f26,
  sea: 0x41585f,
  seaDeep: 0x263a41,
  foam: 0xd6d9d2,

  // ── 人 ─────────────────────────────────────────────────
  skin: 0xc7a184,
  skinDark: 0x9d7a5e,
  hair: 0x1c1916,
  robe: 0xc3c0b2,
  robeDark: 0x8e8b7e,
  robeTrim: 0x5a5346,
  pants: 0x4b4f52,
  shoe: 0x2a2724,
  /** 陈桂林：深色夹克 + 那条奶奶留下的表。 */
  jacket: 0x3b3f45,
  jacketDark: 0x25282c,
  watch: 0xc9a227,

  // ── 密室 ───────────────────────────────────────────────
  greenLamp: 0x9ed9a4,
  cash: 0x7c8f5c,
  gold: 0xc9a227,
  jewel: 0x8fb6c4,
  steel: 0x8b9198,
  steelDark: 0x555a60,
  paper: 0xd8d2c0,
  ink: 0x2b2a26,

  // ── 血与伤（低多边形、非血腥） ─────────────────────────
  bruise: 0x5c3a3c,
  driedBlood: 0x5a2b23,

  // ── 枪械 ───────────────────────────────────────────────
  gunBody: 0x2f3236,
  gunSlide: 0x4a4f55,
  gunGrip: 0x241f1c,
  muzzle: 0xf2d9a4,
} as const;

export type PaletteKey = keyof typeof P;

/** 章节光照预设：环境色、雾色、主光色与强度。 */
export interface LightPreset {
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  sunDir: [number, number, number];
  fog: number;
  fogDensity: number;
  exposure: number;
  saturation: number;
}

export const LIGHT_PRESETS = {
  /** 礼厅：室内，暖黄，压暗。 */
  hall: {
    hemiSky: 0x4a3a24,
    hemiGround: 0x241a10,
    hemiIntensity: 0.82,
    sunColor: 0xe3b055,
    sunIntensity: 1.0,
    sunDir: [0.25, 0.9, 0.35],
    fog: 0x1d1509,
    fogDensity: 0.024,
    exposure: 1.18,
    saturation: 1,
  },
  /** 前院：白天阴天，发灰。 */
  yard: {
    hemiSky: 0xb6bcb6,
    hemiGround: 0x6a6350,
    hemiIntensity: 1.15,
    sunColor: 0xd8dcd4,
    sunIntensity: 0.5,
    sunDir: [-0.4, 0.85, -0.3],
    fog: 0xa9b0ac,
    fogDensity: 0.016,
    exposure: 1,
    saturation: 1,
  },
  /** 密室：惨绿日光灯。 */
  vault: {
    hemiSky: 0x2c3a2e,
    hemiGround: 0x141a15,
    hemiIntensity: 0.52,
    sunColor: 0x9ed9a4,
    sunIntensity: 0.72,
    sunDir: [0, 1, 0.15],
    fog: 0x131a14,
    fogDensity: 0.045,
    exposure: 1.16,
    saturation: 1,
  },
  /** 山径：黄昏，青绿。逃跑段要看清人与路，所以整体比"真实黄昏"亮一档。 */
  path: {
    hemiSky: 0x9aa6a0,
    hemiGround: 0x4d5641,
    hemiIntensity: 1.55,
    sunColor: 0xe8b478,
    sunIntensity: 1.05,
    sunDir: [0.7, 0.4, 0.5],
    fog: 0x7d8580,
    fogDensity: 0.018,
    exposure: 1.16,
    saturation: 1,
  },
  /** 海边：过曝灰白。 */
  shore: {
    hemiSky: 0xd2d8d4,
    hemiGround: 0x9a9784,
    hemiIntensity: 1.5,
    sunColor: 0xf0f2ec,
    sunIntensity: 0.8,
    sunDir: [-0.25, 0.7, 0.6],
    fog: 0xc6cdc9,
    fogDensity: 0.012,
    exposure: 1.08,
    saturation: 1,
  },
} as const satisfies Record<string, LightPreset>;

export type LightPresetId = keyof typeof LIGHT_PRESETS;
