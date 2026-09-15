import { BufferGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boxGeo, cylGeo, trs } from '../render/Geo.js';
import type { MatLib } from '../render/Mats.js';
import { P } from '../render/Palette.js';
import { makeBlobShadowTexture } from '../render/TextTex.js';

/**
 * 低多边形人物。
 *
 * 全作只有两种人：信徒，和被信徒围着的那个。为了不让二十个人就吃光帧率，
 * 每个人被压到 3–7 个 draw call：躯干（含头与腿）合批成一个，两条手臂各自合批。
 * 只有需要真正走路的目标个体（俯视跑步里的玩家）才用全关节版本。
 *
 * 所有实例共享几何与材质，靠 clone() 复制骨架，因此二十个信徒只付一次构建成本。
 */

export interface HumanoidLook {
  robe: number;
  robeTrim: number;
  skin: number;
  hair: number;
  pants: number;
  shoe: number;
}

export const CULTIST_LOOKS: HumanoidLook[] = [
  { robe: P.robe, robeTrim: P.robeTrim, skin: P.skin, hair: P.hair, pants: P.pants, shoe: P.shoe },
  { robe: 0xb9b6a6, robeTrim: 0x544d41, skin: 0xc09b7e, hair: P.hair, pants: P.pants, shoe: P.shoe },
  { robe: 0xccc8b8, robeTrim: 0x605a4c, skin: 0xcfab8c, hair: 0x241f1a, pants: P.pants, shoe: P.shoe },
  { robe: 0xa8a493, robeTrim: 0x4c4539, skin: 0xb9946f, hair: 0x151210, pants: P.pants, shoe: P.shoe },
];

export const PLAYER_LOOK: HumanoidLook = {
  robe: P.jacket,
  robeTrim: P.jacketDark,
  skin: P.skin,
  hair: P.hair,
  pants: 0x2f3336,
  shoe: P.shoe,
};

/** 警察／法警。深藏青，制服硬，脸看不见。 */
export const POLICE_LOOK: HumanoidLook = {
  robe: 0x24282f,
  robeTrim: 0x11141a,
  skin: 0xb8916f,
  hair: 0x15120f,
  pants: 0x1c1f24,
  shoe: 0x141414,
};

/** 给一个已建好的人形戴上大檐帽。刑场与码头上的人靠这个区分身份。 */
export function addCap(humanoid: Humanoid, mats: MatLib, color = 0x1b1f26): Group {
  const key = mats.key(color);
  const cap = mergePieces(
    mats,
    [
      { geo: boxGeo(0.24, 0.055, 0.26), key, m: trs(0, 0.26, 0) },
      { geo: boxGeo(0.22, 0.12, 0.06), key, m: trs(0, 0.2, -0.115) },
      { geo: boxGeo(0.24, 0.03, 0.07), key, m: trs(0, 0.16, -0.15) },
    ],
    'cap',
  );
  humanoid.head.add(cap);
  return cap;
}

interface Piece {
  geo: BufferGeometry;
  key: string;
  m: Matrix4;
}

const HIP_Y = 0.94;

/** 把一组部件按材质合并成尽量少的 Mesh。 */
function mergePieces(mats: MatLib, pieces: Piece[], name: string): Group {
  const g = new Group();
  g.name = name;
  const byKey = new Map<string, BufferGeometry[]>();
  for (const p of pieces) {
    const cloned = p.geo.clone();
    cloned.applyMatrix4(p.m);
    let arr = byKey.get(p.key);
    if (!arr) {
      arr = [];
      byKey.set(p.key, arr);
    }
    arr.push(cloned);
  }
  for (const [key, geos] of byKey) {
    const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, mats.get(key));
    mesh.name = `${name}:${key}`;
    g.add(mesh);
  }
  return g;
}

/** 递归克隆骨架，共享几何与材质，并记录每个源节点到克隆节点的映射。 */
function cloneRig(src: Object3D): { root: Object3D; map: Map<Object3D, Object3D> } {
  const map = new Map<Object3D, Object3D>();
  const walk = (o: Object3D): Object3D => {
    const srcMesh = o as Mesh;
    const c: Object3D = srcMesh.isMesh
      ? new Mesh(srcMesh.geometry, srcMesh.material)
      : new Object3D();
    c.name = o.name;
    c.position.copy(o.position);
    c.quaternion.copy(o.quaternion);
    c.scale.copy(o.scale);
    map.set(o, c);
    for (const ch of o.children) c.add(walk(ch));
    return c;
  };
  return { root: walk(src), map };
}

