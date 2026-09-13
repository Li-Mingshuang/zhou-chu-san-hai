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
  { beat: 'arrest', t: 0 },
  { beat: 'execution', t: 0 },
  { beat: 'ending', t: 2 },
];

const filter = process.argv.slice(2);
const plan = filter.length ? PLAN.filter((p) => filter.includes(p.beat)) : PLAN;

let failures = 0;

// 每个机位用一个干净的 Chrome 实例。
// 复用同一个实例时，反复导航几次之后浏览器进程会卡死（CDP 命令开始超时），
// 而这里的成本只是每次多花三秒启动——换来确定性，值。
for (const { beat, t } of plan) {
  const name = t ? `${beat}_t${t}` : beat;
  const url = `${BASE}/?shot=${beat}&t=${t}&debug=1&mute=1&seed=20231124`;
  process.stdout.write(`\n═══ ${name}\n`);

  let { page, close } = await launch({ url: 'about:blank', width: 1600, height: 900 });
  let attempt = 0;
  let done = false;

  while (attempt < 3 && !done) {
    attempt++;
    page.consoleErrors.length = 0;
    page.pageErrors.length = 0;
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
        };
      })()`);

      await page.screenshot(`${OUT}/${name}.png`);
      console.log(`  beat=${state.beatId} mode=${state.mode}`);
      console.log(`  玩家 ${state.pos.join(', ')}  相机 ${state.cam.join(', ')}`);
      console.log(`  draw calls ${state.draws}  三角形 ${state.tris}  信徒 ${state.alive}/${state.cultists}`);
      if (state.objective) console.log(`  目标：${state.objective.replace(/\s+/g, ' ')}`);
      if (state.subs) console.log(`  字幕：${state.subs.replace(/\s+/g, ' ')}`);
      if (state.fatal) {
        console.log(`  ✗ 页面内致命错误：${state.fatal.split('\n')[0]}`);
        failures++;
      } else if (state.draws === 0) {
        console.log('  ✗ 一个 draw call 都没有——画面是空的');
        failures++;
      } else if (page.pageErrors.length) {
        console.log(`  ✗ 未捕获异常：${page.pageErrors[0].split('\n')[0]}`);
        failures++;
      } else {
        if (page.consoleErrors.length) {
          console.log(`  ! console.error：${page.consoleErrors.slice(0, 2).join(' | ')}`);
        }
        console.log('  ✓');
      }
      done = true;
    } catch (e) {
      const msg = e.message.split('\n')[0];
      if (attempt < 3) {
        console.log(`  … 第 ${attempt} 次失败（${msg}），换个 Chrome 实例重试`);
        await close();
        ({ page, close } = await launch({ url: 'about:blank', width: 1600, height: 900 }));
      } else {
        console.log(`  ✗ ${msg}`);
        failures++;
      }
    }
  }
  await close();
  if (process.env.FRESH_DELAY) await sleep(Number(process.env.FRESH_DELAY));
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
