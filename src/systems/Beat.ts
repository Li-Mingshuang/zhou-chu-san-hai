import type { GameCtx } from '../core/GameTypes.js';

/**
 * 节拍（Beat）。
 *
 * 整章被切成若干节拍，每个节拍自己决定"什么时候结束"。
 * 这样每一段都可以用 ?beat=<id> 单独跳进去调试与截图，
 * 也让"电影式的段落感"在代码层面是真实存在的。
 */
export interface Beat {
  id: string;
  /** HUD 上不显示，只在调试与分镜模式里用。 */
  title: string;
  /** 进入这一节拍。 */
  enter(game: GameCtx): void;
  /** 每帧。 */
  update?(dt: number, game: GameCtx): void;
  /** 离开这一节拍。 */
  exit?(game: GameCtx): void;
  /**
   * 分镜模式（?shot=）下，把玩家与镜头摆到这一拍的代表性位置。
   * 不实现则退回玩家出生点。
   */
  shot?(game: GameCtx): void;
}

/** 时间轴：把一段剧本写成一串"第几秒做什么"。 */
export class Seq {
  private index = 0;
  private t = 0;
  constructor(
    private readonly steps: Array<{ at: number; fn: (game: GameCtx) => void; label?: string }>,
  ) {}

  reset(): void {
    this.index = 0;
    this.t = 0;
  }

  get time(): number {
    return this.t;
  }

  get done(): boolean {
    return this.index >= this.steps.length;
  }

  update(dt: number, game: GameCtx): void {
    this.t += dt;
    while (this.index < this.steps.length && this.steps[this.index]!.at <= this.t) {
      const step = this.steps[this.index]!;
      this.index++;
      step.fn(game);
    }
  }

  /** 立刻把 t 之前的步骤全部跑掉（分镜模式下跳到第 t 秒）。 */
  fastForward(t: number, game: GameCtx): void {
    this.t = 0;
    this.index = 0;
    while (this.index < this.steps.length && this.steps[this.index]!.at <= t) {
      const step = this.steps[this.index]!;
      this.index++;
      this.t = step.at;
      step.fn(game);
    }
    this.t = t;
  }
}

/** 玩家是否落在某个矩形区域内。 */
export function inRect(
  x: number,
  z: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
): boolean {
  return x >= x0 && x <= x1 && z >= z0 && z <= z1;
}

export class BeatRunner {
  private beats: Beat[] = [];
  index = -1;
  time = 0;
  current: Beat | null = null;
  /** 顺序推进（当前拍的 update 里调用）。 */
  private advanceRequested = false;

  setBeats(beats: Beat[]): void {
    this.beats = beats;
  }

  find(id: string): number {
    return this.beats.findIndex((b) => b.id === id);
  }

  get list(): readonly Beat[] {
    return this.beats;
  }

  start(idOrIndex: string | number | null, game: GameCtx): void {
    let i = 0;
    if (typeof idOrIndex === 'number') i = idOrIndex;
    else if (typeof idOrIndex === 'string') {
      const found = this.find(idOrIndex);
      if (found < 0) {
        console.warn(`[beats] unknown beat "${idOrIndex}", starting from the beginning`);
        i = 0;
      } else i = found;
    }
    if (this.current) this.current.exit?.(game);
    this.index = Math.max(0, Math.min(this.beats.length - 1, i));
    this.time = 0;
    this.current = this.beats[this.index] ?? null;
    this.advanceRequested = false;
    game.bus.emit('beat:enter', { id: this.current?.id });
    this.current?.enter(game);
  }

  requestNext(): void {
    this.advanceRequested = true;
  }

  /** 跳到指定 id 或下一拍。 */
  goto(id: string | undefined, game: GameCtx): void {
    if (id) this.start(id, game);
    else this.start(this.index + 1, game);
  }

  update(dt: number, game: GameCtx): void {
    this.time += dt;
    const beat = this.current;
    if (!beat) return;
    beat.update?.(dt, game);
    if (this.advanceRequested) {
      this.advanceRequested = false;
      if (this.index + 1 < this.beats.length) this.start(this.index + 1, game);
    }
  }
}
