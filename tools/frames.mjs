// 拍"细节帧"：把镜头与状态摆到要检查的那一处，顺手拍成对的两张
// （有这个东西 / 没有这个东西），交给 sketch.mjs --vs 去看它的形状。
//
//   node tools/frames.mjs            全部
//   node tools/frames.mjs gun bench  只拍指定的
//
// 两个设计取舍：
// 1) 相机位置不是硬编码的，而是"从目标角色的实际坐标推出来的"——
//    角色挪了位置，机位跟着走，不会拍空。
// 2) 成对拍：整幅画面里东西太多，直接看剪影会被墙和地板带偏；
//    差一张之后剩下的就只是"这一样东西"。

import { launch, sleep } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4173';
mkdirSync('shots', { recursive: true });

/**
 * name    帧名
 * beat    用哪个节拍摆场景
 * target  要看的角色 role（留空则看玩家自己）
 * offset  相机相对目标的偏移（米）
 * eye     注视点在目标脚底之上的高度
 * fov     焦距
 * setup   摆拍前跑一次的脚本（生成/驱动需要的东西）
 * hide    把目标藏起来（拍对照张）
 * settle  摆完之后跑多少次 update 让动画收敛
 */
const FRAMES = [
  {
    name: 'gun',
    beat: 'reckoning',
    offset: [0.42, 1.62, 0.05],
    eye: 1.45,
    fov: 62,
    setup: `const g = window.__GAME__;
      g.pistol.enabled = true;
      g.pistol.setDrawn(true, g);
      g.pistol.setAiming(false, g);`,
    hide: `window.__GAME__.pistol.view.visible = false;`,
    settle: 140,
    // 第一人称的枪挂在相机下，所以相机就是玩家的眼睛
    firstPerson: true,
  },
  {
    name: 'gun-aim',
    beat: 'reckoning',
    offset: [0.42, 1.62, 0.05],
    eye: 1.45,
    fov: 62,
    setup: `const g = window.__GAME__;
      g.pistol.enabled = true;
      g.pistol.setDrawn(true, g);
      g.pistol.setAiming(true, g);`,
    hide: `window.__GAME__.pistol.view.visible = false;`,
    settle: 140,
    firstPerson: true,
  },
  {
    name: 'bench',
    beat: 'reckoning',
    target: 'follower',
    offset: [-2.6, 1.5, 2.2],
    eye: 0.9,
    fov: 40,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) if (c.role === 'follower') c.humanoid.setVisible(false);`,
    settle: 40,
  },
  {
    name: 'singer',
    beat: 'reckoning',
    target: 'singer',
    offset: [2.2, 1.3, 2.4],
    eye: 0.85,
    fov: 40,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) if (c.role === 'singer') c.humanoid.setVisible(false);`,
    settle: 60,
  },
  {
    name: 'sweeper',
    beat: 'reckoning',
    target: 'sweeper',
    offset: [-2.2, 1.3, 2.4],
    eye: 0.85,
    fov: 40,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) if (c.role === 'sweeper') c.humanoid.setVisible(false);`,
    settle: 60,
  },
  {
    name: 'idol',
    beat: 'reckoning',
    target: 'idol',
    offset: [2.4, 1.4, 2.6],
    eye: 1.0,
    fov: 40,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) if (c.role === 'idol') c.humanoid.setVisible(false);`,
    settle: 40,
  },
  {
    name: 'avatar',
    beat: 'escape',
    targetPlayer: true,
    offset: [2.0, 1.6, -2.6],
    eye: 0.95,
    fov: 44,
    setup: `const g = window.__GAME__;
      g.player.teleport(0, 8, 34, Math.PI);
      g.player.facing = Math.PI;
      g.player.control = 'topdown';`,
    hide: `const g = window.__GAME__;
      // 冻结模式下每帧都会跑 updateAvatar()，它会把可见性设回 true。
      // 直接把方法换掉，否则"对照张"里玩家还在，差分为空。
      g.updateAvatar = () => {};
      const a = g.world.getObjectByName('player-avatar');
      if (a) a.visible = false;`,
    settle: 40,
  },
  // 只藏"手里那个东西"，用来单独看道具本身
  {
    name: 'broom',
    beat: 'reckoning',
    target: 'sweeper',
    offset: [-1.9, 1.1, 2.2],
    eye: 0.75,
    fov: 46,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) { const b = c.humanoid.root.getObjectByName('broom'); if (b) b.visible = false; }`,
    settle: 30,
  },
  {
    name: 'guitar',
    beat: 'reckoning',
    target: 'singer',
    front: [2.4, 1.25],
    eye: 0.8,
    fov: 42,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) { const b = c.humanoid.root.getObjectByName('guitar'); if (b) b.visible = false; }`,
    settle: 30,
  },
  {
    name: 'singer-front',
    beat: 'reckoning',
    target: 'singer',
    front: [2.6, 1.3],
    eye: 0.85,
    fov: 40,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) if (c.role === 'singer') c.humanoid.setVisible(false);`,
    settle: 40,
  },
  {
    name: 'sweeper-front',
    beat: 'reckoning',
    target: 'sweeper',
    front: [2.6, 1.3],
    eye: 0.85,
    fov: 40,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) if (c.role === 'sweeper') c.humanoid.setVisible(false);`,
    settle: 40,
  },
  {
    name: 'bench-front',
    beat: 'reckoning',
    target: 'follower',
    front: [2.8, 1.4],
    eye: 0.85,
    fov: 40,
    setup: `for (const c of window.__GAME__.cultists) c.setVisible(true);`,
    hide: `for (const c of window.__GAME__.cultists) if (c.role === 'follower') c.humanoid.setVisible(false);`,
    settle: 40,
  },
];

