// 近景核对：把镜头对准某个角色，拍"有人"和"没人"两张，比像素差。
//
// 为什么不用眼看：这个会话里的模型读不了图，而 ASCII 亮度图在近景上太粗，
// 分不清"站着一个人"和"一面墙"。像素差是客观的——
// 如果中心区域的平均差异接近 0，那就是镜头对面什么都没有。
//
//   node tools/look.mjs

import { readFileSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';
import { decodePng, toRgb, luminance } from './inspect.mjs';

const BASE = process.env.BASE ?? 'http://localhost:4173';

/** [名字, 机位, 注视点, 期望看到的角色 role] */
const LOOKS = [
  ['idol', [0.0, 9.7, -10.2], [0.0, 9.6, -13.6], 'idol'],
  ['singer', [-6.0, 9.5, -8.8], [-8.6, 9.4, -11.6], 'singer'],
  ['sweeper', [1.4, 9.6, 20.8], [4.4, 9.5, 23.4], 'sweeper'],
  ['elder', [-1.0, 9.6, 19.2], [-3.0, 9.5, 21.5], 'elder'],
  // 从门口往里看：整座礼厅的人是不是"看得见"的
  ['crowd', [0.0, 9.8, 6.4], [0.0, 9.6, -13.0], 'follower'],
];

/**
 * 两张图的差异：全画面平均亮度差，以及"确实变了的像素占比"。
 * 近景（一个人占满画面）看平均值；远景（二十个人分布在整个礼厅）看占比——
 * 只看画面中心的话，坐在两侧长凳上的人会被算在中心之外。
 */
function diffStats(a, b) {
  const ia = decodePng(readFileSync(a));
  const ib = decodePng(readFileSync(b));
  if (ia.w !== ib.w || ia.h !== ib.h) throw new Error('尺寸不一致');
  let sum = 0;
  let changed = 0;
  let n = 0;
  for (let y = 0; y < ia.h; y += 2) {
    for (let x = 0; x < ia.w; x += 2) {
      const [r1, g1, b1] = toRgb(ia, x, y);
      const [r2, g2, b2] = toRgb(ib, x, y);
      const d = Math.abs(luminance(r1, g1, b1) - luminance(r2, g2, b2));
      sum += d;
      if (d > 0.03) changed++;
      n++;
    }
  }
  return { mean: sum / Math.max(1, n), changed: changed / Math.max(1, n) };
}

const { page, close } = await launch({ url: 'about:blank', width: 1000, height: 640 });
let failed = 0;

try {
  await page.goto(`${BASE}/?shot=backstage&mute=1&debug=1`);
  await page.waitFor('window.__SHOT_READY__ === true', 40000, '场景就绪');
  await sleep(600);

  for (const [name, pos, look, role] of LOOKS) {
    await page.eval(`(() => {
      const g = window.__GAME__;
      g.director.setPose([${pos}], [${look}], 34);
      for (const c of g.cultists) { c.visible = true; c.setVisible(true); }
    })()`);
    await sleep(700);
    await page.screenshot(`shots/look-${name}-on.png`);

    const hidden = await page.eval(`(() => {
      const g = window.__GAME__;
      let n = 0;
      for (const c of g.cultists) {
        if (c.role === ${JSON.stringify(role)}) { c.humanoid.setVisible(false); n++; }
      }
      return n;
    })()`);
    await sleep(700);
    await page.screenshot(`shots/look-${name}-off.png`);

    const d = diffStats(`shots/look-${name}-on.png`, `shots/look-${name}-off.png`);
    // 分镜模式下颗粒已经关掉了，所以这两个数是"干净"的：平均差现在只反映
    // 真实的内容差异（之前被逐帧噪点垫高了近一倍）。判据主要看"变化像素占比"
    // ——远处的一小撮人本来就摊不出多少平均差。
    const ok = hidden > 0 && d.changed > 0.008 && d.mean > 0.0008;
    console.log(
      `  ${ok ? '✓' : '✗'} ${name.padEnd(8)} role=${role.padEnd(9)} 匹配 ${String(hidden).padStart(2)} 个` +
        `  平均差 ${d.mean.toFixed(4)}  变化像素 ${(d.changed * 100).toFixed(1)}%`,
    );
    if (!ok) failed++;

    // 还原，免得影响下一张
    await page.eval(`(() => { for (const c of window.__GAME__.cultists) c.setVisible(true); })()`);
  }
} catch (e) {
  failed++;
  console.log(`✗ 中断：${e.message.split('\n')[0]}`);
} finally {
  await close();
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
