// 不带眼睛的验证：把页面 DOM 抓回来看。
//
//   node tools/probe.mjs                      默认拍全部节拍的状态
//   node tools/probe.mjs "?shot=reckoning&t=12&debug=1"
//
// 关心三件事：
//   1) #fatal 有没有内容（运行时错误）
//   2) #debug 里的 draw call / 三角形 / 玩家坐标（场景是不是真的建起来了）
//   3) #objective / #subs 的文本（脚本有没有推进）

import { spawn } from 'node:child_process';

const CHROME =
  process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE ?? 'http://localhost:4173';

const QUERIES = process.argv[2]
  ? [process.argv[2]]
  : [
      '?shot=arrival&debug=1',
      '?shot=yard&debug=1',
      '?shot=ritual&t=2&debug=1',
      '?shot=backstage&debug=1',
      '?shot=return&debug=1',
      '?shot=reckoning&t=10&debug=1',
      '?shot=escape&debug=1',
      '?shot=shore&debug=1',
      '?shot=ending&t=3&debug=1',
    ];

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', rej);
    p.on('close', (code) => res({ code, out, err }));
  });
}

function pick(html, id) {
  const re = new RegExp(`<div id="${id}"[^>]*>([\\s\\S]*?)</div>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function hasClass(html, id, cls) {
  const re = new RegExp(`<div id="${id}"[^>]*class="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? m[1].split(/\s+/).includes(cls) : false;
}

for (const q of QUERIES) {
  const url = `${BASE}/${q}${q.includes('mute') ? '' : '&mute=1'}`;
  process.stdout.write(`\n═══ ${q}\n`);
  const { out, err } = await run(CHROME, [
    '--headless=new',
    '--disable-extensions',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--mute-audio',
    '--no-first-run',
    '--user-data-dir=shots/.chrome-profile',
    '--virtual-time-budget=20000',
    '--dump-dom',
    url,
  ]);

  const fatal = pick(out, 'fatal');
  const fatalShown = !hasClass(out, 'fatal', 'hidden');
  const debug = pick(out, 'debug');
  const objective = pick(out, 'objective');
  const subs = pick(out, 'subs');

  if (fatalShown && fatal) {
    console.log('  ✗ 致命错误：');
    console.log(
      fatal
        .split('\n')
        .slice(0, 8)
        .map((l) => '    ' + l)
        .join('\n'),
    );
  } else {
    console.log('  ✓ 无致命错误');
  }
  if (debug) console.log('  debug:\n' + debug.split('\n').map((l) => '    ' + l).join('\n'));
  else console.log('  (没有 debug 输出——?debug=1 没生效或 HUD 被隐藏)');
  if (objective) console.log(`  目标: ${objective.replace(/\s+/g, ' ').slice(0, 80)}`);
  if (subs) console.log(`  字幕: ${subs.replace(/\s+/g, ' ').slice(0, 120)}`);
  const grepErr = err
    .split('\n')
    .filter((l) => /error|Error|ERROR/.test(l) && !/npm warn/.test(l))
    .slice(0, 4);
  if (grepErr.length) console.log('  stderr:\n' + grepErr.map((l) => '    ' + l).join('\n'));
}
