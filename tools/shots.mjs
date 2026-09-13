// 分镜截图验证。
//
// 用本机 Chrome 的 headless 模式把每一拍的代表机位拍下来，
// 逐张核对构图、光照与取景——而不是"应该没问题"。
//
//   node tools/shots.mjs                 全部节拍
//   node tools/shots.mjs arrival ritual  只拍指定的
//
// 需要一个已经在跑的静态服务器（pnpm preview 或任意静态服务）。

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHROME =
  process.env.CHROME ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';
const OUT = resolve('shots');
const W = Number(process.env.W ?? 1600);
const H = Number(process.env.H ?? 900);
const BUDGET = Number(process.env.BUDGET ?? 22000);

/** [节拍, 秒] —— 秒用于让进场序列跑到指定时刻。 */
const PLAN = [
  ['arrival', 0],
  ['yard', 6],
  ['ritual', 2],
  ['ritual', 30],
  ['backstage', 0],
  ['return', 0],
  ['reckoning', 0],
  ['reckoning', 12],
  ['escape', 0],
  ['shore', 0],
  ['ending', 2],
];

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d.toString();
    });
    p.on('error', rej);
    p.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`${cmd} exited ${code}\n${err.slice(-1500)}`));
    });
  });
}

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`找不到 Chrome：${CHROME}\n用 CHROME=... 指定路径。`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });

  const only = process.argv.slice(2);
  const plan = only.length ? PLAN.filter(([b]) => only.includes(b)) : PLAN;
  if (!plan.length) {
    console.error('没有匹配的节拍。可选：' + [...new Set(PLAN.map(([b]) => b))].join(', '));
    process.exit(1);
  }

  for (const [beat, t] of plan) {
    const name = t ? `${beat}_t${t}` : beat;
    const url = `${BASE}/?shot=${beat}&t=${t}&mute=1&debug=1&seed=20231124`;
    const file = join(OUT, `${name}.png`);
    const args = [
      '--headless=new',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      '--disable-gpu-sandbox',
      '--mute-audio',
      `--window-size=${W},${H}`,
      `--user-data-dir=${join(OUT, '.chrome-profile')}`,
      `--virtual-time-budget=${BUDGET}`,
      `--screenshot=${file}`,
      url,
    ];
    process.stdout.write(`· ${name} ... `);
    try {
      await run(CHROME, args);
      console.log('ok');
    } catch (e) {
      console.log('FAILED');
      console.error(String(e).slice(0, 800));
    }
  }
  console.log(`\n截图目录：${OUT}`);
}

await main();