export class Humanoid {
  readonly root: Group;
  readonly hips: Object3D;
  readonly torso: Object3D;
  readonly head: Object3D;
  readonly armL: Object3D;
  readonly armR: Object3D;
  readonly legL: Object3D | null;
  readonly legR: Object3D | null;
  /** 膝关节（只有全关节版本才有）。 */
  readonly kneeL: Object3D | null;
  readonly kneeR: Object3D | null;
  /** 身高（米）。 */
  readonly height: number;

  constructor(
    root: Group,
    hips: Object3D,
    torso: Object3D,
    head: Object3D,
    armL: Object3D,
    armR: Object3D,
    legL: Object3D | null,
    legR: Object3D | null,
    kneeL: Object3D | null,
    kneeR: Object3D | null,
    height: number,
  ) {
    this.root = root;
    this.hips = hips;
    this.torso = torso;
    this.head = head;
    this.armL = armL;
    this.armR = armR;
    this.legL = legL;
    this.legR = legR;
    this.kneeL = kneeL;
    this.kneeR = kneeR;
    this.height = height;
  }

  /** 复制一份骨架（共享几何与材质）。 */
  clone(): Humanoid {
    const { root, map } = cloneRig(this.root);
    const get = (o: Object3D | null): Object3D | null => (o ? (map.get(o) as Object3D) ?? null : null);
    return new Humanoid(
      root as Group,
      get(this.hips)!,
      get(this.torso)!,
      get(this.head)!,
      get(this.armL)!,
      get(this.armR)!,
      get(this.legL),
      get(this.legR),
      get(this.kneeL),
      get(this.kneeR),
      this.height,
    );
  }

  // ── 姿态符号约定（改这里之前请先读这段） ──────────────────
  //
  // 角色在本地坐标里朝 -Z（脸在 -Z 一侧），肢体自然垂下是 (0,-1,0)。
  // 绕 X 轴旋转 θ 之后，一条垂下的肢体指向 (0, -cosθ, -sinθ)：
  //   θ > 0  →  z 分量为负  →  肢体向前（-Z）抬起来
  //   θ < 0  →  肢体向后（+Z）甩过去
  //
  // 所以说"伸手"、"坐着把大腿抬到身前"、"扫地时上身往前俯"、
  // "头低下去看地"，用的都是**正**角度。
  // 这套骨架最初把符号全写反了：信徒是把手伸到背后劝你，
  // 坐着的人两条腿直挺挺穿过长凳和地板，扫地的上身是往后仰的。

  /** 走路/站立姿态。ratio = 0 为静止，1 为慢走，1.3 为跑。 */
  pose(phase: number, ratio: number, lean = 0): void {
    const s = Math.sin(phase);
    const r = Math.max(0, Math.min(1.4, ratio));
    if (this.legL && this.legR) {
      this.legL.rotation.x = s * 0.66 * r;
      this.legR.rotation.x = -s * 0.66 * r;
      // 腿往后甩的时候膝盖弯起来，往前走的时候伸直
      if (this.kneeL) this.kneeL.rotation.x = -Math.max(0, -s) * 0.95 * r;
      if (this.kneeR) this.kneeR.rotation.x = -Math.max(0, s) * 0.95 * r;
    }
    this.armL.rotation.x = -s * 0.55 * r;
    this.armR.rotation.x = s * 0.55 * r;
    this.armL.rotation.z = 0.08 + r * 0.05;
    this.armR.rotation.z = -0.08 - r * 0.05;
    this.hips.position.y = HIP_Y + Math.abs(s) * 0.04 * r;
    this.hips.rotation.y = -s * 0.07 * r;
    this.hips.rotation.z = s * 0.03 * r;
    // lean > 0 = 往前俯（跑起来是这样）
    this.torso.rotation.x = -lean - r * 0.13;
    this.head.rotation.x = lean * 0.5 + r * 0.08;
  }

