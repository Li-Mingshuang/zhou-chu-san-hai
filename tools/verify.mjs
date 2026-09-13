// 自动验收：把九个节拍逐个跑一遍，读状态、拍图、报告异常。
//
//   node tools/verify.mjs                全部节拍
//   node tools/verify.mjs reckoning      只验某几拍
//
// 这是这个项目里最重要的一件工具：它代替了"我打开浏览器看一眼"。

import { launch, sleep } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const PLAN = [
  { beat: 'arrival', t: 0 },
  { beat: 'arrival', t: 2 },
  { beat: 'yard', t: 6 },
  { beat: 'ritual', t: 2 },
  { beat: 'ritual', t: 22 },
  { beat: 'backstage', t: 0 },
  { beat: 'backstage', t: 3 },
  { beat: 'return', t: 0 },
  { beat: 'reckoning', t: 0 },
  { beat: 'reckoning', t: 14 },
  { beat: 'escape', t: 0 },
  { beat: 'shore', t: 0 },
  { beat: 'ending', t: 2 },
];

const filter = process.argv.slice(2);
const plan = filter.length ? PLAN.filter((p) => filter.includes(p.beat)) : PLAN;

const { page, close } = await launch({ url: 'about:blank', width: 1600, height: 900 });

let failures = 0;

try {
  for (const { beat, t } of plan) {
    const name = t ? `${beat}_t${t}` : beat;
    const url = `${BASE}/?shot=${beat}&t=${t}&debug=1&mute=1&seed=20231124`;
    page.consoleErrors.length = 0;
    page.pageErrors.length = 0;

    process.stdout.write(`\n═══ ${name}\n`);
    try {
      await page.goto(url);
      await page.waitFor('window.__SHOT_READY__ === true', 30000, '场景加载完成');
      await sleep(400);

      const state = await page.eval(`(() => {
        const g = window.__GAME__;
        const txt = (id) => (document.getElementById(id)?.textContent ?? '').trim();
        return {
          beatId: g.beatId,
          mode: g.director.mode,
          pos: [g.player.position.x, g.player.position.y, g.player.position.z].map(v => +v.toFixed(2)),
          cultists: g.cultists.length,
          alive: g.cultists.filter(c => c.alive && !c.retired).length,
          draws: g.renderer.drawCalls,
          tris: g.renderer.triangles,
          cam: [g.camera.position.x, g.camera.position.y, g.camera.position.z].map(v => +v.toFixed(2)),
          objective: txt('objective'),
          subs: txt('subs').slice(0, 70),
          fatal: txt('fatal').slice(0, 200),
          frozen: g.frozen,
        };
      })()`);

      await page.screenshot(`${OUT}/${name}.png`);
      console.log(`  beat=${state.beatId} mode=${state.mode} frozen=${state.frozen}`);
      console.log(`  玩家 ${state.pos.join(', ')}  相机 ${state.cam.join(', ')}`);
      console.log(`  draw calls ${state.draws}  三角形 ${state.tris}  信徒 ${state.alive}/${state.cultists}`);
      if (state.objective) console.log(`  目标：${state.objective.replace(/\s+/g, ' ')}`);
      if (state.subs) console.log(`  字幕：${state.subs.replace(/\s+/g, ' ')}`);
      if (state.fatal) {
        console.log(`  ✗ 页面内致命错误：${state.fatal.split('\n')[0]}`);
        failures++;
      }
      if (state.draws === 0) {
        console.log('  ✗ 一个 draw call 都没有——画面是空的');
        failures++;
      }
      if (page.pageErrors.length) {
        console.log(`  ✗ 未捕获异常：${page.pageErrors[0].split('\n')[0]}`);
        failures++;
      }
      if (page.consoleErrors.length) {
        console.log(`  ! console.error：${page.consoleErrors.slice(0, 2).join(' | ')}`);
      }
      if (!state.fatal && state.draws > 0 && !page.pageErrors.length) console.log('  ✓');
    } catch (e) {
      console.log(`  ✗ ${e.message.split('\n')[0]}`);
      failures++;
    }
  }
} finally {
  await close();
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
