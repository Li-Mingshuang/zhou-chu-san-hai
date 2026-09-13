import {
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { boxGeo } from './Geo.js';

/**
 * 极简粒子池：一个 InstancedMesh 装下全部粒子，一次 draw call。
 *
 * 全作只用它做两件事——枪口的烟，和子弹打在墙上的灰。
 * 数量故意压得很小：这一章里开枪不是"爽"，是"脏"。
 */

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  grow: number;
  life: number;
  maxLife: number;
  gravity: number;
  drag: number;
  spin: number;
  angle: number;
}

export interface SpawnOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  size?: number;
  grow?: number;
  life?: number;
  gravity?: number;
  drag?: number;
}

export class Particles {
  readonly mesh: InstancedMesh;
  private pool: Particle[] = [];
  private cursor = 0;
  private readonly matrix = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly scale = new Vector3();

  constructor(
    parent: Object3D,
    count = 96,
    baseColor = 0xbfb6a4,
    opts: { transparent?: boolean; opacity?: number; depthWrite?: boolean } = {},
  ) {
    const geo = boxGeo(1, 1, 1);
    const mat = new MeshBasicMaterial({
      color: baseColor,
      transparent: opts.transparent ?? true,
      opacity: opts.opacity ?? 0.5,
      depthWrite: opts.depthWrite ?? false,
      fog: true,
    });
    this.mesh = new InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'particles';
    parent.add(this.mesh);

    for (let i = 0; i < count; i++) {
      this.pool.push({
        alive: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        size: 0,
        grow: 0,
        life: 0,
        maxLife: 1,
        gravity: 0,
        drag: 1,
        spin: 0,
        angle: 0,
      });
      this.matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(o: SpawnOpts): void {
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.pool.length;
    p.alive = true;
    p.x = o.x;
    p.y = o.y;
    p.z = o.z;
    p.vx = o.vx ?? 0;
    p.vy = o.vy ?? 0;
    p.vz = o.vz ?? 0;
    p.size = o.size ?? 0.06;
    p.grow = o.grow ?? 0.06;
    p.maxLife = o.life ?? 0.7;
    p.life = p.maxLife;
    p.gravity = o.gravity ?? -1.2;
    p.drag = o.drag ?? 2.2;
    p.spin = (Math.random() - 0.5) * 4;
    p.angle = Math.random() * Math.PI;
  }

  /** 一团烟/灰。 */
  burst(x: number, y: number, z: number, n: number, opts: Partial<SpawnOpts> = {}): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      this.spawn({
        x: x + (Math.random() - 0.5) * 0.06,
        y: y + (Math.random() - 0.5) * 0.06,
        z: z + (Math.random() - 0.5) * 0.06,
        vx: Math.cos(a) * r * 0.9,
        vy: 0.5 + Math.random() * 0.8,
        vz: Math.sin(a) * r * 0.9,
        size: 0.04 + Math.random() * 0.05,
        grow: 0.18,
        life: 0.5 + Math.random() * 0.6,
        gravity: -0.4,
        drag: 1.6,
        ...opts,
      });
    }
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]!;
      if (!p.alive) continue;
      dirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.matrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.matrix);
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vz *= d;
      p.vy = (p.vy + p.gravity * dt) * d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.angle += p.spin * dt;

      const t = 1 - p.life / p.maxLife;
      const s = p.size + p.grow * t;
      this.pos.set(p.x, p.y, p.z);
      this.quat.setFromAxisAngle(_axis, p.angle);
      this.scale.setScalar(s * (1 - t * 0.35));
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.pool.length; i++) {
      this.pool[i]!.alive = false;
      this.matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.removeFromParent();
  }
}

const _axis = new Vector3(0.3, 1, 0.2).normalize();
