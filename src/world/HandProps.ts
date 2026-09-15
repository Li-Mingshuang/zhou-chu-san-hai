import { Group, Mesh, type BufferGeometry, type Matrix4 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { boxGeo, cylGeo, trs } from '../render/Geo.js';
import type { MatLib } from '../render/Mats.js';
import { P } from '../render/Palette.js';

/**
 * 手里拿着的东西。
 *
 * 都是挂在骨架关节上的小道具：门口那位的扫帚，礼厅里那把吉他。
 * 单独成文件是因为它们和建筑道具不是一回事——它们要跟着动画走。
 */

type Piece = { geo: BufferGeometry; m: Matrix4 };

function merged(mats: MatLib, key: string, parts: Piece[]): Mesh {
  const geos = parts.map((p) => p.geo.clone().applyMatrix4(p.m));
  const geo = geos.length === 1 ? geos[0]! : mergeGeometries(geos, false);
  return new Mesh(geo ?? boxGeo(0.1, 0.1, 0.1), mats.get(key));
}

/** 竹扫帚。挂在扫地主人的躯干上，跟着上身一起摆。 */
export function makeBroom(mats: MatLib): Group {
  const M = {
    wood: mats.key(P.wood),
    incense: mats.key(P.incense),
    vegDry: mats.key(P.vegDry),
  };
  const g = new Group();
  g.name = 'broom';

  // 柄：从握点往 -Y 伸出去。
  // 长度是按"站在地上、手握在腰高"反推的：手约在离地 1.0 米，
  // 柄前倾约 55°，1.0 米的柄加帚头正好让帚毛落在脚前的地面上。
  // 之前给了 1.46 米，加上扫地的姿势又把上身压下去，帚头整个埋进地里半米。
  g.add(
    merged(mats, M.wood, [
      { geo: cylGeo(0.021, 0.024, 1.0, 5), m: trs(0, -0.5, 0) },
    ]),
  );
  // 绑扎处
  g.add(
    merged(mats, M.incense, [
      { geo: cylGeo(0.045, 0.05, 0.12, 5), m: trs(0, -0.97, 0) },
    ]),
  );
  // 帚头：中间一撮 + 两侧散开
  const straw: Piece[] = [{ geo: boxGeo(0.3, 0.05, 0.16), m: trs(0, -1.02, 0.02) }];
  for (let i = 0; i < 13; i++) {
    const x = -0.16 + i * 0.027;
    const spread = 1 + Math.abs(x) * 3;
    straw.push({
      geo: boxGeo(0.022, 0.2 * spread, 0.022),
      m: trs(x * spread, -1.12, 0.02 + i * 0.004),
    });
  }
  g.add(merged(mats, M.vegDry, straw));

  // 挂在躯干前下方，向前倾约 55°，帚头落在脚前
  g.position.set(0.16, -0.02, 0.26);
  g.rotation.set(-0.96, 0.12, 0.06);
  return g;
}

/** 木吉他。抱在怀里，右手扫弦。 */
export function makeGuitar(mats: MatLib): Group {
  const M = {
    woodWorn: mats.key(P.woodWorn),
    woodDark: mats.key(P.woodDark),
    lacquerDark: mats.key(P.lacquerDark),
    steel: mats.key(P.steel),
  };
  const g = new Group();
  g.name = 'guitar';

  const kBody = M.woodWorn;
  const kDark = M.woodDark;
  const kMetal = M.steel;

  // 琴身：两段宽窄不同的板拼出葫芦形
  g.add(
    merged(mats, kBody, [
      { geo: boxGeo(0.34, 0.1, 0.3), m: trs(0, 0, 0.15) },
      { geo: boxGeo(0.28, 0.1, 0.18), m: trs(0, 0, -0.02) },
    ]),
  );
  // 面板（略浅，做出音孔区域的层次）
  g.add(
    merged(mats, M.lacquerDark, [
      { geo: boxGeo(0.26, 0.02, 0.4), m: trs(0, 0.055, 0.08) },
      { geo: boxGeo(0.11, 0.03, 0.11), m: trs(0, 0.058, 0.04) },
    ]),
  );
  // 琴颈与琴头
  g.add(
    merged(mats, kDark, [
      { geo: boxGeo(0.062, 0.045, 0.52), m: trs(0, 0.04, -0.34) },
      { geo: boxGeo(0.085, 0.05, 0.13), m: trs(0, 0.04, -0.66) },
    ]),
  );
  // 琴桥
  g.add(merged(mats, kDark, [{ geo: boxGeo(0.15, 0.025, 0.03), m: trs(0, 0.07, 0.26) }]));
  // 弦：三根极细的条，低多边形下够暗示了
  g.add(
    merged(mats, kMetal, [
      { geo: boxGeo(0.004, 0.006, 0.9), m: trs(-0.016, 0.075, -0.16) },
      { geo: boxGeo(0.004, 0.006, 0.9), m: trs(0, 0.078, -0.16) },
      { geo: boxGeo(0.004, 0.006, 0.9), m: trs(0.016, 0.075, -0.16) },
    ]),
  );

  // 抱在怀里：琴身贴着小腹，琴颈朝左前方
  g.position.set(0.06, -0.24, 0.24);
  g.rotation.set(0.16, -0.5, 0.42);
  return g;
}

/** 供刑场与码头用的手持物：一支烟。小到几乎看不见，但点火那一下要有东西。 */
export function makeCigarette(mats: MatLib): Group {
  const g = new Group();
  g.name = 'cigarette';
  const key = mats.key(0xf0ece0);
  const ember = mats.key(0xd9772e, { emissive: 0xd9772e, emissiveIntensity: 1.4, unlit: true });
  g.add(merged(mats, key, [{ geo: cylGeo(0.006, 0.006, 0.07, 4), m: trs(0, 0, 0) }]));
  g.add(merged(mats, ember, [{ geo: cylGeo(0.007, 0.007, 0.012, 4), m: trs(0, 0.04, 0) }]));
  return g;
}
