/**
 * URL 参数。全部为可选，用于调试与分镜截图：
 *   ?debug=1                 叠加运行信息
 *   ?beat=hall-ritual        从指定节拍开始
 *   ?shot=hall-ritual&t=6    分镜模式：冻结在该节拍第 6 秒，不响应输入
 *   ?mute=1                  静音（headless 截图用）
 *   ?intro=0                 跳过开场卡
 *   ?seed=7                  固定程序化随机种子
 *   ?pixel=0.5               强制像素尺度
 */
export interface Params {
  debug: boolean;
  beat: string | null;
  shot: string | null;
  t: number;
  mute: boolean;
  intro: boolean;
  seed: number;
  pixel: number | null;
  /** 时间倍数（1..12）。用于自动化通关测试：把整章压进几十秒。 */
  timeScale: number;
  /** 分镜模式：完全由脚本驱动，忽略键鼠。 */
  readonly scripted: boolean;
}

function flag(v: string | null, fallback: boolean): boolean {
  if (v === null) return fallback;
  if (v === '' || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

export function readParams(search: string = window.location.search): Params {
  const q = new URLSearchParams(search);
  const shot = q.get('shot');
  const tRaw = q.get('t');
  const t = tRaw === null ? 0 : Number.parseFloat(tRaw);
  const pixelRaw = q.get('pixel');
  const tsRaw = Number.parseFloat(q.get('timescale') ?? '1');
  return {
    debug: flag(q.get('debug'), false),
    beat: q.get('beat'),
    shot,
    t: Number.isFinite(t) ? Math.max(0, t) : 0,
    mute: flag(q.get('mute'), false),
    intro: flag(q.get('intro'), true),
    seed: Number.parseInt(q.get('seed') ?? '20231124', 10) || 20231124,
    pixel: pixelRaw === null ? null : Number.parseFloat(pixelRaw),
    timeScale: Number.isFinite(tsRaw) ? Math.min(12, Math.max(1, tsRaw)) : 1,
    scripted: shot !== null,
  };
}

/** 生成当前参数的查询串，用于保持状态跳转（重开 / 切节拍）。 */
export function buildSearch(p: Params, overrides: Partial<Record<string, string>> = {}): string {
  const q = new URLSearchParams();
  if (p.debug) q.set('debug', '1');
  if (!p.intro) q.set('intro', '0');
  if (p.mute) q.set('mute', '1');
  if (p.seed !== 20231124) q.set('seed', String(p.seed));
  if (p.pixel !== null) q.set('pixel', String(p.pixel));
  if (p.beat) q.set('beat', p.beat);
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
