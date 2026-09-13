import type { Group, PerspectiveCamera, Scene } from 'three';
import type { Renderer } from '../render/Renderer.js';
import type { Level } from '../world/Collision.js';
import type { Input } from './Input.js';
import type { Settings } from './Settings.js';
import type { Save, EndingId } from './Save.js';
import type { Params } from './Params.js';
import type { EventBus } from './EventBus.js';
import type { Player } from '../entities/Player.js';
import type { Pistol } from '../entities/Pistol.js';
import type { Cultist, CultistSpawn } from '../entities/Cultist.js';
import type { CameraDirector } from '../camera/CameraDirector.js';
import type { AudioEngine } from '../audio/AudioEngine.js';
import type { Ui, SayOptions } from '../ui/Ui.js';
import type { InteractionSystem, Interactable } from '../systems/Interaction.js';
import type { LightPresetId } from '../render/Palette.js';

/**
 * 游戏上下文。
 *
 * 所有系统、节拍脚本、可交互物都只拿到这一个对象，
 * 于是"谁依赖谁"永远只有一个方向：一切都依赖 Game，Game 不依赖具体节拍。
 * 只用类型导入，运行时没有循环依赖。
 */
export interface GameCtx {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: Renderer;
  readonly level: Level;
  readonly world: Group;
  readonly player: Player;
  readonly pistol: Pistol;
  readonly director: CameraDirector;
  readonly audio: AudioEngine;
  readonly ui: Ui;
  readonly input: Input;
  readonly settings: Settings;
  readonly save: Save;
  readonly params: Params;
  readonly interactions: InteractionSystem;
  readonly bus: EventBus;
  readonly cultists: readonly Cultist[];

  /** 本章开始至今（秒）。 */
  readonly elapsed: number;
  /** 当前节拍已进行的秒数。 */
  readonly beatTime: number;
  /** 当前节拍 id。 */
  readonly beatId: string;
  /** 已"除害"的人数。进入本章是 1（香港仔），第二格留给尊者，第三格留给自己。 */
  readonly cleansed: number;
  /** 本章开过几枪。 */
  readonly shotsFired: number;
  /** 本章倒下了几个信徒。 */
  readonly casualties: number;

  /** 切换节拍。省略 id 则按顺序进入下一个。 */
  goto(id?: string): void;
  /** 立即结束本章。 */
  finish(ending: EndingId): void;
  /** 按本局的选择决定结局。 */
  resolveEnding(): EndingId;
  /** 记一位「三害」已除。 */
  addCleansed(): void;

  addInteractable(i: Interactable): Interactable;
  removeInteractable(i: Interactable): void;
  spawnCultist(opts: CultistSpawn): Cultist;

  /** 交出/收回玩家对镜头与移动的控制权（电影镜头、受刑段落）。 */
  setInputEnabled(on: boolean): void;
  /** 镜头震动。 */
  shake(amount: number, seconds?: number): void;
  /** 挨了一下：震屏 + 闪红 + 冲击偏移 + HUD 脉冲。 */
  hitFx(shake: number, flash: number): void;
  /** 切换光照/雾/调色预设。 */
  setLightPreset(id: LightPresetId): void;

  say(text: string, opts?: SayOptions): void;
  objective(text: string | null): void;

  /** 剧情开关。set 时写入，get 时读取（省略 value）。 */
  flag(name: string, value?: boolean): boolean;
}
