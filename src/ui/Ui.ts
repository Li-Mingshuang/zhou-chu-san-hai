import type { Settings } from '../core/Settings.js';

/**
 * DOM 覆盖层控制器：HUD、字幕、菜单、设置面板。
 *
 * 画面本体由 three.js 画在 #stage 上，这里只驱动 index.html / style.css 已经定义的节点，
 * 不改动那两个文件。所有查询都容错：节点缺失时静默降级（必要时按需补建结构），
 * 绝不让 UI 层的意外拖垮游戏循环。
 */

export interface UiCallbacks {
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onAgain(): void;
}

export interface SayOptions {
  /** 说话人；省略则为旁白。 */
  who?: string;
  /** 是否为内心独白/旁白（斜体、居中、无引号）。 */
  narr?: boolean;
  /** 停留秒数，默认按字数估算（约 0.22s/字，最少 1.6s）。 */
  dur?: number;
}

/** 一行正在显示的字幕。 */
interface SubLine {
  el: HTMLElement;
  /** 剩余停留秒数。 */
  ttl: number;
}

/** 同屏最多保留的字幕行数，超出时最旧的一行淡出移除。 */
const SUB_MAX = 3;
/** 字幕淡出时长；style.css 只有入场动画，淡出用内联过渡补。 */
const SUB_FADE_MS = 220;
/** 与 style.css 的 objIn 动画时长一致。 */
const OBJ_ANIM_MS = 700;
/** 与 style.css 的 hurtPulse 动画时长一致，留一点余量再摘类。 */
const HURT_MS = 460;
/** 字幕节奏：约 0.22s/字，最少 1.6s。 */
const SUB_PER_CHAR = 0.22;
const SUB_MIN_SEC = 1.6;
/** 弹药刻度上限，避免异常入参造出成百上千个节点。 */
const AMMO_MAX_TICKS = 24;
/** 瞄准准星的部件顺序，与 index.html 保持一致（节点缺失时补建用）。 */
const CROSSHAIR_PARTS = ['ch-dot', 'ch-l', 'ch-r', 'ch-t', 'ch-b'] as const;

/** range 控件 id → Settings 键。 */
const RANGE_KEYS = [
  ['opt-sens', 'sensitivity'],
  ['opt-vol', 'volume'],
  ['opt-pix', 'pixelScale'],
] as const;

/** checkbox 控件 id → Settings 键。 */
const CHECK_KEYS = [
  ['opt-inv', 'invertY'],
  ['opt-shake', 'shake'],
  ['opt-grain', 'grain'],
] as const;

export class Ui {
  private readonly cb: UiCallbacks;

  // ── 覆盖层与菜单 ──
  private readonly app: HTMLElement | null;
  private readonly overlay: HTMLElement | null;
  private readonly titleCard: HTMLElement | null;
  private readonly pauseCard: HTMLElement | null;
  private readonly endingCard: HTMLElement | null;
  private readonly endingTitle: HTMLElement | null;
  private readonly endingBody: HTMLElement | null;
  private readonly endingCount: HTMLElement | null;
  private readonly lockHint: HTMLElement | null;
  private readonly fatalEl: HTMLElement | null;

  // ── HUD ──
  private readonly hud: HTMLElement | null;
  private readonly letterbox: HTMLElement | null;
  private readonly crosshair: HTMLElement | null;
  private readonly promptEl: HTMLElement | null;
  private readonly objective: HTMLElement | null;
  private readonly ammo: HTMLElement | null;
  private readonly vitae: HTMLElement | null;
  private readonly cleansedHost: HTMLElement | null;
  private readonly debugEl: HTMLElement | null;

  // ── 字幕与按钮 ──
  private readonly subs: HTMLElement | null;
  private readonly btnStart: HTMLButtonElement | null;
  private readonly btnResume: HTMLButtonElement | null;
  private readonly btnRestart: HTMLButtonElement | null;
  private readonly btnAgain: HTMLButtonElement | null;

