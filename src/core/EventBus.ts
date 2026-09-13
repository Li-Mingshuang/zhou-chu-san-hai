export type Unsubscribe = () => void;

/** 极简事件总线：系统之间只通过事件名解耦。 */
export class EventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  on<T = unknown>(type: string, fn: (payload: T) => void): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = fn as (p: unknown) => void;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  once<T = unknown>(type: string, fn: (payload: T) => void): Unsubscribe {
    const off = this.on<T>(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<T = unknown>(type: string, payload?: T): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    for (const h of [...set]) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[bus] handler for "${type}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** 全作使用的事件名，集中在此便于检索。 */
export const Ev = {
  BeatEnter: 'beat:enter',
  BeatExit: 'beat:exit',
  Objective: 'ui:objective',
  Subtitle: 'ui:subtitle',
  Prompt: 'ui:prompt',
  ShotFired: 'pistol:fire',
  DryFire: 'pistol:dry',
  Draw: 'pistol:draw',
  Holster: 'pistol:holster',
  AimStart: 'pistol:aim-start',
  AimEnd: 'pistol:aim-end',
  CultistHit: 'cultist:hit',
  CultistDie: 'cultist:die',
  CultistStateChange: 'cultist:state',
  PlayerBump: 'player:bump',
  Shake: 'fx:shake',
  Flag: 'story:flag',
  Ending: 'story:ending',
} as const;
