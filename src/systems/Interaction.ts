import { Vector3, type Object3D } from 'three';
import type { GameCtx } from '../core/GameTypes.js';

/**
 * 可交互物。独白与"看"是本章叙事的主要载体：
 * 没有过场动画，只有你在一个东西面前按下 E。
 */
export interface Interactable {
  id: string;
  position: Vector3;
  /** 交互半径。 */
  radius: number;
  /** 提示文字，例如"查看""拉开门"。 */
  label: string;
  /** 需要大致朝向该物体的点积阈值，-1 表示不要求。 */
  facing: number;
  enabled: boolean;
  once: boolean;
  used: boolean;
  highlight?: Object3D;
  /** 交互时的一次性位移/旋转动画（例如门开一条缝）。 */
  onInteract(game: GameCtx): void;
  update?(dt: number, game: GameCtx): void;
}

export interface InteractableOpts {
  id: string;
  x: number;
  y: number;
  z: number;
  radius?: number;
  label?: string;
  facing?: number;
  once?: boolean;
  highlight?: Object3D;
  onInteract: (game: GameCtx) => void;
}

export function interactable(o: InteractableOpts): Interactable {
  return {
    id: o.id,
    position: new Vector3(o.x, o.y, o.z),
    radius: o.radius ?? 2.4,
    label: o.label ?? '查看',
    facing: o.facing ?? -0.25,
    enabled: true,
    once: o.once ?? false,
    used: false,
    highlight: o.highlight,
    onInteract: o.onInteract,
  };
}

/** 每帧挑出"最值得按 E"的那一个，并把提示交给 HUD。 */
export class InteractionSystem {
  readonly list: Interactable[] = [];
  current: Interactable | null = null;
  /** 严格模式：只有 enabled 且未被 once 消耗过的才算。 */
  private eye = new Vector3();
  private fwd = new Vector3();

  add(i: Interactable): Interactable {
    this.list.push(i);
    return i;
  }

  addAll(items: Interactable[]): void {
    for (const i of items) this.list.push(i);
  }

  remove(i: Interactable): void {
    const k = this.list.indexOf(i);
    if (k >= 0) this.list.splice(k, 1);
    if (this.current === i) this.current = null;
  }

  clear(): void {
    this.list.length = 0;
    this.current = null;
  }

  update(dt: number, game: GameCtx): void {
    const eye = this.eye.copy(game.player.position);
    eye.y += game.player.eyeHeight;
    game.player.getForward(this.fwd);

    let best: Interactable | null = null;
    let bestScore = -Infinity;

    for (const it of this.list) {
      if (!it.enabled) continue;
      if (it.once && it.used) continue;
      it.update?.(dt, game);
      const dx = it.position.x - eye.x;
      const dy = it.position.y - eye.y;
      const dz = it.position.z - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > it.radius) continue;
      const inv = dist > 1e-5 ? 1 / dist : 0;
      const dot = (dx * this.fwd.x + dy * this.fwd.y + dz * this.fwd.z) * inv;
      if (dot < it.facing) continue;
      // 越正对、越近越好
      const score = dot * 2 - dist / Math.max(0.2, it.radius);
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }

    if (best !== this.current) {
      this.current = best;
      game.ui.setPrompt(best ? best.label : null, best ? 'E' : undefined);
    } else if (best) {
      // 标签可能被脚本改过
      game.ui.setPrompt(best.label, 'E');
    }
  }

  /** 由 Player 在按下 E 时调用。 */
  trigger(game: GameCtx): boolean {
    const it = this.current;
    if (!it || !it.enabled) return false;
    if (it.once && it.used) return false;
    it.used = true;
    it.onInteract(game);
    if (it.once) {
      it.enabled = false;
      this.current = null;
      game.ui.setPrompt(null);
    }
    return true;
  }
}
