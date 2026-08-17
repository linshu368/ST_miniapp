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
  voice_id: string;
  /** 仅 status = failed 时非空，用于前端决定提示文案 */
  error_code: string | null;
  created_at: string;
}

export interface VoiceConfig {
  /** 用户选定的音色；未设置过时后端已回落到目录默认项，前端拿到的一定是有效值 */
  voice_id: string;
  /** 播放倍速，前端 HTMLAudioElement.playbackRate。对已生成的语音即时生效 */
  playback_rate: number;
}

export interface GetVoiceConfigData {
  config: VoiceConfig;
  voices: VoiceOption[];
  /** 可选倍速档位，由后端给出，避免前端写死一份会和校验规则跑偏 */
  playback_rates: number[];
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

export interface CreateMessageVoiceData {
  audio: MessageVoice;
}
