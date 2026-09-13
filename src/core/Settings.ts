export interface SettingsData {
  /** 鼠标灵敏度倍率。 */
  sensitivity: number;
  /** 主音量 0..1。 */
  volume: number;
  /** 渲染分辨率尺度，越小越"PS1"。 */
  pixelScale: number;
  invertY: boolean;
  /** 镜头晃动（后坐力/跑步）。 */
  shake: boolean;
  grain: boolean;
  subtitles: boolean;
  /** 电影黑边（章节过场自动开，可强制关）。 */
  letterbox: boolean;
}

export const DEFAULT_SETTINGS: SettingsData = {
  sensitivity: 1,
  volume: 0.75,
  pixelScale: 0.62,
  invertY: false,
  shake: true,
  grain: true,
  subtitles: true,
  letterbox: true,
};

const KEY = 'zcsh.settings.v1';

export class Settings {
  data: SettingsData = { ...DEFAULT_SETTINGS };

  constructor() {
    this.load();
  }

  load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<SettingsData>;
      this.data = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      /* 隐私模式或损坏数据：用默认值即可，不必打扰玩家。 */
    }
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data[key] = value;
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
