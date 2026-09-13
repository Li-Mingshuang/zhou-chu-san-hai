// 自动通关：从头到尾把第三章走一遍，验证节拍状态机真的能推进。
//
//   node tools/playthrough.mjs        正常速度
//   node tools/playthrough.mjs 6      六倍速（多跑几步，不是放大 dt）
//
// 这是最有价值的一次验收：分镜截图只能证明"画面是对的"，
// 只有走完一遍才能证明"这一章是能玩的"。

import { launch, sleep } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const SPEED = Number(process.argv[2] ?? 4);
mkdirSync('shots', { recursive: true });

const { page, close } = await launch({ url: 'about:blank', width: 960, height: 540 });

const log = [];
let failed = 0;

function note(msg) {
  console.log(`  ${msg}`);
  log.push(msg);
}

async function state() {
  return page.eval(`(() => {
    const g = window.__GAME__;
    if (!g) return null;
    return {
      beat: g.beatId, mode: g.director.mode, paused: g.paused,
      pos: [+g.player.position.x.toFixed(2), +g.player.position.y.toFixed(2), +g.player.position.z.toFixed(2)],
      ammo: g.pistol.ammo, drawn: g.pistol.drawn, shots: g.pistol.shotsFired,
      casualties: g.casualties, cleansed: g.cleansed, input: g.player.inputEnabled,
      subs: (document.getElementById('subs')?.textContent ?? '').trim().slice(0, 48),
      objective: (document.getElementById('objective')?.textContent ?? '').trim().slice(0, 40),
      ending: !document.getElementById('ending-card')?.classList.contains('hidden'),
      endingTitle: (document.getElementById('ending-title')?.textContent ?? '').trim(),
      endingCount: (document.getElementById('ending-count')?.textContent ?? '').trim(),
      fatal: (document.getElementById('fatal')?.textContent ?? '').trim().slice(0, 160),
    };
  })()`);
}

async function waitBeat(id, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await state();
    if (!s) throw new Error('Game 还没建起来');
    if (s.fatal) throw new Error(`页面内致命错误：${s.fatal.split('\n')[0]}`);
    if (s.beat === id) return s;
    await sleep(150);
  }
  const s = await state();
  throw new Error(`等不到节拍 ${id}（当前 ${s?.beat}，位置 ${s?.pos}）`);
}

async function waitFor(expr, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval(expr)) return;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

/** 按住某个键一段时间（真实的键盘事件，走 Input 那条路）。 */
async function holdKey(key, code, keyCode, ms) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await sleep(ms);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}

const KEY = {
  w: ['w', 'KeyW', 87],
  e: ['e', 'KeyE', 69],
  f: ['f', 'KeyF', 70],
};

