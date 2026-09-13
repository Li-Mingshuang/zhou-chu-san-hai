import type { Group, Light } from 'three';
import type { Batcher } from '../render/Geo.js';
import type { MatLib } from '../render/Mats.js';
import type { Rng } from '../core/MathUtils.js';
import type { Interactable } from '../systems/Interaction.js';
import type { Level } from './Collision.js';
import { P } from '../render/Palette.js';

/** 全调色板的材质 key 表。世界构建器只认 key，不碰材质对象。 */
export type MatKeys = Record<keyof typeof P, string>;

export function createMatKeys(mats: MatLib): MatKeys {
  const out = {} as MatKeys;
  for (const k of Object.keys(P) as Array<keyof typeof P>) out[k] = mats.key(P[k]);

  // 需要自发光或特殊处理的少量例外
  out.lantern = mats.key(P.lantern, { emissive: P.lantern, emissiveIntensity: 1.05 });
  out.lanternDim = mats.key(P.lanternDim, { emissive: P.lanternDim, emissiveIntensity: 0.6 });
  out.greenLamp = mats.key(P.greenLamp, { emissive: P.greenLamp, emissiveIntensity: 1.15 });
  out.muzzle = mats.key(P.muzzle, { emissive: P.muzzle, emissiveIntensity: 1.6, unlit: true });
  out.foam = mats.key(P.foam, { emissive: P.foam, emissiveIntensity: 0.35 });
  out.sea = mats.key(P.sea, { unlit: true });
  out.seaDeep = mats.key(P.seaDeep, { unlit: true });
  out.sky = mats.key(P.sky, { unlit: true, side: 'back' });
  out.skyDusk = mats.key(P.skyDusk, { unlit: true, side: 'back' });
  out.gold = mats.key(P.gold, { metalness: 0.85, roughness: 0.3, emissive: 0x241a00 });
  out.steel = mats.key(P.steel, { metalness: 0.7, roughness: 0.42 });
  out.steelDark = mats.key(P.steelDark, { metalness: 0.65, roughness: 0.55 });
  out.watch = mats.key(P.watch, { metalness: 0.9, roughness: 0.25, emissive: 0x1c1400 });
  out.gunBody = mats.key(P.gunBody, { metalness: 0.75, roughness: 0.38 });
  out.gunSlide = mats.key(P.gunSlide, { metalness: 0.8, roughness: 0.3 });
  return out;
}

/**
 * 世界构建上下文。所有 build* 函数都只通过它接触引擎，
 * 于是每个场景都可以被单独构建、单独截图。
 */
export interface BuildCtx {
  /** 静态几何合批器（构建完会 build 成一个 Group）。 */
  b: Batcher;
  level: Level;
  M: MatKeys;
  mats: MatLib;
  rnd: Rng;
  /** 需要独立 mesh 的对象：带贴图、需要动画、需要单独控制的。 */
  dynamic: Group;
  /** 需要每帧更新的东西。 */
  animate(fn: (dt: number, elapsed: number) => void): void;
  /** 注册可交互物。 */
  interact(i: Interactable): Interactable;
  /** 登记点光源。请节制——每个点光源都要进 shader。 */
  light(l: Light): Light;
  /** 登记需要释放的资源（贴图、几何）。 */
  track<T extends { dispose(): void }>(res: T): T;
}
