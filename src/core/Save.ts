export type EndingId = 'counted' | 'refused' | 'silent';

export interface SaveData {
  /** 最近一次进入的节拍，用于"继续"。 */
  beat: string | null;
  /** 已解锁的结局。 */
  endings: EndingId[];
  /** 本章累计开枪数。 */
  shotsFired: number;
  /** 本章放过的人数。 */
  spared: number;
}

const KEY = 'zcsh.save.v1';

export class Save {
  data: SaveData = { beat: null, endings: [], shotsFired: 0, spared: 0 };

  constructor() {
    this.load();
  }

  load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      this.data = { ...this.data, ...(JSON.parse(raw) as Partial<SaveData>) };
    } catch {
      /* 忽略 */
    }
  }

  setBeat(beat: string): void {
    this.data.beat = beat;
    this.persist();
  }

  recordEnding(id: EndingId): void {
    if (!this.data.endings.includes(id)) this.data.endings.push(id);
    this.persist();
  }

  addShot(n = 1): void {
    this.data.shotsFired += n;
    this.persist();
  }

  addSpared(n = 1): void {
    this.data.spared += n;
    this.persist();
  }

  reset(): void {
    this.data = { beat: null, endings: [], shotsFired: 0, spared: 0 };
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* 忽略 */
    }
  }
}