  /** 坐在长凳上。大腿抬到身前放平，小腿垂下。 */
  sit(): void {
    this.hips.position.y = HIP_Y * 0.545;
    if (this.legL && this.legR) {
      this.legL.rotation.set(1.42, 0, 0.05);
      this.legR.rotation.set(1.42, 0, -0.05);
    }
    // 大腿放平之后，小腿要往回折 90° 才能垂下
    if (this.kneeL) this.kneeL.rotation.x = -1.42;
    if (this.kneeR) this.kneeR.rotation.x = -1.42;
    this.torso.rotation.set(0.06, 0, 0);
    // 手放在大腿上
    this.armL.rotation.set(0.85, 0, 0.24);
    this.armR.rotation.set(0.85, 0, -0.24);
    this.head.rotation.set(0, 0, 0);
  }

  /** 跪下（"感谢天地"）：膝着地，小腿折到身后。 */
  kneel(): void {
    this.hips.position.y = HIP_Y * 0.5;
    if (this.legL && this.legR) {
      this.legL.rotation.set(0.16, 0, 0.05);
      this.legR.rotation.set(0.16, 0, -0.05);
    }
    if (this.kneeL) this.kneeL.rotation.x = -1.72;
    if (this.kneeR) this.kneeR.rotation.x = -1.72;
    this.torso.rotation.set(-0.1, 0, 0);
    this.armL.rotation.set(0.3, 0, 0.3);
    this.armR.rotation.set(0.3, 0, -0.3);
    // 头低下去
    this.head.rotation.set(-0.3, 0, 0);
  }

  /** 伸手（劝说的姿势）——手朝他面前的人伸出去。 */
  reach(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    this.armL.rotation.x = 1.5 * a;
    this.armR.rotation.x = 1.42 * a;
    this.armL.rotation.z = 0.26 * a;
    this.armR.rotation.z = -0.26 * a;
    if (this.legL) this.legL.rotation.x = 0.12 * a;
    if (this.legR) this.legR.rotation.x = -0.08 * a;
    this.torso.rotation.x = -0.13 * a;
  }

  /** 双手举过头。 */
  handsUp(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    this.armL.rotation.x = 2.5 * a;
    this.armR.rotation.x = 2.5 * a;
    this.armL.rotation.z = 0.5 * a;
    this.armR.rotation.z = -0.5 * a;
  }

  /** 倒下。dir 为倒下的朝向（弧度），amount 0..1。中弹是往后倒。 */
  fall(dir: number, amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    this.root.rotation.y = dir;
    this.root.rotation.x = a * (Math.PI / 2) * 0.93;
    this.armL.rotation.set(0.55 * a, 0, 0.95 * a);
    this.armR.rotation.set(-0.4 * a, 0, -0.75 * a);
    this.torso.rotation.x = -0.12 * a;
    if (this.kneeL) this.kneeL.rotation.x = -0.35 * a;
    if (this.kneeR) this.kneeR.rotation.x = -0.2 * a;
  }

  /** 扫地：上身往前俯，双手握着帚柄慢慢左右摆。 */
  sweep(phase: number): void {
    const s = Math.sin(phase);
    this.hips.position.y = HIP_Y;
    this.hips.rotation.set(0, s * 0.12, 0);
    // 上身往前俯（负角度），头低下去看地
    this.torso.rotation.set(-0.34, s * 0.3, s * 0.05);
    this.head.rotation.set(-0.34, -s * 0.1, 0);
    this.armL.rotation.set(1.02, 0, 0.24 + s * 0.08);
    this.armR.rotation.set(1.16, 0, -0.24 - s * 0.08);
    if (this.legL && this.legR) {
      this.legL.rotation.set(0.14, 0, 0.06);
      this.legR.rotation.set(-0.1, 0, -0.06);
    }
    if (this.kneeL) this.kneeL.rotation.x = -0.1;
    if (this.kneeR) this.kneeR.rotation.x = -0.16;
  }

  /** 弹吉他唱歌：左手按弦（前伸偏左），右手扫弦，头随节拍点。 */
  strum(phase: number): void {
    const s = Math.sin(phase);
    const fast = Math.sin(phase * 3.1);
    this.hips.position.y = HIP_Y * 0.545;
    this.hips.rotation.set(0, s * 0.05, 0);
    this.torso.rotation.set(-0.12 - s * 0.04, s * 0.07, 0);
    this.head.rotation.set(0.06 + fast * 0.07, -s * 0.12, 0);
    this.armL.rotation.set(1.28 + s * 0.06, 0, 0.34);
    this.armR.rotation.set(1.0 + fast * 0.34, 0, -0.36 - fast * 0.08);
    if (this.legL && this.legR) {
      this.legL.rotation.set(1.38, 0, 0.1);
      this.legR.rotation.set(1.38, 0, -0.1);
    }
    if (this.kneeL) this.kneeL.rotation.x = -1.4;
    if (this.kneeR) this.kneeR.rotation.x = -1.4;
  }

