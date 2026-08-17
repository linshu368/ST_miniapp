import type { VoiceOption } from '@miniapp/shared';

/**
 * 音色目录。取自语音管道 v1 的 README 可用音色表，只保留女声——
 * 角色卡目前清一色是女性角色，男声放进选择列表只会增加误选。
 *
 * 放在代码里而不是建表：音色 id 是 MiniMax 侧的常量，换供应商时整张表都要重写，
 * 单独维护一份 DB 记录只会多一个需要同步的地方。要做运营可配时再迁进 runtime_config。
 */
export const VOICE_CATALOG: readonly VoiceOption[] = [
  { id: 'female-yujie', label: '御姐', group: '御姐' },
  { id: 'wumei_yujie', label: '妩媚御姐', group: '御姐' },
  { id: 'Chinese (Mandarin)_Mature_Woman', label: '傲娇御姐', group: '御姐' },

  { id: 'Chinese (Mandarin)_Gentle_Senior', label: '温柔学姐', group: '温柔' },
  { id: 'danya_xuejie', label: '淡雅学姐', group: '温柔' },
  { id: 'female-chengshu', label: '成熟女性', group: '温柔' },

  { id: 'tianxin_xiaoling', label: '甜心小玲', group: '甜美' },
  { id: 'female-tianmei', label: '甜美', group: '甜美' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', label: '甜美女声', group: '甜美' },

  { id: 'female-shaonv', label: '少女', group: '活泼' },
  { id: 'qiaopi_mengmei', label: '俏皮萌妹', group: '活泼' },
  { id: 'diadia_xuemei', label: '嗲嗲学妹', group: '活泼' },
  { id: 'Chinese (Mandarin)_Warm_Girl', label: '温暖少女', group: '活泼' },
  { id: 'Chinese (Mandarin)_Crisp_Girl', label: '清脆少女', group: '活泼' },

  { id: 'Chinese (Mandarin)_Warm_Bestie', label: '温暖闺蜜', group: '其他' },
  { id: 'Chinese (Mandarin)_Wise_Women', label: '阅历姐姐', group: '其他' },
  { id: 'Chinese (Mandarin)_HK_Flight_Attendant', label: '港普空姐', group: '其他' },
  { id: 'Arrogant_Miss', label: '嚣张小姐', group: '其他' },
];

/** 管道 v1 的标准配置就是御姐，用户没选过时沿用它 */
export const DEFAULT_VOICE_ID = 'female-yujie';

/** 合成语速。标准配置 1.15，比常速快一点，贴近耳语节奏 */
export const DEFAULT_TTS_SPEED = 1.15;

export const DEFAULT_TTS_MODEL = 'speech-02-hd';

/**
 * 播放倍速档位。这是前端 playbackRate，对已生成的语音即时生效，
 * 与上面的合成语速是两回事——后者只影响新合成的音频。
 */
export const PLAYBACK_RATES: readonly number[] = [0.75, 1.0, 1.25, 1.5];

export const DEFAULT_PLAYBACK_RATE = 1.0;

export function isKnownVoiceId(voiceId: string): boolean {
  return VOICE_CATALOG.some((voice) => voice.id === voiceId);
}

/** 目录里下线过的音色不该让 UI 出现无选中态，回落到默认项 */
export function resolveVoiceId(stored: string | null | undefined): string {
  return stored && isKnownVoiceId(stored) ? stored : DEFAULT_VOICE_ID;
}

export function isAllowedPlaybackRate(rate: number): boolean {
  return PLAYBACK_RATES.includes(rate);
}

export function resolvePlaybackRate(stored: number | null | undefined): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return DEFAULT_PLAYBACK_RATE;
  return isAllowedPlaybackRate(stored) ? stored : DEFAULT_PLAYBACK_RATE;
}
