// 最小可用的 Chrome DevTools Protocol 客户端。
//
// 没有 Playwright 依赖，也不需要：Node 22+ 自带 WebSocket 与 fetch，
// 用它们直接连 headless Chrome 就够了——而且比 --dump-dom 可靠得多
// （--dump-dom 在 --headless=new 下根本不往 stdout 写东西）。
//
// 能力：导航、在页面里求值、等待条件、截全屏 PNG、读控制台错误。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Page {
  constructor(ws, defaultTimeout = 30000) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
    this.defaultTimeout = defaultTimeout;

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(
          (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '),
        );
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.pageErrors.push(d.exception?.description ?? d.text);
      }
    });
  }

  send(method, params = {}, timeoutMs = this.defaultTimeout) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async init() {
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }

  async goto(url) {
    const done = new Promise((resolve) => {
      const onLoad = (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        } catch {
          return;
        }
        if (msg.method === 'Page.loadEventFired') {
          this.ws.removeEventListener('message', onLoad);
          resolve();
        }
      };
      this.ws.addEventListener('message', onLoad);
      setTimeout(() => {
        this.ws.removeEventListener('message', onLoad);
        resolve();
      }, 25000);
    });
    await this.send('Page.navigate', { url });
    await done;
  }

  /** 在页面里求值，返回值本身（不是 CDP 的包装）。 */
  async eval(expression, timeoutMs) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs ?? this.defaultTimeout },
      (timeoutMs ?? this.defaultTimeout) + 5000,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** 一直等到表达式返回真值，或者超时。 */
  async waitFor(expression, timeoutMs = 30000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression, 4000);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(120);
    }
    throw new Error(`等待超时：${label}\n最后一次结果：${JSON.stringify(last)}`);
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 60000);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** 模拟一次按键：按下 + 抬起。 */
  async tap(key, code, keyCode) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await sleep(30);
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }

  async mouseMove(dx, dy) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 400,
      y: 300,
      deltaX: dx,
      deltaY: dy,
      buttons: 0,
    });
  }
}

export async function launch({
  url = 'about:blank',
  width = 1600,
  height = 900,
  extraArgs = [],
} = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--disable-extensions',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    ...extraArgs,
    url,
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  // 从 stderr 里抠出 DevTools 监听的端口
  let port = 0;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !port) {
    const m = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) port = Number(m[1]);
    else await sleep(100);
  }
  if (!port) {
    proc.kill();
    throw new Error(`Chrome 没有启动 DevTools 端口。\n${stderr.slice(-1200)}`);
  }

  // 找到页面目标
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(150);
  }
  if (!target) {
    proc.kill();
    throw new Error('找不到可调试的页面目标');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });

  const page = new Page(ws, 30000);
  await page.init();
  await page.setViewport(width, height);

  return {
    page,
    port,
    async close() {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      proc.kill();
      await sleep(250);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

export { sleep };
