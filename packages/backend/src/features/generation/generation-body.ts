import { LLM_PROVIDER_CAPABILITIES, type OpenRouterProviderPreferences } from '@miniapp/shared';
import { applyPromptCaching, type UpstreamMessage } from './prompt-caching.js';
import type { GenerationRequest } from './types.js';

export function buildUpstreamBody(
  request: GenerationRequest,
  providerPreferences: OpenRouterProviderPreferences | null
): Record<string, unknown> {
  const capability = LLM_PROVIDER_CAPABILITIES[request.model.provider];
  const thinkingEnabled = request.thinkingEnabled ?? true;
  const messages: UpstreamMessage[] =
    request.promptCaching && capability.promptCachingMode === 'openrouter_anthropic_cache_control'
      ? applyPromptCaching(request.messages, request.model.openRouterModelId)
      : request.messages.map((message) => ({ role: message.role, content: message.content }));

  return {
    model: request.model.providerModelId,
    messages,
    stream: request.stream,
    // 「模型 × 供应商」路由：屏蔽 -> ignore，优先 -> order + allow_fallbacks（运营在 admin 配置）。
    // 未命中规则的模型不带 provider 字段，交给 OpenRouter 默认路由。
    ...(providerPreferences ? { provider: providerPreferences } : {}),
    // 畅聊免费模型只发给初筛选定的 trusted 供应商（Surplus 的 provider 白名单）。
    ...(request.model.provider === 'surplus' && request.model.freeZone
      ? { provider: request.model.freeZone.providers }
      : {}),
    ...(request.model.provider === 'venice'
      ? {
          venice_parameters: {
            include_venice_system_prompt: false,
            disable_thinking: !thinkingEnabled,
            strip_thinking_response: !thinkingEnabled,
          },
          reasoning: { enabled: thinkingEnabled },
          ...(request.stream ? { stream_options: { include_usage: true } } : {}),
        }
      : request.model.provider === 'openrouter'
        ? { reasoning: { enabled: thinkingEnabled, exclude: !thinkingEnabled } }
        : request.model.provider === 'surplus' && request.stream
          ? { stream_options: { include_usage: true } }
          : {}),
    ...(request.promptCaching &&
    capability.promptCachingMode === 'venice_prompt_cache_key' &&
    request.sessionId
      ? { prompt_cache_key: `session:${request.sessionId}` }
      : {}),
    // v1 恒为空对象（引擎不消费预设、不传采样参数），留着是为了后续接入预设采样参数时不改这里
    ...request.sampling,
  };
}
