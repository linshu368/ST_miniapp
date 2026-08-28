/**
 * 聊天页角色语音。
 *
 * 语音是「角色回复」的旁支产物：一条 assistant 消息最多对应一段生效语音，
 * 用户消息、开场白不参与。音色与播放倍速是用户级偏好，对所有角色生效。
 */

/** 音色目录里的一项。id 是上游 voice_id，前端只做展示与回传，不解析。 */
export interface VoiceOption {
  id: string;
  label: string;
  /** 分组名，用于设置页里的小标题，例如「御姐」「温柔」 */
  group: string;
}

/**
 * pending 是「已受理、上游还在跑」。生成要几十秒，接口不同步等结果，
 * 前端据此显示「生成中」，并轮询到 ready 或 failed 为止。
 */
export type MessageVoiceStatus = 'pending' | 'ready' | 'failed';

export interface MessageVoice {
  message_id: string;
  status: MessageVoiceStatus;
  /** 仅 status = ready 时非空 */
  audio_url: string | null;
  duration_ms: number | null;
  /**
   * 实际被念出来的那段文字，仅 status = ready 时非空。
   *
   * 它和消息正文不是一回事：正文含叙述、动作、心理描写，台词只留角色说出口的话，
   * 用户自定义时更是完全由用户决定。摆出来才能解释「为什么听到的和看到的不一样」。
   */
  spoken_text: string | null;
  voice_id: string;
  /** 仅 status = failed 时非空，用于前端决定提示文案 */
  error_code: string | null;
  /**
   * 上一版可播仍在、本次重新生成失败时的失败码。
   *
   * 与 error_code 互斥：status=failed 时本字段恒为 null（没有上一版可播）；
   * status=ready 时若非空，表示当前可播的是上一版、本次重生成已失败，
   * 前端据此在播放条下方展示提示，但播放条仍可播。
   */
  last_error_code: string | null;
  /** 本次生成实扣星尘：成功为计费额度（默认 15），失败/未扣费为 0 */
  credits_charged: number;
  created_at: string;
}

export interface VoiceConfig {
  /** 用户选定的音色；未设置过时后端已回落到目录默认项，前端拿到的一定是有效值 */
  voice_id: string;
  /** 播放倍速，前端 HTMLAudioElement.playbackRate。对已生成的语音即时生效 */
  playback_rate: number;
}

export interface VoiceBillingConfig {
  /** voice_billing_enabled：开关关闭时受理阶段不做 402 预检、后台不扣费，行为与现网一致 */
  enabled: boolean;
  /** 单次成功扣费额（voice_generation_credits），入口旁展示与实扣都用它 */
  credits_per_generation: number;
  /** 入口旁文案（voice_price_label），前端只读不写死 */
  price_label: string;
}

export interface VoiceLimitsConfig {
  /** 送进 TTS 的最终文本上限（voice_max_spoken_chars），自定义输入与写稿成品共用 */
  max_spoken_chars: number;
}

export interface VoiceHintsConfig {
  /** 终检 >300 时底部红字（voice_over_limit_hint） */
  over_limit: string;
  /** 写稿失败/无可朗读内容时底部小字（voice_draft_failed_hint） */
  draft_failed: string;
  /** TTS 失败时底部小字（voice_tts_failed_hint） */
  tts_failed: string;
}

export interface GetVoiceConfigData {
  config: VoiceConfig;
  voices: VoiceOption[];
  /** 可选倍速档位，由后端给出，避免前端写死一份会和校验规则跑偏 */
  playback_rates: number[];
  /** 计费配置：价格、开关、入口旁文案。前端展示价格只读这份，改价不发版 */
  billing: VoiceBillingConfig;
  /** 长度上限：送进 TTS 的最终文本 ≤ max_spoken_chars */
  limits: VoiceLimitsConfig;
  /** 失败提示文案：按 error_code 选用，避免前端写死 */
  hints: VoiceHintsConfig;
}

/** 两个字段都可选：只传 voice_id 是换音色，只传 playback_rate 是调倍速 */
export interface PatchVoiceConfigRequest {
  voice_id?: string;
  playback_rate?: number;
}

export type PatchVoiceConfigData = GetVoiceConfigData;

/** 进入会话时一次取回整段对话已有的语音 */
export interface GetSessionVoiceData {
  audio: MessageVoice[];
}

/**
 * 自定义台词的字数上限。
 *
 * 卡在 300 而不是跟着回复字数上限走：这段文字直接进 TTS，一字一秒地念，
 * 300 字已经是一分钟出头的音频，再长听的人不会等。
 */
export const MAX_CUSTOM_VOICE_CHARS = 300;

/**
 * 送进 TTS 的最终文本上限。自定义输入与写稿成品共用，避免两处数字漂移。
 *
 * 口径与现网自定义上限一致：使用 JavaScript / PostgreSQL 的字符串长度
 *（UTF-16 码元，中文基本一字一长度）。不按 token、不按「去掉标点后的汉字数」。
 */
export const MAX_SPOKEN_VOICE_CHARS = MAX_CUSTOM_VOICE_CHARS;

/**
 * 语音生成在 audio 行上落下的失败码。前端按码决定底部红字还是「可重试」。
 *
 * - `voice_text_too_long`：终检 >300，业务失败，不调 TTS、不扣费，提示用户删减。
 * - `voice_draft_*`：写稿挂了或没有可朗读内容，提示「本次未生成」。
 * - `voice_tts_*`：合成失败，提示可重试，不要用超限那句。
 * - `voice_insufficient_balance`：仅用于前端 402 映射，一般不落 audio 行。
 */
export type VoiceErrorCode =
  | 'voice_text_too_long'
  | 'voice_draft_unusable'
  | 'voice_draft_timeout'
  | `voice_draft_${string}`
  | `voice_tts_${string}`
  | 'voice_insufficient_balance';

/**
 * custom_text 为空 = 走默认链路，由写稿模型从回复正文里挑台词。
 * 非空 = 用户指定念什么，原样送进语音模型，不再写稿。
 */
export interface CreateMessageVoiceRequest {
  custom_text?: string;
}

export interface CreateMessageVoiceData {
  audio: MessageVoice;
}