const filter = process.argv.slice(2);
const plan = filter.length ? FRAMES.filter((f) => filter.includes(f.name)) : FRAMES;

let session = await launch({ url: 'about:blank', width: 900, height: 560 });
let { page, close } = session;
let failed = 0;

/** 让私有方法在冻结模式下跑起来，把动画推到收敛状态。 */
const settleScript = (n) => `(() => {
  const g = window.__GAME__;
  for (let i = 0; i < ${n}; i++) {
    try { g.pistol.update(1/60, g); } catch (e) {}
    try { g.updateAvatar(1/60); } catch (e) {}
    try { for (const c of g.cultists) c.update(1/60, g); } catch (e) {}
  }
})()`;

/** 页面卡死时换一个干净的 Chrome，重新来一次这一帧。 */
async function restart() {
  try {
    await close();
  } catch {
    /* 忽略 */
  }
  session = await launch({ url: 'about:blank', width: 900, height: 560 });
  page = session.page;
  close = session.close;
}

async function captureOne(f) {
  await page.goto(`${BASE}/?shot=${f.beat}&mute=1`);
  await page.waitFor('window.__SHOT_READY__ === true', 40000, `${f.beat} 就绪`);
  await sleep(400);

  await page.eval(`(() => { ${f.setup} })()`);
  if (f.settle) await page.eval(settleScript(f.settle));

  // 从目标角色的真实坐标推相机
  const pose = await page.eval(`(() => {
    const g = window.__GAME__;
    let t;
    if (${f.targetPlayer ? 'true' : 'false'}) {
      t = { x: g.player.position.x, y: g.player.position.y, z: g.player.position.z };
    } else {
      const c = g.cultists.find(c => c.role === ${JSON.stringify(f.target ?? '')});
      t = c ? { x: c.position.x, y: c.position.y, z: c.position.z } : { x: 0, y: 8, z: 0 };
    }
    return { t };
  })()`);

  let cam;
  let look;
  if (f.firstPerson) {
    // 第一人称：相机就是眼睛，按玩家位置 + 眼高算
    const p = await page.eval(`(() => { const g = window.__GAME__;
      return { x: g.player.position.x, y: g.player.position.y, z: g.player.position.z, yaw: g.player.yaw }; })()`);
    cam = [p.x, p.y + 1.64, p.z];
    look = [p.x - Math.sin(p.yaw) * 8, p.y + 1.5, p.z - Math.cos(p.yaw) * 8];
  } else if (f.front) {
    // 从目标"脸朝的那一侧"看过去——比硬编偏移可靠得多，
    // 不然很容易绕到人背后，拍到的只是后脑勺
    const dir = await page.eval(`(() => {
      const g = window.__GAME__;
      const c = g.cultists.find(c => c.role === ${JSON.stringify(f.target ?? '')});
      if (!c) return null;
      const y = c.humanoid.root.rotation.y;
      return { fx: -Math.sin(y), fz: -Math.cos(y) };
    })()`);
    const t = pose.t;
    const [dist, height] = f.front;
    cam = [t.x + (dir?.fx ?? 0) * dist, t.y + height, t.z + (dir?.fz ?? 1) * dist];
    look = [t.x, t.y + f.eye, t.z];
  } else {
    const t = pose.t;
    cam = [t.x + f.offset[0], t.y + f.offset[1], t.z + f.offset[2]];
    look = [t.x, t.y + f.eye, t.z];
  }

  await page.eval(
    `window.__GAME__.director.setPose([${cam.join(',')}], [${look.join(',')}], ${f.fov})`,
  );
  await sleep(500);
  await page.screenshot(`shots/frame-${f.name}-on.png`);

  await page.eval(`(() => { ${f.hide} })()`);
  // ⚠ 顺序要紧：先把动画跑完再藏。
  // 反过来的话 settle 里的 pistol.update() 会把 view.visible 又设回 true，
  // 于是对照张里枪还在、差分为空——看起来像"枪没渲染出来"，
  // 其实是测试自己把它拍回来了。
  if (f.settle) await page.eval(settleScript(Math.min(20, f.settle)));
  await page.eval(`(() => { ${f.hide} })()`);
  await sleep(400);
  await page.screenshot(`shots/frame-${f.name}-off.png`);

  const t = pose.t;
  console.log(
    `  ✓ ${f.name.padEnd(10)} 目标 (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})  相机 (${cam.map((v) => v.toFixed(1)).join(', ')})`,
  );
}

try {
  console.log('═══ 细节帧');
  for (const f of plan) {
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        await captureOne(f);
        ok = true;
      } catch (e) {
        const msg = e.message.split('\n')[0];
        if (attempt === 1) {
          console.log(`  … ${f.name} 第 1 次失败（${msg}），换一个 Chrome 实例重试`);
          await restart();
        } else {
          console.log(`  ✗ ${f.name}：${msg}`);
          failed++;
          await restart();
        }
      }
    }
  }
} catch (e) {
  failed++;
  console.log(`✗ 中断：${e.message.split('\n')[0]}`);
} finally {
  await close();
}

console.log(`\n${failed === 0 ? '拍完' : '有失败'}`);
process.exit(failed === 0 ? 0 : 1);
