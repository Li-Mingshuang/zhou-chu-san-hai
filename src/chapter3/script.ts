import { PLATEAU_Y, HALL, VAULT, YARD, ANCHORS } from '../world/Layout.js';
import { EXEC } from '../world/Execution.js';
import type { GameCtx } from '../core/GameTypes.js';
import type { Beat } from '../systems/Beat.js';
import { Seq, inRect } from '../systems/Beat.js';
import type { CinematicShot } from '../camera/CameraDirector.js';
import type { Cultist } from '../entities/Cultist.js';
import { remainingCount } from '../entities/Cultist.js';

/**
 * 第三章「新心灵舍」的节拍表。
 *
 * 九个节拍，约十二分钟。每一拍都可以用 ?beat=<id> 直接跳进去。
 * 镜头切换的计划写在各拍的 enter() 里——因为"什么时候换视角"本来就是剧本的一部分。
 */

const cap = (text: string): CinematicShot['caption'] => text;

function idolOf(g: GameCtx): Cultist | undefined {
  return g.cultists.find((c) => c.role === 'idol');
}

function sayIdol(g: GameCtx, text: string): void {
  g.say(text, { who: '尊者' });
}

// ══════════════════════════════════════════════════════════
//  一 · 抵岛
// ══════════════════════════════════════════════════════════

