// 真实入口：可信鼠标事件走"标题卡 → 点开始 → 指针锁 → 开枪"。
//
// 之前的验收全部用 ?intro=0 / ?shot= 绕过标题卡，于是这条路上
// 的每一个问题（标题不消失、拿不到指针锁、左键没有反应）都没被碰到过。
// 这里用 CDP 派发的是**可信事件**，和真人点击的路径一致。

import { launch, sleep } from './cdp.mjs';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const { page, close } = await launch({ url: 'about:blank', width: 900, height: 560 });

let failed = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const probe = () =>
  page.eval(`(() => {
    const g = window.__GAME__;
    const ov = document.getElementById('overlay');
    const card = document.getElementById('title-card');
    const btn = document.getElementById('btn-start');
    return {
      started: g?.started, paused: g?.paused, beat: g?.beatId, mode: g?.director?.mode, inputEnabled: g?.player?.inputEnabled, lockFailed: g?.input?.lockFailed,
      overlayClass: ov?.className ?? '',
      overlayBg: ov ? getComputedStyle(ov).backgroundColor : '',
      cardDisplay: card ? getComputedStyle(card).display : '',
      cardBox: card ? card.getBoundingClientRect().width + 'x' + card.getBoundingClientRect().height : '',
      btnRect: btn ? JSON.stringify(btn.getBoundingClientRect()) : '',
      pointerLocked: !!document.pointerLockElement,
      lockHint: document.getElementById('lock-hint')?.className ?? '',
      crosshair: document.getElementById('crosshair')?.className ?? '',
      ammoOpacity: document.getElementById('ammo') ? getComputedStyle(document.getElementById('ammo')).opacity : '',
      letterbox: document.getElementById('letterbox')?.className ?? '',
      cultists: g ? g.cultists.length : 0,
      visibleNow: g ? g.cultists.filter(c => c.humanoid.root.visible).length : 0,
      shots: g?.pistol?.shotsFired, ammo: g?.pistol?.ammo, drawn: g?.pistol?.drawn,
      casualties: g?.casualties,
      fatal: (document.getElementById('fatal')?.textContent ?? '').trim().slice(0, 160),
    };
  })()`);

