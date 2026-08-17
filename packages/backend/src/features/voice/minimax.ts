import { config } from '../../platform/config.js';
import { buildVoicePrompt } from './voice-prompt.js';

/**
 * MiniMax 上游客户端。两个接口共用一把 key 与一套错误约定。
 *
 * 要注意 MiniMax 的失败不总是体现在 HTTP 状态码上：额度不足、内容被拦、
 * 参数不合法这些都会返回 HTTP 200，真正的结果藏在 base_resp.status_code 里。
 * 只看 response.ok 会把失败当成功，然后拿着 undefined 往下走。
 */

export type VoiceUpstreamStage = 'convert' | 'synthesize';

export class VoiceUpstreamError extends Error {
  constructor(
    readonly stage: VoiceUpstreamStage,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'VoiceUpstreamError';
  }
}

interface MiniMaxBaseResp {
  base_resp?: { status_code?: number; status_msg?: string };
}

async function postJson<T extends MiniMaxBaseResp>(
  stage: VoiceUpstreamStage,
  url: string,
  payload: unknown
): Promise<T> {
  if (!config.voice.apiKey) {
    throw new VoiceUpstreamError(stage, 'voice_not_configured', '语音服务未配置');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.voice.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.voice.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new VoiceUpstreamError(
      stage,
      timedOut ? 'voice_upstream_timeout' : 'voice_upstream_unreachable',
      timedOut ? '语音服务响应超时' : '无法连接语音服务'
    );
  }

  let body: T;
  try {
    body = (await response.json()) as T;
  } catch {
    throw new VoiceUpstreamError(
      stage,
      'voice_upstream_bad_response',
      '语音服务返回了无法解析的内容'
    );
  }

  const statusCode = body.base_resp?.status_code;
  if (!response.ok || (statusCode !== undefined && statusCode !== 0)) {
    // status_msg 可能带上游的内部细节，只留给日志，不进用户可见的提示
    throw new VoiceUpstreamError(
      stage,
      `voice_upstream_${statusCode ?? response.status}`,
      body.base_resp?.status_msg || `语音服务返回 HTTP ${response.status}`
    );
  }

  return body;
}

interface ChatCompletionResponse extends MiniMaxBaseResp {
  choices?: { message?: { content?: string } }[];
}

/** 第一步：把角色回复改写成第一人称、带语气标签的语音文本 */
export async function convertToVoiceText(sourceText: string): Promise<string> {
  const body = await postJson<ChatCompletionResponse>('convert', config.voice.llmUrl, {
    model: config.voice.llmModel,
    messages: [{ role: 'user', content: buildVoicePrompt(sourceText) }],
    max_tokens: 2000,
    temperature: 0.8,
  });

  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new VoiceUpstreamError('convert', 'voice_convert_empty', '语音文本改写结果为空');
  }
  return content;
}

export interface SynthesizeResult {
  audio: Buffer;
  /** 上游给的音频时长（毫秒）。拿不到时为 null，前端退回读 <audio> 元数据 */
  durationMs: number | null;
}

interface T2AResponse extends MiniMaxBaseResp {
  data?: { audio?: string };
  extra_info?: { audio_length?: number };
}

/** 第二步：合成 mp3。音频以 hex 字符串回传，不是 base64 */
export async function synthesizeSpeech(input: {
  text: string;
  voiceId: string;
  speed: number;
  model: string;
}): Promise<SynthesizeResult> {
  const body = await postJson<T2AResponse>('synthesize', config.voice.ttsUrl, {
    model: input.model,
    text: input.text,
    stream: false,
    voice_setting: { voice_id: input.voiceId, speed: input.speed, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  });

  const hex = body.data?.audio;
  if (!hex) {
    throw new VoiceUpstreamError('synthesize', 'voice_synthesize_empty', '语音合成没有返回音频');
  }

  const audio = Buffer.from(hex, 'hex');
  if (!audio.length) {
    throw new VoiceUpstreamError('synthesize', 'voice_synthesize_empty', '语音合成返回了空音频');
  }

  const durationMs = body.extra_info?.audio_length;
  return {
    audio,
    durationMs: typeof durationMs === 'number' && durationMs > 0 ? Math.round(durationMs) : null,
  };
}
