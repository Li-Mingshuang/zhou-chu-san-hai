import {
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  type Side,
} from 'three';

export interface MatOpts {
  /** 自发光颜色（灯笼、日光灯、枪口）。 */
  emissive?: number;
  emissiveIntensity?: number;
  opacity?: number;
  transparent?: boolean;
  side?: 'front' | 'back' | 'double';
  /** 不受光照的平涂材质（字幕板、海面反光、瞄准辅助）。 */
  unlit?: boolean;
  depthWrite?: boolean;
  /** 稍微增加粗糙感的标准材质，用于金属（枪、金条）。 */
  metalness?: number;
  roughness?: number;
}

function sideOf(s: MatOpts['side']): Side {
  if (s === 'back') return BackSide;
  if (s === 'double') return DoubleSide;
  return FrontSide;
}

function encode(color: number, o: MatOpts): string {
  return [
    color.toString(16),
    o.emissive !== undefined ? o.emissive.toString(16) : '-',
    o.emissiveIntensity ?? '-',
    o.opacity ?? '-',
    o.transparent ? 't' : '-',
    o.side ?? 'f',
    o.unlit ? 'u' : '-',
    o.depthWrite === false ? 'nw' : '-',
    o.metalness ?? '-',
    o.roughness ?? '-',
  ].join('|');
}

/**
 * 材质库。所有材质在此集中创建并被复用，
 * 世界构建时只需要拿到一个字符串 key。
 */
export class MatLib {
  private desc = new Map<string, { color: number; opts: MatOpts }>();
  private cache = new Map<string, Material>();
  private owned: Material[] = [];

  /** 登记（或复用）一个材质描述，返回其 key。 */
  key(color: number, opts: MatOpts = {}): string {
    const k = encode(color, opts);
    if (!this.desc.has(k)) this.desc.set(k, { color, opts });
    return k;
  }

  /** 按 key 取材质，首次使用时惰性创建。 */
  get(k: string): Material {
    let m = this.cache.get(k);
    if (m) return m;
    const d = this.desc.get(k);
    if (!d) {
      console.warn(`[mats] unknown material key "${k}", falling back to magenta`);
      m = new MeshBasicMaterial({ color: 0xff00ff });
      this.cache.set(k, m);
      this.owned.push(m);
      return m;
    }
    m = this.build(d.color, d.opts);
    this.cache.set(k, m);
    this.owned.push(m);
    return m;
  }

  /** 一次性建好一批命名材质，返回 key 映射。 */
  palette<T extends Record<string, number>>(
    src: T,
    opts: MatOpts | ((key: keyof T) => MatOpts) = {},
  ): Record<keyof T, string> {
    const out = {} as Record<keyof T, string>;
    for (const k of Object.keys(src) as Array<keyof T>) {
      const o = typeof opts === 'function' ? opts(k) : opts;
      out[k] = this.key(src[k], o);
    }
    return out;
  }

  private build(color: number, o: MatOpts): Material {
    const c = new Color(color);
    if (o.unlit) {
      return new MeshBasicMaterial({
        color: c,
        side: sideOf(o.side),
        transparent: o.transparent ?? false,
        opacity: o.opacity ?? 1,
        depthWrite: o.depthWrite ?? true,
        fog: true,
      });
    }
    if (o.metalness !== undefined || o.roughness !== undefined) {
      return new MeshStandardMaterial({
        color: c,
        flatShading: true,
        metalness: o.metalness ?? 0.6,
        roughness: o.roughness ?? 0.45,
        emissive: new Color(o.emissive ?? 0x000000),
        emissiveIntensity: o.emissiveIntensity ?? 1,
        side: sideOf(o.side),
        transparent: o.transparent ?? false,
        opacity: o.opacity ?? 1,
        depthWrite: o.depthWrite ?? true,
      });
    }
    return new MeshLambertMaterial({
      color: c,
      flatShading: true,
      emissive: new Color(o.emissive ?? 0x000000),
      emissiveIntensity: o.emissiveIntensity ?? 1,
      side: sideOf(o.side),
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      depthWrite: o.depthWrite ?? true,
    });
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    this.owned = [];
    this.cache.clear();
    this.desc.clear();
  }
}