  /** 把一件道具挂到某个关节上（扫帚、吉他）。 */
  hold(parent: 'torso' | 'head' | 'armL' | 'armR', prop: Object3D): Object3D {
    const joint =
      parent === 'head' ? this.head : parent === 'armL' ? this.armL : parent === 'armR' ? this.armR : this.torso;
    joint.add(prop);
    return prop;
  }

  /** 复位到站立。 */
  reset(): void {
    this.root.rotation.set(0, this.root.rotation.y, 0);
    this.root.position.y = 0;
    this.hips.position.y = HIP_Y;
    this.hips.rotation.set(0, 0, 0);
    this.torso.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, 0, 0.08);
    this.armR.rotation.set(0, 0, -0.08);
    if (this.legL && this.legR) {
      this.legL.rotation.set(0, 0, 0);
      this.legR.rotation.set(0, 0, 0);
    }
    if (this.kneeL) this.kneeL.rotation.set(0, 0, 0);
    if (this.kneeR) this.kneeR.rotation.set(0, 0, 0);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }
}

export interface HumanoidOptions {
  /** 是否建全关节版本（腿会动）。 */
  full?: boolean;
  scale?: number;
}

function construct(look: HumanoidLook, mats: MatLib, opts: HumanoidOptions): Humanoid {
  const full = opts.full ?? false;
  const scale = opts.scale ?? 1;

  const kRobe = mats.key(look.robe);
  const kTrim = mats.key(look.robeTrim);
  const kSkin = mats.key(look.skin);
  const kHair = mats.key(look.hair);
  const kPants = mats.key(look.pants);
  const kShoe = mats.key(look.shoe);

  const root = new Group();
  root.name = 'humanoid';

  const hips = new Object3D();
  hips.name = 'hips';
  hips.position.set(0, HIP_Y, 0);
  root.add(hips);

  const torso = mergePieces(
    mats,
    [
      { geo: boxGeo(0.34, 0.2, 0.23), key: kPants, m: trs(0, -0.02, 0) },
      { geo: boxGeo(0.4, 0.46, 0.245), key: kRobe, m: trs(0, 0.28, 0) },
      { geo: boxGeo(0.42, 0.12, 0.26), key: kTrim, m: trs(0, 0.06, 0) },
      { geo: cylGeo(0.056, 0.062, 0.11, 5), key: kSkin, m: trs(0, 0.55, 0) },
    ],
    'torso',
  );
  torso.name = 'torso';
  torso.position.set(0, 0.09, 0);
  hips.add(torso);

  const head = mergePieces(
    mats,
    [
      { geo: boxGeo(0.195, 0.235, 0.205), key: kSkin, m: trs(0, 0.115, 0) },
      { geo: boxGeo(0.207, 0.09, 0.217), key: kHair, m: trs(0, 0.225, -0.005) },
      { geo: boxGeo(0.205, 0.05, 0.05), key: kHair, m: trs(0, 0.175, -0.105) },
    ],
    'head',
  );
  head.name = 'head';
  head.position.set(0, 0.62, 0);
  torso.add(head);

  const legPieces = (): Piece[] => [
    { geo: boxGeo(0.135, 0.44, 0.145), key: kPants, m: trs(0, -0.22, 0) },
    { geo: boxGeo(0.12, 0.42, 0.135), key: kPants, m: trs(0, -0.63, 0) },
    { geo: boxGeo(0.128, 0.085, 0.25), key: kShoe, m: trs(0, -0.86, 0.045) },
  ];

  let legL: Group | null = null;
  let legR: Group | null = null;
  let kneeL: Group | null = null;
  let kneeR: Group | null = null;
  if (full) {
    // 全关节版：大腿与小褪分成两段，中间一个膝关节。
    // 只有一个髋关节是不够的——坐下的时候腿只能整条转，脚会穿到地板下面去。
    for (const side of [-1, 1] as const) {
      const leg = new Group();
      leg.name = side < 0 ? 'legL' : 'legR';
      leg.position.set(0.105 * side, 0, 0);
      leg.add(
        mergePieces(mats, [{ geo: boxGeo(0.14, 0.46, 0.15), key: kPants, m: trs(0, -0.23, 0) }], `${leg.name}-thigh`),
      );
      const knee = new Group();
      knee.name = side < 0 ? 'kneeL' : 'kneeR';
      knee.position.set(0, -0.46, 0);
      knee.add(
        mergePieces(
          mats,
          [
            { geo: boxGeo(0.125, 0.4, 0.135), key: kPants, m: trs(0, -0.2, 0) },
            { geo: boxGeo(0.13, 0.085, 0.25), key: kShoe, m: trs(0, -0.44, 0.045) },
          ],
          `${knee.name}-shin`,
        ),
      );
      leg.add(knee);
      hips.add(leg);
      if (side < 0) {
        legL = leg;
        kneeL = knee;
      } else {
        legR = leg;
        kneeR = knee;
      }
    }
  } else {
    const offset = (dx: number, p: Piece): Piece => ({
      geo: p.geo,
      key: p.key,
      m: p.m.clone().multiply(trs(dx, 0, 0)),
    });
    const legs = mergePieces(
      mats,
      [...legPieces().map((p) => offset(-0.105, p)), ...legPieces().map((p) => offset(0.105, p))],
      'legs',
    );
    hips.add(legs);
  }

  const armPieces = (): Piece[] => [
    { geo: boxGeo(0.105, 0.3, 0.115), key: kRobe, m: trs(0, -0.15, 0) },
    { geo: boxGeo(0.1, 0.07, 0.11), key: kTrim, m: trs(0, -0.3, 0) },
    { geo: boxGeo(0.095, 0.28, 0.105), key: kRobe, m: trs(0, -0.44, 0) },
    { geo: boxGeo(0.078, 0.11, 0.095), key: kSkin, m: trs(0, -0.63, 0) },
  ];

  const armL = mergePieces(mats, armPieces(), 'armL');
  armL.position.set(-0.245, 0.5, 0);
  armL.rotation.z = 0.08;
  torso.add(armL);

  const armR = mergePieces(mats, armPieces(), 'armR');
  armR.position.set(0.245, 0.5, 0);
  armR.rotation.z = -0.08;
  torso.add(armR);

  root.scale.setScalar(scale);

  // ── 脚下一团接触阴影 ─────────────────────────────────
  // 没有它的时候，人在漫反射的场景里是"贴"在地上的：脚边没有明暗交代，
  // 稍微远一点就和地面对比度一起消失（扫地的人只剩一个头和一柄扫帚）。
  // 一张径向渐变贴图 + 一个朝上的方片，比真做阴影便宜得多。
  const shadowTex = makeBlobShadowTexture();
  const shadowMat = new MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    color: 0x0b0a08,
  });
  const shadowGeo = new PlaneGeometry(1.05, 1.05);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadow = new Mesh(shadowGeo, shadowMat);
  shadow.name = 'contact-shadow';
  shadow.position.y = 0.016;
  shadow.renderOrder = -1;
  root.add(shadow);

  return new Humanoid(root, hips, torso, head, armL, armR, legL, legR, kneeL, kneeR, 1.78 * scale);
}

/**
 * 人形工厂。第一次按外观构建，之后 clone()，因此二十个信徒只付一次合并成本。
 */
export class HumanoidFactory {
  private prototypes = new Map<string, Humanoid>();
  private geometries = new Set<BufferGeometry>();

  constructor(private readonly mats: MatLib) {}

  make(look: HumanoidLook, opts: HumanoidOptions = {}): Humanoid {
    const key = `${look.robe}|${look.skin}|${look.hair}|${opts.full ? 'f' : 's'}|${opts.scale ?? 1}`;
    let proto = this.prototypes.get(key);
    if (!proto) {
      proto = construct(look, this.mats, opts);
      this.prototypes.set(key, proto);
      proto.root.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) this.geometries.add(m.geometry);
      });
    }
    return proto.clone();
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.geometries.clear();
    this.prototypes.clear();
  }
}