try {
  console.log(`═══ 自动通关（时间倍数 ${SPEED}）`);
  await page.goto(`${BASE}/?intro=0&debug=1&mute=1&pixel=0.35&timescale=${SPEED}&seed=20231124`);
  await page.waitFor('!!(window.__GAME__ && window.__GAME__.started)', 30000, '游戏启动');
  note('游戏已启动');

  // ── 一 · 抵岛：先等开场镜头放完，再验证真的能用键盘走路 ──
  let s = await waitBeat('arrival');
  note(`节拍 1 arrival  相机 ${s.mode}  位置 ${s.pos.join(',')}`);
  await waitFor('window.__GAME__.player.inputEnabled === true', '开场镜头结束', 240000);
  note('开场镜头结束，恢复第一人称控制');
  const z0 = (await state()).pos[2];
  await holdKey(...KEY.w, 1600);
  s = await state();
  if (s.pos[2] < z0 - 1.5) note(`键盘移动 OK：按 W 之后 z ${z0} → ${s.pos[2]}`);
  else {
    note(`✗ 按 W 之后 z 几乎没变（${z0} → ${s.pos[2]}）`);
    failed++;
  }
  await page.eval('window.__GAME__.player.teleport(0, 0.1, 30, 0)');

  // ── 二 · 前院：交出手表 ───────────────────────────────
  s = await waitBeat('yard');
  note(`节拍 2 yard  位置 ${s.pos.join(',')}`);
  await page.eval(`(() => {
    const g = window.__GAME__;
    g.player.teleport(-2.6, 8, 22.2, 0.1);
    g.player.lookAt(-2.6, 8.3, 20.4);
  })()`);
  await sleep(600);
  await page.eval('window.__GAME__.interactions.trigger(window.__GAME__)');
  await waitFor('window.__GAME__.flag("gave-watch") === true', '交出手表');
  note('交互成功：交出手表');

  // ── 三 · 礼厅仪式 ─────────────────────────────────────
  s = await waitBeat('ritual');
  note(`节拍 3 ritual  位置 ${s.pos.join(',')}`);
  await page.eval('window.__GAME__.player.teleport(0, 8, 5.0, 0)');
  await waitFor('window.__GAME__.director.mode === "cinematic"', '仪式开场镜头');
  note('仪式开场镜头播放中');
  await waitFor('window.__GAME__.director.mode === "fps"', '仪式镜头结束', 200000);
  note('仪式镜头结束，可以走动了');

  await page.eval(`(() => {
    const g = window.__GAME__;
    g.player.teleport(0.6, 8, 4.6, 0.2);
    g.player.lookAt(0, 8.5, 4.6);
  })()`);
  await sleep(800);
  await page.eval('window.__GAME__.interactions.trigger(window.__GAME__)');
  await waitFor('window.__GAME__.flag("sat-last-row") === true', '坐下', 30000);
  note('坐到最后一排');
  await waitFor('window.__GAME__.director.mode === "cinematic"', '受刑镜头', 60000);
  note('受刑镜头播放中（鞭打 + 黑场）');
  await waitFor('window.__GAME__.director.mode === "fps"', '受刑镜头结束', 240000);
  await waitFor('window.__GAME__.flag("allowed-backstage") === true', '获准去后院', 60000);
  note('获准去后院');
  await page.eval('window.__GAME__.player.teleport(0, 8, 6.5, 0)');

  // ── 四 · 密室 ─────────────────────────────────────────
  s = await waitBeat('backstage');
  note(`节拍 4 backstage  位置 ${s.pos.join(',')}`);
  await page.eval(`(() => {
    const g = window.__GAME__;
    g.player.teleport(9.8, 8, -22.4, Math.PI);
    g.player.lookAt(9.8, 9.2, -25.4);
  })()`);
  await sleep(600);
  await page.eval('window.__GAME__.interactions.trigger(window.__GAME__)');
  await waitFor('window.__GAME__.flag("vault-open") === true', '推开铁门');
  note('铁门打开');
  await page.eval('window.__GAME__.player.teleport(9.8, 8, -28.0, Math.PI)');
  await waitFor('window.__GAME__.director.mode === "cinematic"', '密室揭示镜头');
  note('密室揭示镜头播放中');
  await waitFor('window.__GAME__.director.mode === "fps"', '密室镜头结束', 240000);

  // 走到每一个密室可交互物面前按 E（位置直接从游戏里问，不靠硬编码）
  const vaultSpots = await page.eval(`window.__GAME__.interactions.list
    .filter(i => i.id.startsWith('vault-'))
    .map(i => ({ id: i.id, x: i.position.x, y: i.position.y, z: i.position.z }))`);
  for (const spot of vaultSpots) {
    await page.eval(`(() => {
      const g = window.__GAME__;
      // 站到它前面 1.6 米处
      const dx = ${spot.x} - g.player.position.x;
      const dz = ${spot.z} - g.player.position.z;
      g.player.teleport(${spot.x} - Math.sign(dx || 1) * 1.6, 8, ${spot.z} - Math.sign(dz || 1) * 1.6, 0);
      g.player.lookAt(${spot.x}, ${spot.y}, ${spot.z});
    })()`);
    await sleep(320);
    const hit = await page.eval(
      `(() => { const g = window.__GAME__; const cur = g.interactions.current; return cur ? cur.id : null; })()`,
    );
    await page.eval('window.__GAME__.interactions.trigger(window.__GAME__)');
    await sleep(260);
    note(`密室交互：${spot.id} → ${hit ?? '（没走到跟前）'}`);
  }
  const vflags = await page.eval(`(() => { const g = window.__GAME__;
    return { letters: g.flag('saw-letters'), child: g.flag('saw-child') }; })()`);
  note(`密室标记：信 ${vflags.letters}  孩子 ${vflags.child}`);
  await page.eval('window.__GAME__.player.teleport(9.8, 8, -23.0, 0)');

  // ── 五 · 回到礼厅 ─────────────────────────────────────
  s = await waitBeat('return');
  note(`节拍 5 return  位置 ${s.pos.join(',')}`);
  await waitFor('window.__GAME__.pistol.enabled === true', '拿到枪', 60000);
  s = await state();
  note(`武器就绪：弹药 ${s.ammo} 发`);
  await page.eval('window.__GAME__.player.teleport(0, 8, 5.0, 0)');

  // ── 六 · 开枪 ─────────────────────────────────────────
  s = await waitBeat('reckoning');
  note(`节拍 6 reckoning  位置 ${s.pos.join(',')}  清算 ${s.cleansed}/3`);
  // 拔枪，瞄准讲台上的尊者，扣扳机
  await page.eval(`(() => {
    const g = window.__GAME__;
    g.player.teleport(0, 8, 2.0, 0);
    g.player.pitch = -0.01;
    g.pistol.setDrawn(true, g);
  })()`);
  await sleep(700);
  await page.eval('window.__GAME__.pistol.tryFire(window.__GAME__)');
  await sleep(900);
  s = await state();
  note(`开枪后：弹药 ${s.ammo}  开枪 ${s.shots} 次  倒下 ${s.casualties} 人  清算 ${s.cleansed}/3`);
  if (s.shots < 1) {
    note('✗ 开枪没有生效');
    failed++;
  }
  if (s.casualties < 1) {
    note('✗ 一枪都没有打中（射线可能没穿过礼堂）');
    failed++;
  }
  // 再补两枪，验证连续射击与信徒反应
  for (let i = 0; i < 2; i++) {
    await page.eval('window.__GAME__.pistol.tryFire(window.__GAME__)');
    await sleep(700);
  }
  s = await state();
  note(`连开三枪后：弹药 ${s.ammo}  倒下 ${s.casualties} 人`);
  await page.screenshot('shots/playthrough-reckoning.png');

  await waitFor('window.__GAME__.cleansed >= 2', '尊者被清除', 90000);
  note('尊者倒下，清算计数推进到 2/3');
  await waitFor('!!document.getElementById("objective")?.textContent.includes("走出去")', '出口打开', 120000);
  note('目标变为「走出去」');
  await page.eval('window.__GAME__.player.teleport(0, 8, 10.5, 0)');

  // ── 七 · 俯视跑步 ─────────────────────────────────────
  s = await waitBeat('escape');
  note(`节拍 7 escape  镜头 ${s.mode}`);
  if (s.mode !== 'topdown') {
    note(`✗ 逃跑段的镜头不是俯视，而是 ${s.mode}`);
    failed++;
  } else {
    note('镜头已切到俯视跑步');
  }
  await page.screenshot('shots/playthrough-escape.png');
  // 用键盘真的跑一段，验证俯视模式下 WASD 是相对世界轴的
  const ez0 = (await state()).pos[2];
  await holdKey(...KEY.w, 0);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  await sleep(1800);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  const ez1 = (await state()).pos[2];
  note(`俯视下按 W：z ${ez0} → ${ez1.toFixed(2)}（应当变大 = 往山下）`);
  if (ez1 <= ez0) {
    note('✗ 俯视模式下按 W 没有往山下的方向走');
    failed++;
  }
  await page.eval('window.__GAME__.player.teleport(0, 0.1, 104, 0)');

  // ── 八 · 海边 ─────────────────────────────────────────
  s = await waitBeat('shore');
  note(`节拍 8 shore  镜头 ${s.mode}`);
  if (s.mode !== 'side') {
    note(`✗ 海边的镜头不是横版侧视，而是 ${s.mode}`);
    failed++;
  } else {
    note('镜头已切到横版侧视');
  }
  await page.screenshot('shots/playthrough-shore.png');
  await waitFor('window.__GAME__.player.inputEnabled === true', '海边镜头结束', 200000);
  await page.eval('window.__GAME__.player.teleport(0.2, 0.2, 110, 0)');

  // ── 九 · 结局 ─────────────────────────────────────────
  s = await waitBeat('ending');
  note(`节拍 9 ending  镜头 ${s.mode}`);
  await waitFor('!!window.__GAME__ && !document.getElementById("ending-card").classList.contains("hidden")', '结局卡', 240000);
  s = await state();
  note(`结局卡：${s.endingTitle}　|　${s.endingCount}`);
  if (s.cleansed !== 3) {
    note(`✗ 清算计数没有走到 3（当前 ${s.cleansed}）`);
    failed++;
  }
  await page.screenshot('shots/playthrough-ending.png');
} catch (e) {
  failed++;
  note(`✗ 中断：${e.message.split('\n')[0]}`);
  if (page.pageErrors.length) console.log('  未捕获异常：\n    ' + page.pageErrors.slice(0, 3).join('\n    '));
  if (page.consoleErrors.length) console.log('  console.error：\n    ' + page.consoleErrors.slice(0, 3).join('\n    '));
  try {
    await page.screenshot('shots/playthrough-failed.png');
    const s = await state();
    console.log('  最后状态：', JSON.stringify(s));
  } catch (e2) {
    console.log('  （页面已无响应，连状态都读不到了：' + e2.message.split('\n')[0] + '）');
  }
} finally {
  await close();
}

console.log(`\n${failed === 0 ? '通关成功，九个节拍全部走通' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
