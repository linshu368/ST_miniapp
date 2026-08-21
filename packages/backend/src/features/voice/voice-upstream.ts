/**
 * 语音链路的上游错误约定。
 *
 * 写稿（DeepSeek）与合成（MiniMax）是两个供应商，错误码按 stage 前缀区分——
 * 排查线上失败时第一个要回答的问题就是「哪一段挂了」，混在一起的
 * voice_upstream_* 每次都得回去翻日志才能分辨。
 */

export type VoiceUpstreamStage = 'draft' | 'synthesize';

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

/** stage 前缀，进 error_code */
export function stageCode(stage: VoiceUpstreamStage, suffix: string): string {
  return `voice_${stage === 'draft' ? 'draft' : 'tts'}_${suffix}`;
}

/** fetch 层的失败翻译。区分超时与连不上，前者多半是上游慢，后者是网络或域名 */
export function toTransportError(stage: VoiceUpstreamStage, error: unknown): VoiceUpstreamError {
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  return new VoiceUpstreamError(
    stage,
    stageCode(stage, timedOut ? 'timeout' : 'unreachable'),
    timedOut ? '语音服务响应超时' : '无法连接语音服务'
  );
}
