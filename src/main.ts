import './ui/style.css';
import { Game } from './core/Game.js';

/**
 * 入口。
 *
 * 只有一件事要做对：任何一步出错都要让玩家看见原因，
 * 而不是得到一个黑屏。
 */
function fatal(message: string, err?: unknown): void {
  console.error(message, err);
  const el = document.getElementById('fatal');
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.add('hidden');
  if (el) {
    el.textContent = `${message}\n\n${err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err ?? '')}`;
    el.classList.remove('hidden');
  }
}

function main(): void {
  const canvas = document.getElementById('stage');
  if (!(canvas instanceof HTMLCanvasElement)) {
    fatal('找不到渲染画布 #stage。');
    return;
  }

  let game: Game;
  try {
    game = new Game(canvas);
  } catch (err) {
    fatal('初始化失败：显卡或 WebGL 不可用。', err);
    return;
  }

  try {
    game.boot();
  } catch (err) {
    fatal('加载小岛时出错。', err);
    return;
  }

  // 曝光到全局，方便在控制台里调参与截图脚本驱动。
  (window as unknown as { __GAME__?: Game }).__GAME__ = game;

  window.addEventListener('error', (e) => {
    if (!document.getElementById('fatal')?.classList.contains('hidden')) return;
    fatal('运行时错误。', e.error ?? e.message);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
