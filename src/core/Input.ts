export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'run'
  | 'crouch'
  | 'interact'
  | 'fire'
  | 'aim'
  | 'holster'
  | 'reload'
  | 'pause'
  | 'skip';

const KEYMAP: Record<string, Action> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
  KeyC: 'crouch',
  KeyE: 'interact',
  Enter: 'interact',
  KeyF: 'holster',
  KeyR: 'reload',
  Escape: 'pause',
  Space: 'skip',
};

/** 键盘 + 鼠标 + 指针锁。分镜模式下整体旁路。 */
export class Input {
  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  mouseDX = 0;
  mouseDY = 0;
  /** 分镜模式：不采集任何输入。 */
  enabled = true;
  locked = false;
  /** 最近一次按键（用于"按任意键"）。 */
  anyKey = false;

  private disposers: Array<() => void> = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onLockChange?: (locked: boolean) => void,
  ) {
    this.attach();
  }

  private attach(): void {
    const kd = (e: KeyboardEvent): void => {
      // Esc 交给浏览器处理 pointerlock，但我们要能暂停。
      if (e.code === 'Escape') e.preventDefault();
      if (e.repeat) return;
      const a = KEYMAP[e.code];
      if (a) {
        e.preventDefault();
        this.held.add(a);
        this.pressed.add(a);
      }
      this.anyKey = true;
    };
    const ku = (e: KeyboardEvent): void => {
      const a = KEYMAP[e.code];
      if (!a) return;
      this.held.delete(a);
      this.released.add(a);
    };
    const md = (e: MouseEvent): void => {
      if (!this.locked) return;
      if (e.button === 0) {
        this.held.add('fire');
        this.pressed.add('fire');
      }
      if (e.button === 2) {
        this.held.add('aim');
        this.pressed.add('aim');
      }
    };
    const mu = (e: MouseEvent): void => {
      if (e.button === 0) {
        this.held.delete('fire');
        this.released.add('fire');
      }
      if (e.button === 2) {
        this.held.delete('aim');
        this.released.add('aim');
      }
    };
    const mm = (e: MouseEvent): void => {
      if (!this.locked || !this.enabled) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    };
    const ctx = (e: Event): void => e.preventDefault();
    const plc = (): void => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange?.(this.locked);
    };
    const blur = (): void => {
      this.held.clear();
    };

    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('mousedown', md);
    window.addEventListener('mouseup', mu);
    window.addEventListener('mousemove', mm);
    window.addEventListener('blur', blur);
    this.canvas.addEventListener('contextmenu', ctx);
    document.addEventListener('pointerlockchange', plc);

    this.disposers.push(() => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('mousedown', md);
      window.removeEventListener('mouseup', mu);
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('blur', blur);
      this.canvas.removeEventListener('contextmenu', ctx);
      document.removeEventListener('pointerlockchange', plc);
    });
  }

  requestLock(): void {
    if (!this.enabled || this.locked) return;
    // 新版 Chrome 返回 Promise，旧版返回 undefined；不接住会变成未处理拒绝。
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  down(a: Action): boolean {
    return this.enabled && this.held.has(a);
  }

  justPressed(a: Action): boolean {
    return this.enabled && this.pressed.has(a);
  }

  justReleased(a: Action): boolean {
    return this.enabled && this.released.has(a);
  }

  /** 消费掉本帧的边沿事件与鼠标位移。必须在 update 之后调用。 */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.anyKey = false;
  }

  /** 清空一切瞬时状态（切节拍、暂停时用）。 */
  flush(): void {
    this.held.clear();
    this.endFrame();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}