function beatArrival(): Beat {
  const opening: CinematicShot[] = [
    {
      from: [28, 8.0, 140],
      to: [27, 7.6, 137],
      look: [2, 2.6, 104],
      duration: 5.5,
      fov: 44,
      drift: 0.08,
      caption: cap('三天前，他从高雄上了船。船票是单程的。'),
      narr: true,
    },
    {
      from: [3.6, 2.1, 67],
      to: [3.0, 2.3, 63],
      look: [0, 1.5, 52],
      duration: 4.5,
      fov: 46,
      drift: 0.05,
      caption: cap('没有人来接他。他自己走上去。'),
      narr: true,
    },
    {
      from: [19, 19.5, 46],
      to: [17, 19.0, 43],
      look: [0, 10.5, 24],
      duration: 4.5,
      fov: 42,
      drift: 0.1,
      caption: cap('这座岛上有一间「新心靈舍」。里面住着一个从来不下山的人。'),
      narr: true,
    },
  ];

  return {
    id: 'arrival',
    title: '抵岛',
    enter(g) {
      g.renderer.setFade(0);
      g.renderer.fadeTo(1, 2.2);
      g.player.teleport(ANCHORS.shoreArrive!.x, ANCHORS.shoreArrive!.y, ANCHORS.shoreArrive!.z, 0.05);
      g.player.inputEnabled = true;
      g.setLightPreset('shore');
      g.audio.setSpace('shore');
      g.audio.setAmbience('sea', 1.5);
      g.objective('沿石阶上去');
      void g.director.playShots(opening, g, 'fps');
    },
    update(_dt, g) {
      if (g.director.mode === 'fps' && !g.director.isBlending) {
        g.audio.setAmbience('cicada', 3);
        g.audio.setSpace('outdoor');
      }
      if (g.player.position.z < 34 && g.director.mode === 'fps') g.goto();
    },
    shot(g) {
      g.player.teleport(0, 0, 88, 0);
      g.director.setPose([28, 8.0, 140], [2, 2.6, 104], 44);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  二 · 前院 · 把东西交出去
// ══════════════════════════════════════════════════════════

function beatYard(): Beat {
  const seq = new Seq([
    {
      at: 0,
      fn: (g) => g.say('院子扫得很干净。干净得不像有人住。', { narr: true }),
    },
    {
      at: 4.5,
      fn: (g) => g.say('师兄，把身上值钱的东西放在这里就好。', { who: '师姐' }),
    },
    {
      at: 7.5,
      fn: (g) => g.objective('把手表摘下来'),
    },
  ]);

  return {
    id: 'yard',
    title: '前院',
    enter(g) {
      seq.reset();
      g.setInputEnabled(true);
      g.director.setMode('fps', 0.6, g);
      g.setLightPreset('yard');
      g.audio.setAmbience('cicada', 2);
      g.audio.setSpace('outdoor');
      g.objective('走进院子');
      g.renderer.setTuning({ exposure: 1, saturation: 0.94 });
    },
    update(dt, g) {
      seq.update(dt, g);
      if (g.flag('gave-watch')) g.goto();
    },
    shot(g) {
      g.player.teleport(-3.0, PLATEAU_Y, 19.5, 0);
      g.director.setPose([-6.5, PLATEAU_Y + 2.1, 24.5], [-2.0, PLATEAU_Y + 1.2, 19.5], 44);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  三 · 礼厅 · 仪式
// ══════════════════════════════════════════════════════════

function beatRitual(): Beat {
  const hallOpening: CinematicShot[] = [
    {
      from: [0, PLATEAU_Y + 2.4, HALL.z1 - 0.6],
      to: [0, PLATEAU_Y + 2.6, HALL.z1 - 1.8],
      look: [0, PLATEAU_Y + 2.0, HALL.z0 + 2],
      duration: 5.5,
      fov: 46,
      drift: 0.04,
      caption: cap('禮廳裡坐滿了人。他們不看你。'),
      narr: true,
    },
    {
      from: [-3.2, PLATEAU_Y + 1.9, -12.6],
      to: [-2.4, PLATEAU_Y + 1.9, -12.9],
      look: [0, PLATEAU_Y + 2.1, -15.2],
      duration: 5,
      fov: 38,
      drift: 0.03,
      caption: cap('今天有新来的师兄。'),
    },
    {
      from: [2.0, PLATEAU_Y + 2.2, -11.0],
      to: [2.4, PLATEAU_Y + 2.2, -11.6],
      look: [0, PLATEAU_Y + 1.6, 4],
      duration: 4.5,
      fov: 44,
      drift: 0.04,
      caption: cap('大家一起念。念到心里什么都不剩。'),
    },
  ];

  const punishment: CinematicShot[] = [
    {
      from: [0.8, PLATEAU_Y + 1.75, -11.6],
      to: [0.4, PLATEAU_Y + 1.7, -12.4],
      look: [0, PLATEAU_Y + 1.5, -16],
      duration: 4.5,
      fov: 36,
      drift: 0.03,
      caption: cap('你身上有很重的东西。要把它拿出来。'),
    },
    {
      from: [0, PLATEAU_Y + 4.4, -7.5],
      to: [0, PLATEAU_Y + 4.2, -8.6],
      look: [0, PLATEAU_Y + 0.5, -13.5],
      duration: 4.5,
      fov: 52,
      drift: 0.05,
      caption: cap('所有人都在看你。这里没有人替你说话。'),
      narr: true,
    },
    {
      from: [-1.6, PLATEAU_Y + 1.4, -12.2],
      to: [-1.2, PLATEAU_Y + 1.3, -12.5],
      look: [0.4, PLATEAU_Y + 1.2, -14.4],
      duration: 2.6,
      fov: 34,
      drift: 0.02,
      caption: cap('第一下。'),
      narr: true,
    },
  ];

  const seq = new Seq([
    { at: 0.2, fn: (g) => g.audio.lash() },
    { at: 0.24, fn: (g) => g.hitFx(0.9, 0.5) },
    { at: 1.8, fn: (g) => g.audio.lash() },
    { at: 1.84, fn: (g) => g.hitFx(1.1, 0.7) },
    { at: 3.4, fn: (g) => g.audio.lash() },
    { at: 3.44, fn: (g) => g.hitFx(1.3, 0.9) },
    {
      at: 4.2,
      fn: (g) => {
        g.say('他趴在地上。有人把手放在他头上，很轻。', { narr: true });
      },
    },
    {
      at: 6.2,
      fn: (g) => {
        g.flag('allowed-backstage', true);
        g.objective('跟他去后院');
      },
    },
  ]);

  type Phase = 'walk-in' | 'sermon' | 'sit' | 'punish' | 'after';
  let phase: Phase = 'walk-in';

  return {
    id: 'ritual',
    title: '仪式',
    enter(g) {
      phase = 'walk-in';
      seq.reset();
      g.setInputEnabled(true);
      g.director.setMode('fps', 0.6, g);
      g.setLightPreset('hall');
      g.audio.setAmbience('hall', 3);
      g.audio.setSpace('hall');
      g.objective('走进礼厅');
      g.renderer.setTuning({ exposure: 1.16, saturation: 0.88 });
    },
    update(dt, g) {
      switch (phase) {
        case 'walk-in': {
          if (g.player.position.z < 6 && g.director.mode === 'fps') {
            phase = 'sermon';
            g.setInputEnabled(false);
            void g.director.playShots(hallOpening, g, 'fps');
          }
          break;
        }
        case 'sermon': {
          if (g.director.mode === 'fps' && !g.director.isBlending) {
            phase = 'sit';
            g.objective('到最后一排坐下');
            g.say('最后一排还有个位置。', { narr: true });
          }
          break;
        }
        case 'sit': {
          if (g.flag('sat-last-row')) {
            phase = 'punish';
            g.setInputEnabled(false);
            g.player.lookLock = { yaw: 0, pitch: -0.02 };
            void g.director.playShots(punishment, g, 'fps');
          }
          break;
        }
        case 'punish': {
          if (g.director.mode === 'cinematic') seq.update(dt, g);
          if (g.director.mode === 'fps' && !g.director.isBlending && seq.done) {
            phase = 'after';
            g.player.lookLock = null;
            g.setInputEnabled(true);
          }
          break;
        }
        case 'after': {
          if (g.player.position.z > 4 && Math.abs(g.player.position.x) < 4 && g.player.position.z < 9) {
            g.goto();
          }
          break;
        }
        default:
          break;
      }
    },
    shot(g) {
      g.player.teleport(0, PLATEAU_Y, 3.6, 0);
      for (const c of g.cultists) c.update(0.016, g);
      g.director.setPose([0, PLATEAU_Y + 2.4, HALL.z1 - 0.6], [0, PLATEAU_Y + 2.0, HALL.z0 + 2], 46);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  四 · 密室
// ══════════════════════════════════════════════════════════

function beatBackstage(): Beat {
  const vaultReveal: CinematicShot[] = [
    {
      from: [9.8, PLATEAU_Y + 1.6, VAULT.z1 + 1.4],
      to: [8.6, PLATEAU_Y + 1.6, VAULT.z1 - 0.4],
      look: [-2, PLATEAU_Y + 1.2, -33],
      duration: 4.5,
      fov: 50,
      drift: 0.05,
      caption: cap('里面不是仓库。'),
      narr: true,
    },
    {
      from: [-1.5, PLATEAU_Y + 1.5, -29.6],
      to: [-1.2, PLATEAU_Y + 1.4, -30.4],
      look: [-1.5, PLATEAU_Y + 0.9, -31.6],
      duration: 4,
      fov: 34,
      drift: 0.03,
      caption: cap('捆好的、橡皮筋还在的、数不清的。'),
      narr: true,
    },
    {
      from: [-6.8, PLATEAU_Y + 1.6, -33.4],
      to: [-7.4, PLATEAU_Y + 1.5, -34.2],
      look: [-5.6, PLATEAU_Y + 1.3, -40.6],
      duration: 5,
      fov: 38,
      drift: 0.04,
      caption: cap('还有一间上了锁的小房间。'),
      narr: true,
    },
  ];

  const seq = new Seq([
    {
      at: 0.2,
      fn: (g) => g.say('后面有干净的水。你来。', { who: '尊者' }),
    },
    {
      at: 4.0,
      fn: (g) => g.objective('推开后山的铁门'),
    },
    {
      at: 5.0,
      fn: (g) => g.say('他走到一半就停下了。门上的锁没锁，只是挂在那里。', { narr: true }),
    },
  ]);

  let entered = false;
  let revealDone = false;
  let waitAfterChild = 0;

  return {
    id: 'backstage',
    title: '密室',
    enter(g) {
      seq.reset();
      entered = false;
      revealDone = false;
      waitAfterChild = 0;
      g.flag('allowed-backstage', true);
      g.setInputEnabled(true);
      g.director.setMode('fps', 0.6, g);
      g.audio.setAmbience('hall', 2);
      g.objective('往礼堂后门走');
      g.renderer.setTuning({ exposure: 1.08, saturation: 0.9 });
    },
    update(dt, g) {
      seq.update(dt, g);

      if (g.flag('vault-open') && !entered && g.player.position.z < VAULT.z1 - 1.5) {
        entered = true;
        g.setLightPreset('vault');
        g.audio.setAmbience('vault', 2.5);
        g.audio.setSpace('vault');
        g.renderer.setTuning({ exposure: 1.12, saturation: 0.84 });
        g.setInputEnabled(false);
        void g.director
          .playShots(vaultReveal, g, 'fps')
          .then(() => {
            revealDone = true;
            g.setInputEnabled(true);
            g.objective('看看这里到底有什么');
          });
      }

      if (!revealDone) return;

      const flags =
        (g.flag('saw-letters') ? 1 : 0) + (g.flag('saw-child') ? 1 : 0);
      if (flags >= 2 || g.flag('saw-child')) {
        waitAfterChild += dt;
        if (waitAfterChild > 5) {
          g.objective('回到礼厅');
          if (g.player.position.z > VAULT.z1 + 2) g.goto();
        }
      }
    },
    shot(g) {
      g.flag('allowed-backstage', true);
      g.flag('vault-open', true);
      g.player.teleport(9.8, PLATEAU_Y, VAULT.z1 - 0.5, Math.PI);
      g.director.setPose([-1.5, PLATEAU_Y + 1.5, -29.6], [-1.5, PLATEAU_Y + 0.9, -31.6], 40);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  五 · 回到最后一排
// ══════════════════════════════════════════════════════════

function beatReturn(): Beat {
  const seq = new Seq([
    {
      at: 0.4,
      fn: (g) => g.say('他把那把枪从腰后摸出来，掂了掂。', { narr: true }),
    },
    {
      at: 2.6,
      fn: (g) => {
        g.pistol.enabled = true;
        g.pistol.refill();
        g.say('六发。够了。', { narr: true });
      },
    },
    {
      at: 5.0,
      fn: (g) => g.objective('回到礼厅，坐到最后一排'),
    },
  ]);

  let asked = false;

  return {
    id: 'return',
    title: '回到礼厅',
    enter(g) {
      seq.reset();
      asked = false;
      g.setInputEnabled(true);
      g.director.setMode('fps', 0.6, g);
      g.pistol.enabled = true;
      g.audio.setAmbience('hall', 2.5);
      g.audio.setSpace('hall');
      g.objective('穿过院子回到礼厅');
      g.renderer.setTuning({ exposure: 1.14, saturation: 0.84 });
    },
    update(dt, g) {
      seq.update(dt, g);
      const p = g.player.position;
      const inside = inRect(p.x, p.z, HALL.x0, HALL.x1, HALL.z0 + 1, HALL.z1 - 0.5) && p.y > PLATEAU_Y - 1;
      if (inside && !asked) {
        asked = true;
        g.objective('做你要做的事');
        sayIdol(g, '你回来了。坐吧。我们都等着你。');
      }
      if (inside && p.z > HALL.benchZ1 - 0.4 && g.director.mode === 'fps') {
        g.goto();
      }
    },
    shot(g) {
      g.player.teleport(0, PLATEAU_Y, 6.4, 0);
      g.director.setPose([0, PLATEAU_Y + 1.72, HALL.z1 - 1.2], [0, PLATEAU_Y + 1.5, HALL.z0 + 3], 46);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  六 · 开枪
// ══════════════════════════════════════════════════════════

function beatReckoning(): Beat {
  const seq = new Seq([
    { at: 0.5, fn: (g) => sayIdol(g, '你病了。眼睛里都是灰。') },
    { at: 6.5, fn: (g) => g.say('他站起来的时候，没有人回头。', { narr: true }) },
    { at: 8.0, fn: (g) => sayIdol(g, '把枪放下。我们一起念。') },
    { at: 16.0, fn: (g) => g.say('第一排有人开始念了。念得很齐。', { narr: true }) },
    { at: 24.0, fn: (g) => sayIdol(g, '你打不开这个结的，陈先生。') },
    {
      at: 30.0,
      fn: (g) => g.say('他可以现在就转身走出去。也可以不。', { narr: true }),
    },
  ]);

  let drewReported = false;
  let firstShot = false;
  let idolDead = false;
  let armedExit = false;
  let exitTimer = 0;

  return {
    id: 'reckoning',
    title: '做出决定',
    enter(g) {
      seq.reset();
      drewReported = false;
      firstShot = false;
      idolDead = false;
      armedExit = false;
      exitTimer = 0;
      g.setInputEnabled(true);
      g.director.setMode('fps', 0.7, g);
      g.player.lookLock = null;
      g.player.teleport(HALL.aisleX0! + 1.0, PLATEAU_Y, HALL.benchZ1 + 0.8, 0.02);
      g.player.yaw = 0.02;
      g.audio.setAmbience('chant', 3);
      g.audio.setSpace('hall');
      g.renderer.setTuning({ exposure: 1.14, saturation: 0.82 });
      g.ui.setCleansed(g.cleansed, true);
      g.objective('做出你的决定');
      g.say('前一排有人挪了一下。木头响了一声。', { narr: true });
    },
    update(dt, g) {
      seq.update(dt, g);

      if (g.pistol.drawn && !drewReported) {
        drewReported = true;
        for (const c of g.cultists) c.onGunDrawn(g);
        g.say('有人看见了他袖子里的东西。', { narr: true });
      }

      if (g.shotsFired > 0 && !firstShot) {
        firstShot = true;
        g.audio.setAmbience('silence', 1.2);
        g.say('整座礼厅安静下来。安静得像被按住了。', { narr: true });
      }

      const idol = idolOf(g);
      if (idol && !idol.alive && !idolDead) {
        idolDead = true;
        g.say('尊者倒在地上了。他连一句话都没说完。', { narr: true });
        // 第三害：第一害是香港仔，这一位是第二位。
        g.addCleansed();
      }

      // 出口只在"做出决定之后"才打开：开过枪，或者站够了时间
      if (!armedExit && (idolDead || seq.time > 26)) {
        armedExit = true;
        g.objective('走出去');
      }

      if (armedExit) {
        exitTimer += dt;
        const p = g.player.position;
        const outdoors = p.z > HALL.z1 + 0.6 && p.y > PLATEAU_Y - 1;
        if (outdoors && exitTimer > 1.0) {
          g.flag('left-hall', true);
          g.goto();
          // 必须立刻收手：goto() 会同步跑完下一拍的 enter()，
          // 而下面那个"人都没了"的条件会被它顺带改成真，于是同一帧连跳两拍。
          return;
        }
      }

      // 都跑光了、也都倒了，就结束
      if (firstShot && remainingCount(g.cultists) === 0) {
        exitTimer += dt;
        if (exitTimer > 6) {
          g.flag('left-hall', true);
          g.goto();
        }
      }
    },
    shot(g) {
      g.player.teleport(0, PLATEAU_Y, HALL.benchZ1 - 0.6, 0);
      g.player.pitch = 0;
      for (const c of g.cultists) c.update(0.016, g);
      g.director.setPose([0, PLATEAU_Y + 1.72, HALL.benchZ1 + 1.4], [0, PLATEAU_Y + 1.9, HALL.z0 + 4], 48);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  七 · 逃离 · 俯视跑步
// ══════════════════════════════════════════════════════════

function beatEscape(): Beat {
  const seq = new Seq([
    { at: 0.4, fn: (g) => g.say('他跑的时候没有回头。', { narr: true }) },
    { at: 6.0, fn: (g) => g.say('院子里那口缸被打翻了。他没有听见。', { narr: true }) },
    { at: 14.0, fn: (g) => g.say('石阶很长。他数到第二十级就不数了。', { narr: true }) },
    {
      at: 22.0,
      fn: (g) => g.say('山下面就是海。海边上有一条船。', { narr: true }),
    },
  ]);

  return {
    id: 'escape',
    title: '下山',
    enter(g) {
      seq.reset();
      g.setInputEnabled(true);
      g.player.forcedRun = true;
      g.player.control = 'topdown';
      // 他要往山下（+Z）跑。先让他朝那边，镜头才会出现在他背后，
      // 而且 W 键就等于"屏幕往上"= 他真正要去的方向。
      g.player.facing = Math.PI;
      g.player.yaw = Math.PI;
      g.director.topdown.forwardYaw = Math.PI;
      g.director.setMode('topdown', 0.85, g);
      // 镜头参数是量出来的，不是猜的：15.5 米时一个 1.78 米的人只占画面
      // 5.9% 高（33 像素），俯视跑步就变成"看地图"。9 米 + 55° 俯角
      // 把他放大到约 15%，同时还能看见前方十来米的路。
      // 穿墙由 CameraDirector.avoidWalls 处理，不然刚出礼厅那一段镜头
      // 会直接从屋顶穿出去。
      g.director.topdown.height = 9;
      g.director.topdown.pitch = 0.98;
      g.director.topdown.lead = 5;
      g.director.topdown.fov = 48;
      g.setLightPreset('path');
      g.audio.setAmbience('wind', 2);
      g.audio.setSpace('outdoor');
      g.renderer.setTuning({ exposure: 1.18, saturation: 0.88 });
      g.objective('下山');
      g.ui.setCleansed(g.cleansed, false);
      g.renderer.fadeTo(1, 0.8);
      // 他跑出大门那一刻，道场里剩下的人就跟这一章无关了。
      // 否则"走过来劝你"的那些人会一路跟着他走到海边，说话还在耳边。
      for (const c of g.cultists) {
        if (c.role === 'follower' || c.role === 'elder') c.retire();
      }
    },
    update(dt, g) {
      seq.update(dt, g);
      if (g.player.position.z > 100) {
        g.player.forcedRun = false;
        g.goto();
      }
    },
    shot(g) {
      g.player.teleport(0, PLATEAU_Y - 3, 34, 0);
      g.player.forcedRun = true;
      g.player.control = 'topdown';
      g.director.topdown.forwardYaw = Math.PI;
      g.director.topdown.height = 9;
      g.director.topdown.pitch = 0.98;
      g.director.topdown.lead = 5;
      g.director.topdown.fov = 48;
      g.director.setMode('topdown', 0, g);
      // 让跟随状态直接收敛到目标，避免第一帧还在天上
      for (let i = 0; i < 120; i++) g.director.update(1 / 60, g);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  八 · 海边 · 横版
// ══════════════════════════════════════════════════════════

function beatShore(): Beat {
  const wash: CinematicShot[] = [
    {
      from: [-0.5, 1.5, 102.4],
      to: [-0.4, 1.5, 102.2],
      look: [0.2, 0.9, 103.0],
      duration: 5.5,
      fov: 36,
      drift: 0.03,
      caption: cap('他把手放进海里。水是凉的。'),
      narr: true,
    },
    {
      from: [-1.1, 1.45, 104.4],
      to: [-1.0, 1.4, 104.2],
      look: [0.1, 1.05, 104.8],
      duration: 5.5,
      fov: 34,
      drift: 0.03,
      caption: cap('刮胡刀是那个师姐塞给他的。刀片很新。'),
      narr: true,
    },
  ];

  const seq = new Seq([
    { at: 0.3, fn: (g) => g.say('风从东边来。浪一下一下打在沙上。', { narr: true }) },
    {
      at: 3.0,
      fn: (g) => {
        g.setInputEnabled(false);
        void g.director.playShots(wash, g, 'side').then(() => {
          g.setInputEnabled(true);
          g.objective('走到码头');
        });
      },
    },
    {
      at: 14.0,
      fn: (g) => {
        g.setInputEnabled(true);
        g.objective('走到码头');
      },
    },
  ]);

  return {
    id: 'shore',
    title: '海边',
    enter(g) {
      seq.reset();
      g.setInputEnabled(true);
      g.player.control = 'side';
      g.director.side.axis = 'z';
      g.director.side.side = -1;
      g.director.side.distance = 8.4;
      g.director.side.height = 1.9;
      g.director.side.lookHeight = 1.05;
      g.director.side.fov = 34;
      g.director.setMode('side', 0.9, g);
      g.setLightPreset('shore');
      g.audio.setAmbience('sea', 2.5);
      g.audio.setSpace('shore');
      g.renderer.setTuning({ exposure: 1.18, saturation: 0.68 });
      g.objective('往码头的方向走');
      g.say('他蹲下来，把手伸进水里。', { narr: true });
    },
    update(dt, g) {
      seq.update(dt, g);
      if (g.player.position.z > 107 && g.director.mode === 'side') g.goto();
    },
    shot(g) {
      g.player.teleport(0.2, 0.2, 100, 0);
      g.player.control = 'side';
      g.director.side.axis = 'z';
      g.director.side.side = -1;
      g.director.side.distance = 8.4;
      g.director.setMode('side', 0, g);
      g.director.setPose([-8.2, 2.1, 102], [0.2, 1.3, 103], 34);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  九 · 自首
// ══════════════════════════════════════════════════════════

function beatArrest(): Beat {
  const seq = new Seq([
    {
      at: 0.4,
      fn: (g) => g.say('船靠上码头的时候，他看见岸上站着一排人。', { narr: true }),
    },
    {
      at: 4.5,
      fn: (g) => g.objective('走过去'),
    },
  ]);

  // 正面固定机位。全片他第一次被人从正面看着。
  const arrest: CinematicShot[] = [
    {
      from: [-3.9, 1.62, 94.2],
      to: [-3.4, 1.6, 93.8],
      look: 'player',
      duration: 4.5,
      fov: 40,
      drift: 0.06,
      caption: cap('他走下来的时候，没有人喊话，也没有人举枪。'),
      narr: true,
    },
    {
      from: [0, 1.66, 92.2],
      to: [0, 1.64, 92.0],
      look: 'player',
      duration: 5,
      fov: 36,
      drift: 0.03,
      caption: cap('我是陈桂林。'),
    },
    {
      from: [0.5, 1.7, 94.6],
      to: [0.3, 1.68, 94.9],
      look: 'player',
      duration: 4.5,
      fov: 30,
      drift: 0.02,
      caption: cap('通缉榜上第三名。我来投案。'),
    },
    {
      from: [11, 6.2, 99],
      to: [10, 6.4, 100],
      look: [0, 1.3, 95],
      duration: 5,
      fov: 44,
      drift: 0.09,
      caption: cap('他没有把枪拿出来。'),
      narr: true,
    },
  ];

  const after = new Seq([
    { at: 0.3, fn: (g) => (g.player.scriptedVelocity = null) },
    { at: 0.4, fn: (g) => g.audio.metalDoor() },
    { at: 1.6, fn: (g) => g.renderer.fadeTo(0, 2.2) },
    {
      at: 4.0,
      fn: (g) => {
        g.say('三个月后。', { narr: true });
      },
    },
  ]);

  let phase: 'walk' | 'cut' | 'out' = 'walk';

  return {
    id: 'arrest',
    title: '自首',
    enter(g) {
      phase = 'walk';
      seq.reset();
      after.reset();
      g.setLightPreset('shore');
      g.renderer.setTuning({ exposure: 1.14, saturation: 0.6 });
      g.audio.setAmbience('sea', 2.5);
      g.audio.setSpace('shore');
      g.setInputEnabled(true);
      g.player.control = 'fps';
      g.director.setMode('fps', 0.8, g);
      g.player.teleport(0, 0.95, 116, Math.PI);
      g.player.scriptedVelocity = null;
      g.objective('往岸上走');
      g.revealPolice();
    },
    update(dt, g) {
      seq.update(dt, g);

      if (phase === 'walk') {
        if (g.player.position.z < 100) {
          phase = 'cut';
          g.objective(null);
          g.setInputEnabled(false);
          g.player.scriptedVelocity = { x: 0, z: -1 };
          void g.director.playShots(arrest, g, null);
        }
        return;
      }

      if (phase === 'cut') {
        after.update(dt, g);
        if (after.done) phase = 'out';
        return;
      }

      if (g.renderer.isBlack) g.goto();
    },
    shot(g) {
      g.revealPolice();
      g.player.teleport(0, 0.15, 96.8, Math.PI);
      for (const c of g.cultists) c.update(0.016, g);
      g.director.setPose([0, 1.66, 92.2], [0, 1.5, 96.8], 36);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  十 · 刑场
// ══════════════════════════════════════════════════════════

function beatExecution(): Beat {
  const shots: CinematicShot[] = [
    {
      from: [EXEC.x + 8, 3.4, EXEC.z + 15],
      to: [EXEC.x + 6, 3.2, EXEC.z + 13],
      look: [EXEC.x, 1.2, EXEC.z - 9],
      duration: 6,
      fov: 40,
      drift: 0.12,
      caption: cap('三个月后。'),
    },
    {
      from: [EXEC.x + 3.4, 1.7, EXEC.z - 3.0],
      to: [EXEC.x + 2.6, 1.68, EXEC.z - 3.6],
      look: 'player',
      duration: 6,
      fov: 36,
      drift: 0.05,
      caption: cap('他走进来的时候，抬头看了一圈。铁丝网上缠着去年的塑料袋。'),
      narr: true,
    },
    {
      from: [EXEC.x, 1.6, EXEC.postZ + 3.6],
      to: [EXEC.x, 1.6, EXEC.postZ + 3.4],
      look: [EXEC.x, 1.42, EXEC.postZ],
      duration: 7,
      fov: 34,
      drift: 0.02,
      caption: cap('有人问他还有没有话要说。'),
    },
    {
      from: [EXEC.x + 0.62, 1.52, EXEC.postZ + 1.7],
      to: [EXEC.x + 0.55, 1.5, EXEC.postZ + 1.62],
      look: [EXEC.x, 1.46, EXEC.postZ],
      duration: 6,
      fov: 26,
      drift: 0.015,
      caption: cap('他说没有。然后他笑了一下。'),
      narr: true,
    },
  ];

  const volley = new Seq([
    { at: 0.2, fn: (g) => g.renderer.kick(1.5, 0x000000) },
    { at: 0.22, fn: (g) => g.audio.gunshot('outdoor') },
    { at: 0.24, fn: (g) => g.audio.gunshot('outdoor') },
    { at: 0.26, fn: (g) => g.audio.gunshot('outdoor') },
    { at: 0.28, fn: (g) => g.audio.gunshot('outdoor') },
    { at: 0.3, fn: (g) => g.audio.gunshot('outdoor') },
    { at: 0.35, fn: (g) => g.renderer.fadeTo(0, 0.12) },
    { at: 1.8, fn: (g) => g.audio.setAmbience('silence', 0.4) },
  ]);

  let phase: 'intro' | 'walk' | 'volley' | 'out' = 'intro';

  return {
    id: 'execution',
    title: '刑场',
    enter(g) {
      phase = 'intro';
      volley.reset();
      g.renderer.setFade(0);
      g.renderer.fadeTo(1, 1.6);
      g.setLightPreset('shore');
      // 近乎黑白。这一段不需要颜色。
      g.renderer.setTuning({ exposure: 1.2, saturation: 0.18 });
      g.audio.setAmbience('silence', 0);
      g.audio.setSpace('outdoor');
      g.setInputEnabled(false);
      g.revealPolice();
      g.player.teleport(EXEC.x, EXEC.floor, EXEC.z + 11, Math.PI);
      g.player.scriptedVelocity = null;
      g.objective(null);
      g.ui.setCleansed(g.cleansed, false);
      void g.director.playShots(shots, g, null);
    },
    update(dt, g) {
      if (phase === 'intro' && g.renderer.fadeValue > 0.85) {
        phase = 'walk';
        // 第二镜开始他往柱子那边走
        g.player.scriptedVelocity = { x: 0, z: -1 };
        setTimeout(() => {
          /* 走到柱子就停，由下面的位置判断接管 */
        }, 0);
      }

      if (phase === 'walk') {
        // 走到行刑柱前站住
        if (g.player.position.z <= EXEC.postZ + 1.1) {
          g.player.scriptedVelocity = null;
          const d = EXEC.postZ + 1.1 - g.player.position.z;
          if (d < 0) g.player.teleport(EXEC.x, EXEC.floor, EXEC.postZ + 1.1, Math.PI);
        }
        // 最后一镜结束后开火
        if (g.director.cinematicDone) {
          phase = 'volley';
          volley.reset();
        }
      }

      if (phase === 'volley') {
        volley.update(dt, g);
        if (volley.done) phase = 'out';
      }

      if (phase === 'out' && g.renderer.isBlack) g.goto();
    },
    shot(g) {
      g.revealPolice();
      g.player.teleport(EXEC.x, EXEC.floor, EXEC.postZ + 1.1, Math.PI);
      for (const c of g.cultists) c.update(0.016, g);
      g.director.setPose([EXEC.x, 1.6, EXEC.postZ + 3.6], [EXEC.x, 1.42, EXEC.postZ], 34);
    },
  };
}

// ══════════════════════════════════════════════════════════
//  十一 · 结局
// ══════════════════════════════════════════════════════════

function beatEnding(): Beat {
  return {
    id: 'ending',
    title: '结局',
    enter(g) {
      g.setInputEnabled(false);
      g.player.scriptedVelocity = null;
      g.objective(null);
      g.finish(g.resolveEnding());
    },
    update() {
      /* 结局卡已经在画面上 */
    },
    shot(g) {
      g.player.teleport(0, 0.95, 106, Math.PI);
      g.director.setPose([0.5, 1.95, 106.2], [0.3, 1.5, 108.5], 34);
    },
  };
}

// ══════════════════════════════════════════════════════════

export function createChapter3(): Beat[] {
  return [
    beatArrival(),
    beatYard(),
    beatRitual(),
    beatBackstage(),
    beatReturn(),
    beatReckoning(),
    beatEscape(),
    beatShore(),
    beatArrest(),
    beatExecution(),
    beatEnding(),
  ];
}

export const CHAPTER3_BEATS = [
  'arrival',
  'yard',
  'ritual',
  'backstage',
  'return',
  'reckoning',
  'escape',
  'shore',
  'arrest',
  'execution',
  'ending',
] as const;

export type Chapter3BeatId = (typeof CHAPTER3_BEATS)[number];

/** 供外部引用，避免 import 被摇掉。 */
export const CHAPTER3_INFO = {
  title: '第三章 · 新心灵舍',
  beats: CHAPTER3_BEATS,
  bounds: { hall: HALL, vault: VAULT, yard: YARD },
};