  /** #objective 的正文节点，首次设置目标时补建。 */
  private objectiveText: HTMLElement | null = null;
  /** #cleansed 里的 <b> 计数节点。 */
  private cleansedNum: HTMLElement | null = null;

  /** 正在显示的字幕行，从旧到新。 */
  private readonly lines: SubLine[] = [];
  /** 所有挂出的定时器，dispose 时统一清掉。 */
  private readonly timers = new Set<number>();
  /** 所有监听器的摘除函数。 */
  private readonly disposers: Array<() => void> = [];
  /** 本类补建的节点，dispose 时一并移除。 */
  private readonly created: HTMLElement[] = [];

  private objTimer: number | null = null;
  private hurtTimer: number | null = null;
  private buttonsBound = false;
  private settingsBound = false;
  private dead = false;

  constructor(callbacks: UiCallbacks) {
    this.cb = callbacks;

    this.app = document.getElementById('app');
    this.overlay = this.node('overlay');
    this.titleCard = this.node('title-card');
    this.pauseCard = this.node('pause-card');
    this.endingCard = this.node('ending-card');
    this.endingTitle = this.node('ending-title');
    this.endingBody = this.node('ending-body');
    this.endingCount = this.node('ending-count');
    this.lockHint = this.node('lock-hint');
    // 关键节点缺失时补建，保证被裁剪的测试页也能跑通 UI 流程。
    this.fatalEl = this.ensure('fatal', this.app);

    this.hud = this.ensure('hud', this.app);
    this.letterbox = this.ensure('letterbox', this.app);
    this.crosshair = this.ensure('crosshair', this.hud);
    this.promptEl = this.ensure('prompt', this.hud);
    this.objective = this.ensure('objective', this.hud);
    this.ammo = this.ensure('ammo', this.hud);
    this.vitae = this.ensure('vitae', this.hud);
    this.cleansedHost = this.node('cleansed');
    this.cleansedNum = this.cleansedHost?.querySelector('b') ?? null;
    this.debugEl = this.ensure('debug', this.hud);

    this.subs = this.ensure('subs', this.app);

    this.btnStart = this.node<HTMLButtonElement>('btn-start');
    this.btnResume = this.node<HTMLButtonElement>('btn-resume');
    this.btnRestart = this.node<HTMLButtonElement>('btn-restart');
    this.btnAgain = this.node<HTMLButtonElement>('btn-again');

    this.bindButtons();
  }

  // ── 基础工具 ──────────────────────────────────────────────────

  private node<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  /** 查询 id；缺失时在 host 下补一个同名节点，并登记以便 dispose 清理。 */
  private ensure<T extends HTMLElement>(id: string, host: HTMLElement | null, tag = 'div'): T | null {
    const found = document.getElementById(id);
    if (found) return found as T;
    const parent = host ?? this.app ?? document.body;
    if (!parent) return null;
    const made = document.createElement(tag);
    made.id = id;
    parent.appendChild(made);
    this.created.push(made);
    return made as T;
  }

  /** 注册监听器并登记摘除函数。 */
  private listen(target: EventTarget | null, type: string, handler: EventListener): void {
    if (!target) return;
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }

  /** 延后执行；dispose 之后不再排期，返回定时器 id。 */
  private later(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.dead) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private clearTimer(id: number | null): void {
    if (id === null) return;
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  // ── 每帧 ─────────────────────────────────────────────────────

  /** 每帧推进字幕队列。 */
  update(dt: number): void {
    if (this.dead || this.lines.length === 0 || !(dt > 0)) return;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];
      line.ttl -= dt;
      if (line.ttl <= 0) {
        this.lines.splice(i, 1);
        this.retire(line.el, true);
      }
    }
  }

  // ── 覆盖层 ───────────────────────────────────────────────────

  /** 显示开场标题卡（index.html 里的 #title-card）。 */
  showTitle(): void {
    this.showOnly(this.titleCard);
  }

  /** 隐藏整个 #overlay（带淡出）。 */
  hideOverlay(): void {
    const box = this.overlay;
    if (!box) return;
    // .hidden 由 CSS 提供 700ms 淡出，并顺带关掉指针事件。
    box.classList.add('hidden');
    box.classList.remove('clear');
  }

  /** 把 #overlay 变成完全透明且不拦截指针（游戏进行中用）。 */
  clearOverlay(): void {
    const box = this.overlay;
    if (!box) return;
    box.classList.remove('hidden');
    box.classList.add('clear');
    // .clear 只关掉容器自身的命中测试，卡片自带 pointer-events:auto，
    // 不一起藏起来的话仍会截走鼠标（尤其是右键仪式瞄准）。
    this.hideCards(null);
  }

  showPause(): void {
    this.showOnly(this.pauseCard);
  }

  /** 收起暂停卡；只藏卡片会留下一个不透明的空罩子，所以顺带淡出覆盖层。 */
  hidePause(): void {
    const card = this.pauseCard;
    if (!card || !this.cardVisible(card)) return;
    this.setCardVisible(card, false);
    this.hideOverlay();
  }

  showLockHint(on: boolean): void {
    const hint = this.lockHint;
    if (!hint) return;
    hint.classList.toggle('hidden', !on);
    // 提示挂在 #overlay 内部：若覆盖层处于 hidden（开局已被收起），
    // 提示会被父级透明度吞掉，这里只在那种情况下把它换成透明覆盖层。
    if (on && this.overlay && this.overlay.classList.contains('hidden')) {
      this.overlay.classList.remove('hidden');
      this.overlay.classList.add('clear');
    }
  }

  /** 结局卡。count 形如 "已除 2 / 3"；body 支持 \n 换行。 */
  showEnding(title: string, body: string, count: string): void {
    if (this.endingTitle) this.endingTitle.textContent = title;
    if (this.endingBody) this.setMultiline(this.endingBody, body);
    if (this.endingCount) this.endingCount.textContent = count;
    this.showOnly(this.endingCard);
  }

  get overlayVisible(): boolean {
    const box = this.overlay;
    // 透明罩（.clear）不算"可见"：那种状态下画面交还给游戏，输入应当放行。
    return box !== null && !box.classList.contains('hidden') && !box.classList.contains('clear');
  }

  /** 三张卡互斥：只显示指定的一张，并确保覆盖层重新变得可见且不透明。 */
  private showOnly(card: HTMLElement | null): void {
    this.hideCards(card);
    const box = this.overlay;
    if (!box) return;
    box.classList.remove('hidden', 'clear');
  }

  private hideCards(keep: HTMLElement | null): void {
    const cards: Array<HTMLElement | null> = [this.titleCard, this.pauseCard, this.endingCard];
    for (const card of cards) {
      if (card) this.setCardVisible(card, card === keep);
    }
  }

  /**
   * 卡片的显隐：既挂 .hidden 类，也直接写内联 display。
   *
   * 只挂类是不够的——样式表里漏掉一条 `.hidden` 规则时，元素照样占着版面，
   * 而 #overlay 已经透明，结果就是"标题浮在游戏画面上不消失"。
   * 这类失败模式在自动截图里看不出来，只有真点了开始按钮才会遇到。
   */
  private setCardVisible(card: HTMLElement, on: boolean): void {
    card.classList.toggle('hidden', !on);
    card.style.display = on ? '' : 'none';
    card.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /** 某张卡现在是不是真的看得见。 */
  private cardVisible(card: HTMLElement): boolean {
    return card.style.display !== 'none' && !card.classList.contains('hidden');
  }

  /** #ending-body 是普通 <p>，\n 不换行，拆成文本节点 + <br>（不动 style.css）。 */
  private setMultiline(host: HTMLElement, text: string): void {
    host.replaceChildren();
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) host.appendChild(document.createElement('br'));
      host.appendChild(document.createTextNode(parts[i]));
    }
  }

  // ── HUD ─────────────────────────────────────────────────────

  setHudVisible(on: boolean): void {
    const hud = this.hud;
    if (!hud) return;
    hud.classList.toggle('hidden', !on);
    hud.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /** 电影黑边（#letterbox 加/去 .on）。 */
  setLetterbox(on: boolean): void {
    const box = this.letterbox ?? this.ensure('letterbox', this.app);
    if (!box) return;
    // 被裁剪的页面里补两根黑边条，否则 .on 无从下手。
    if (box.childElementCount === 0) {
      const top = document.createElement('div');
      top.className = 'bar top';
      const bottom = document.createElement('div');
      bottom.className = 'bar bottom';
      top.setAttribute('aria-hidden', 'true');
      bottom.setAttribute('aria-hidden', 'true');
      box.append(top, bottom);
      this.created.push(top, bottom);
    }
    box.classList.toggle('on', on);
  }

  setCrosshair(on: boolean, aiming: boolean): void {
    const ch = this.crosshair;
    if (!ch) return;
    if (ch.childElementCount === 0) {
      for (const cls of CROSSHAIR_PARTS) {
        const part = document.createElement('span');
        part.className = cls;
        ch.appendChild(part);
        this.created.push(part);
      }
    }
    ch.classList.toggle('on', on);
    // .aim 换色（灯笼黄），只有准星本身在显示时才有意义。
    ch.classList.toggle('aim', on && aiming);
  }

  /** 交互提示，例如 setPrompt('查看', 'E') 渲染为 "E 查看"；null 隐藏。 */
  setPrompt(text: string | null, key?: string): void {
    const box = this.promptEl;
    if (!box) return;
    if (text === null || text === '') {
      box.classList.remove('on');
      box.replaceChildren();
      return;
    }
    box.replaceChildren();
    if (key) {
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      // 键帽与文字之间由 style.css 的 `#prompt kbd { margin-right }` 留白，不再塞空格。
      box.appendChild(kbd);
    }
    box.appendChild(document.createTextNode(text));
    box.classList.add('on');
  }

  setObjective(text: string | null): void {
    const box = this.objective;
    if (!box) return;
    if (text === null || text === '') {
      box.style.opacity = '0';
      if (this.objectiveText) this.objectiveText.textContent = '';
      return;
    }
    const target = this.ensureObjectiveText();
    box.style.opacity = '1';
    if (!target) {
      box.textContent = text;
      return;
    }
    const changed = target.textContent !== text;
    target.textContent = text;
    if (changed) this.pulseObjective(target);
  }

  /**
   * index.html 的 #objective 是空的，而 style.css 按 `.obj-title` / `.obj-new`
   * 的子元素来排版与动效，所以正文节点在这里补建（页面自带结构则直接复用）。
   */
  private ensureObjectiveText(): HTMLElement | null {
    const box = this.objective;
    if (!box) return null;
    if (this.objectiveText && this.objectiveText.isConnected) return this.objectiveText;
    const existing = box.querySelector<HTMLElement>('.obj-text');
    if (existing) {
      this.objectiveText = existing;
      return existing;
    }
    if (box.childElementCount > 0 && box.lastElementChild instanceof HTMLElement) {
      // 页面已有自定义结构：拿最后一个元素当正文，不去破坏它。
      this.objectiveText = box.lastElementChild;
      return this.objectiveText;
    }
    const title = document.createElement('span');
    title.className = 'obj-title';
    title.textContent = '目标';
    const text = document.createElement('span');
    text.className = 'obj-text';
    box.replaceChildren(title, document.createTextNode(' '), text);
    this.objectiveText = text;
    return text;
  }

  /** 新目标出现时补一次入场动画（objIn 700ms）。 */
  private pulseObjective(el: HTMLElement): void {
    el.classList.remove('obj-new');
    void el.offsetWidth; // 强制重排，让同一个类名能再次触发动画
    el.classList.add('obj-new');
    this.clearTimer(this.objTimer);
    this.objTimer = this.later(() => {
      this.objTimer = null;
      el.classList.remove('obj-new');
    }, OBJ_ANIM_MS);
  }

  /** loaded/total 是弹药；drawn 为是否已拔枪。 */
  setAmmo(loaded: number, total: number, drawn: boolean): void {
    const box = this.ammo;
    if (!box) return;
    // 未拔枪时整块隐藏：用内联 opacity，保留 CSS 的淡入淡出过渡。
    box.style.opacity = drawn ? '1' : '0';
    if (!drawn) return;

    const live = Math.max(0, Math.round(loaded));
    // 弹位总数取 max(loaded, total)：total 既可能是弹匣容量也可能是随身余弹，
    // 这样两种叫法都能画出合理的刻度。
    const slots = Math.min(AMMO_MAX_TICKS, Math.max(live, Math.round(total)));
    while (box.childElementCount > slots) box.lastElementChild?.remove();
    while (box.childElementCount < slots) {
      const rd = document.createElement('span');
      rd.className = 'rd';
      box.appendChild(rd);
    }
    const kids = box.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i]?.classList.toggle('live', i < live);
    }
  }

  /** 清算计数，n 为已清除人数（0..3）。 */
  setCleansed(n: number, visible: boolean): void {
    const count = Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 0;
    const num = this.cleansedNum ?? this.ensureCleansedNum();
    if (num) num.textContent = String(count);
    this.vitae?.classList.toggle('on', visible);
  }

  /** #cleansed 里的 <b> 缺失时按 index.html 的文案补一份。 */
  private ensureCleansedNum(): HTMLElement | null {
    const host = this.cleansedHost ?? this.node('cleansed');
    if (!host) return null;
    const b = document.createElement('b');
    b.textContent = '0';
    host.replaceChildren(document.createTextNode('已除 '), b, document.createTextNode(' / 3'));
    this.cleansedNum = b;
    return b;
  }

  /** 进入/退出"仪式瞄准"：切换 #app 的 .aiming 类。 */
  setAiming(on: boolean): void {
    this.app?.classList.toggle('aiming', on);
  }

  /** 电影化模式：#app 加 .cinematic 隐藏 HUD。 */
  setCinematic(on: boolean): void {
    this.app?.classList.toggle('cinematic', on);
  }

  /** 被击中：给 #app 加 .hurt 类并在动画结束后移除。 */
  flashHurt(): void {
    const app = this.app;
    if (!app) return;
    app.classList.remove('hurt');
    void app.offsetWidth; // 连中两枪时能再触发一次 hurtPulse
    app.classList.add('hurt');
    this.clearTimer(this.hurtTimer);
    this.hurtTimer = this.later(() => {
      this.hurtTimer = null;
      app.classList.remove('hurt');
    }, HURT_MS);
  }

  setDebug(text: string): void {
    if (this.debugEl) this.debugEl.textContent = text;
  }

  /** 致命错误覆盖层（#fatal），显示文本并解除 hidden。 */
  fatal(message: string): void {
    const box = this.fatalEl ?? this.ensure('fatal', this.app);
    if (!box) return;
    this.clearSubtitles();
    box.textContent = message;
    box.classList.remove('hidden');
  }

  // ── 字幕 ─────────────────────────────────────────────────────

  /** 追加一行字幕到队列。 */
  say(text: string, opts: SayOptions = {}): void {
    const host = this.subs;
    if (this.dead || !host || text.trim() === '') return;

    const line = document.createElement('div');
    if (opts.narr) line.className = 'line narr';
    else if (opts.who) line.className = 'line who';
    else line.className = 'line';
    if (!opts.narr && opts.who) line.dataset.who = opts.who;
    line.textContent = text;
    host.appendChild(line);

    const dur =
      opts.dur !== undefined && opts.dur > 0
        ? opts.dur
        : Math.max(SUB_MIN_SEC, text.length * SUB_PER_CHAR);
    this.lines.push({ el: line, ttl: dur });

    // 只保留最近 SUB_MAX 行同屏，更早的一行淡出。逐行独立倒计时，
    // #subs 本身是绝对定位的，空着不占版面，所以不需要占位节点。
    while (this.lines.length > SUB_MAX) {
      const oldest = this.lines.shift();
      if (oldest) this.retire(oldest.el, true);
    }
  }

  /** 立即清空队列与显示。 */
  clearSubtitles(): void {
    this.lines.length = 0;
    this.subs?.replaceChildren();
  }

  get subtitleBusy(): boolean {
    return this.lines.length > 0;
  }

  /** 移除一行字幕；fade 为真时先做一次内联淡出。 */
  private retire(el: HTMLElement, fade: boolean): void {
    if (!fade) {
      el.remove();
      return;
    }
    el.style.transition = `opacity ${SUB_FADE_MS}ms ease`;
    el.style.opacity = '0';
    this.later(() => el.remove(), SUB_FADE_MS);
  }

  // ── 设置面板 ─────────────────────────────────────────────────

  /** 把 index.html 里 #pause-card 的控件绑定到 Settings，变更时回调 onChange。 */
  bindSettings(settings: Settings, onChange: () => void): void {
    if (this.settingsBound) return; // 重复调用不应挂上第二份监听器
    this.settingsBound = true;

    for (const [id, key] of RANGE_KEYS) {
      const input = this.node<HTMLInputElement>(id);
      this.listen(input, 'input', () => {
        if (!input) return;
        const v = Number.parseFloat(input.value);
        settings.set(key, Number.isFinite(v) ? v : settings.data[key]);
        onChange();
      });
    }

    for (const [id, key] of CHECK_KEYS) {
      const input = this.node<HTMLInputElement>(id);
      this.listen(input, 'change', () => {
        if (!input) return;
        settings.set(key, input.checked);
        onChange();
      });
    }
  }

  /** 暂停面板控件与 Settings 同步（打开暂停时调用）。 */
  syncSettingsInputs(settings: Settings): void {
    for (const [id, key] of RANGE_KEYS) {
      const input = this.node<HTMLInputElement>(id);
      if (input) input.value = String(settings.data[key]);
    }
    for (const [id, key] of CHECK_KEYS) {
      const input = this.node<HTMLInputElement>(id);
      if (input) input.checked = settings.data[key];
    }
  }

  // ── 事件绑定 ─────────────────────────────────────────────────

  /** 绑定按钮点击（构造时已自动调用一次；重复调用不会重复绑定）。 */
  bindButtons(): void {
    if (this.buttonsBound) return;
    this.buttonsBound = true;
    // 包一层箭头函数：回调若是某个对象的方法，this 仍指向它自己。
    this.listen(this.btnStart, 'click', () => this.cb.onStart());
    this.listen(this.btnResume, 'click', () => this.cb.onResume());
    this.listen(this.btnRestart, 'click', () => this.cb.onRestart());
    this.listen(this.btnAgain, 'click', () => this.cb.onAgain());
  }

  dispose(): void {
    this.dead = true;

    for (const off of this.disposers) off();
    this.disposers.length = 0;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.objTimer = null;
    this.hurtTimer = null;

    this.clearSubtitles();

    // 复位留在共享节点上的状态（HMR 重新执行 main.ts 时尤其重要）。
    this.app?.classList.remove('hurt', 'aiming', 'cinematic');
    this.objectiveText?.classList.remove('obj-new');
    this.debugEl?.replaceChildren();
    this.ammo?.replaceChildren();
    this.promptEl?.replaceChildren();
    this.promptEl?.classList.remove('on');
    this.objective?.style.removeProperty('opacity');

    for (const node of this.created) node.remove();
    this.created.length = 0;
    this.objectiveText = null;
    this.cleansedNum = null;
  }
}
