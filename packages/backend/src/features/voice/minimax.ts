import { config } from '../../platform/config.js';
import { stageCode, toTransportError, VoiceUpstreamError } from './voice-upstream.js';

/**
 * MiniMax 上游客户端，只负责 TTS 合成（写稿在 voice-draft.ts，走 DeepSeek）。
 *
 * 要注意 MiniMax 的失败不总是体现在 HTTP 状态码上：额度不足、内容被拦、
 * 参数不合法这些都会返回 HTTP 200，真正的结果藏在 base_resp.status_code 里。
 * 只看 response.ok 会把失败当成功，然后拿着 undefined 往下走。
 */

interface T2AResponse {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: { audio?: string };
  extra_info?: { audio_length?: number };
}

export interface SynthesizeResult {
  audio: Buffer;
  /** 上游给的音频时长（毫秒）。拿不到时为 null，前端退回读 <audio> 元数据 */
  durationMs: number | null;
}

/** 合成 mp3。音频以 hex 字符串回传，不是 base64 */
export async function synthesizeSpeech(input: {
  text: string;
  voiceId: string;
  speed: number;
  model: string;
}): Promise<SynthesizeResult> {
  if (!config.voice.apiKey) {
    throw new VoiceUpstreamError('synthesize', 'voice_not_configured', '语音服务未配置');
  }

  const payload = {
    model: input.model,
    text: input.text,
    stream: false,
    voice_setting: { voice_id: input.voiceId, speed: input.speed, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  };

  let response: Response;
  try {
    response = await fetch(config.voice.ttsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.voice.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.voice.timeoutMs),
    });
  } catch (error) {
    throw toTransportError('synthesize', error);
  }

  let body: T2AResponse;
  try {
    body = (await response.json()) as T2AResponse;
  } catch {
    throw new VoiceUpstreamError(
      'synthesize',
      stageCode('synthesize', 'bad_response'),
      '语音服务返回了无法解析的内容'
    );
  }

  const statusCode = body.base_resp?.status_code;
  if (!response.ok || (statusCode !== undefined && statusCode !== 0)) {
    // status_msg 可能带上游的内部细节，只留给日志，不进用户可见的提示
    throw new VoiceUpstreamError(
      'synthesize',
      stageCode('synthesize', String(statusCode ?? response.status)),
      body.base_resp?.status_msg || `语音服务返回 HTTP ${response.status}`
    );
  }

  const hex = body.data?.audio;
  if (!hex) {
    throw new VoiceUpstreamError(
      'synthesize',
      stageCode('synthesize', 'empty'),
      '语音合成没有返回音频'
    );
  }

  const audio = Buffer.from(hex, 'hex');
  if (!audio.length) {
    throw new VoiceUpstreamError(
      'synthesize',
      stageCode('synthesize', 'empty'),
      '语音合成返回了空音频'
    );
  }

  const durationMs = body.extra_info?.audio_length;
  return {
    audio,
    durationMs: typeof durationMs === 'number' && durationMs > 0 ? Math.round(durationMs) : null,
  };
}