/** 用可信事件点一个元素（按它的中心坐标）。 */
async function clickElement(selector) {
  const r = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  if (!r) throw new Error(`找不到 ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: r.x,
      y: r.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    });
    await sleep(40);
  }
}

try {
  console.log('═══ 真实入口测试（可信事件）');
  await page.goto(`${BASE}/?debug=1&mute=1&timescale=3`);
  await page.waitFor('!!window.__GAME__', 30000, 'Game 构造完成');
  await sleep(1200);

  let s = await probe();
  check(s.cardDisplay !== 'none', '标题卡在点击前是可见的', `display=${s.cardDisplay}`);
  check(s.pointerLocked === false, '点击前没有指针锁');

  // ── 点"进入小岛"（可信事件） ─────────────────────────
  await clickElement('#btn-start');
  await sleep(1800);
  s = await probe();

  console.log('\n── 点开始之后');
  console.log(`   overlay="${s.overlayClass}" bg=${s.overlayBg} card.display=${s.cardDisplay}`);
  console.log(`   pointerLocked=${s.pointerLocked} lockHint="${s.lockHint}" crosshair="${s.crosshair}" ammo.opacity=${s.ammoOpacity}`);
  check(s.started === true, '游戏已开始');
  check(s.cardDisplay === 'none', '标题卡已消失', `display=${s.cardDisplay}`);
  // headless 的 Chrome 永远不给指针锁（"root document is not valid for pointer lock"），
  // 所以这里验的是"鼠标输入这条路是通的"：要么锁住了，要么降级生效。
  check(
    s.pointerLocked === true || s.lockFailed === true,
    '鼠标输入可用（拿到指针锁，或已降级为不锁也能玩）',
    `locked=${s.pointerLocked} lockFailed=${s.lockFailed}`,
  );
  check(s.fatal === '', '没有致命错误');

  // ── 走进礼厅，看有几个人、能不能开枪 ─────────────────
  // 开场镜头 14.5 秒，headless 的软件渲染只有几帧每秒，这里自己轮询并打印进度。
  {
    const deadline = Date.now() + 180000;
    let ready = false;
    let lastLog = -1;
    while (Date.now() < deadline) {
      const raw = await page.eval(
        `(() => { const g = window.__GAME__; return JSON.stringify({
            e: +g.elapsed.toFixed(1), mode: g.director.mode, ie: g.player.inputEnabled, paused: g.paused,
            fatal: (document.getElementById('fatal').textContent || '').slice(0, 80) }); })()`,
      );
      const st = JSON.parse(raw);
      if (st.fatal) throw new Error(`页面内致命错误：${st.fatal.split('\n')[0]}`);
      if (st.ie) {
        ready = true;
        break;
      }
      const bucket = Math.round(st.e);
      if (bucket !== lastLog && bucket % 5 === 0) {
        lastLog = bucket;
        console.log(`   等待开场镜头… elapsed=${st.e}s mode=${st.mode}`);
      }
      await sleep(500);
    }
    check(ready, '开场镜头放完，控制权交回玩家');
  }
  console.log('\n── 开场镜头结束');

  await page.eval(`(() => {
    const g = window.__GAME__;
    g.player.teleport(0, 8, 4.0, 0);
    g.player.pitch = -0.02;
    g.pistol.enabled = true;
    g.ui.setPrompt(null);
  })()`);
  await sleep(700);

  const hall = await page.eval(`(() => {
    const g = window.__GAME__;
    const cam = g.camera;
    const seen = [];
    for (const c of g.cultists) {
      const dx = c.position.x - cam.position.x;
      const dz = c.position.z - cam.position.z;
      const dist = Math.hypot(dx, dz);
      seen.push({ role: c.role, dist: +dist.toFixed(1), visible: c.humanoid.root.visible, inFront: dz < 0 });
    }
    const byRole = {};
    for (const s of seen) byRole[s.role] = (byRole[s.role] ?? 0) + 1;
    return {
      byRole,
      visibleInFront: seen.filter(s => s.visible && s.inFront && s.dist < 26).length,
      idolDist: seen.filter((_, i) => g.cultists[i].role === 'idol').map(s => s.dist)[0],
    };
  })()`);
  console.log(`\n── 礼厅里 (` + JSON.stringify(hall.byRole) + ')');
  check((hall.byRole.singer ?? 0) === 1, '礼厅里有弹吉他唱歌的人');
  check((hall.byRole.idol ?? 0) === 1, '礼厅里有尊者（老大）');
  check(hall.visibleInFront >= 12, '前方视野里的信徒数量够撑起一场戏', `inFront=${hall.visibleInFront}`);
  await page.screenshot('shots/entry-hall.png');

  // ── 左键开枪（可信事件） ─────────────────────────────
  const before = await probe();
  await clickElement('#stage');
  await sleep(900);
  s = await probe();
  console.log('\n── 第一次左键');
  console.log(`   drawn=${s.drawn} shots=${s.shots} ammo=${s.ammo} crosshair="${s.crosshair}"`);
  check(s.drawn === true, '左键把枪拔出来了');
  check(s.shots === before.shots + 1, '左键同时打出了一枪', `${before.shots} → ${s.shots}`);
  check(s.ammo === before.ammo - 1, '弹药减少了', `${before.ammo} → ${s.ammo}`);

  // 再开两枪，验证真的能打倒人
  for (let i = 0; i < 2; i++) {
    await clickElement('#stage');
    await sleep(700);
  }
  s = await probe();
  console.log(`\n── 三枪之后：shots=${s.shots} ammo=${s.ammo} 倒下=${s.casualties}`);
  check(s.shots === 3, '三枪都记录下来了');
  check((s.casualties ?? 0) >= 1, '有人被打倒了', `倒下 ${s.casualties}`);
  await page.screenshot('shots/entry-shooting.png');

  if (page.pageErrors.length) {
    console.log('\n未捕获异常：');
    for (const e of page.pageErrors.slice(0, 4)) console.log('   ' + e.split('\n')[0]);
    failed++;
  }
} catch (e) {
  failed++;
  console.log(`✗ 中断：${e.message.split('\n')[0]}`);
} finally {
  await close();
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
