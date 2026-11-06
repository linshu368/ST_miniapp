/**
 * 上游派发阶段：请求体组装、首发/兜底竞速或直连、拿到 headers 前的失败与非 2xx 收口。
 */

import {
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  LLM_PROVIDER_CAPABILITIES,
  fallbackProviderPreferences,
  resolveFallbackProviders,
  type OpenRouterProviderPreferences,
} from '@miniapp/shared';
import {
  observeGenerationDispatch,
  observeGenerationPrepare,
} from '../../lib/engineering-observability.js';
import {
  FirstTokenDeadlineError,
  forwardWithFirstTokenFallback,
  type TransportModel,
} from './first-token-fallback.js';
import { toError, type GenerationRun, type SaveHistory } from './generation-run.js';
import { applyPromptCaching, type UpstreamMessage } from './prompt-caching.js';
import type { GenerationRequest, GenerationResult } from './types.js';
import { forwardToUpstream, resolveProviderUpstream, type SseTapResult } from './upstream.js';
import type { UpstreamTiming } from './upstream-timing.js';

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

/**
 * 准入之后报价已经生效：等 headers 时用户手动停止仍是真实的一轮，即使还没有 generation ID。
 * 返回 null 表示不是用户手动停止，由调用方按普通失败释放预留。
 */
export function createAbortedBeforeStreamSettler(
  run: GenerationRun,
  saveHistory: SaveHistory
): () => Promise<GenerationResult | null> {
  return async () => {
    const interrupted: SseTapResult = {
      completed: false,
      content: '',
      deltaCount: 0,
      generationId: null,
      finishReason: 'timeout',
      usage: null,
      responseMetadata: {},
    };
    const outcome = run.hooks?.onBeforeSettle
      ? await run.hooks.onBeforeSettle(interrupted, run.releaseReservation)
      : interrupted;
    if (outcome.finishReason !== 'user_cancelled') return null;
    await run.releaseReservation();
    saveHistory({
      assistant_reply: null,
      status: 'stream_interrupted',
      generation_id: null,
      finish_reason: outcome.finishReason,
    });
    return run.finish(
      run.failed({
        status: 'stream_interrupted',
        chargeId: run.chargeId,
        finishReason: outcome.finishReason,
      })
    );
  };
}

/** 单次上游 POST：按模型解析路由与供应商偏好，并在真正发出前记准备完成与直连派发。 */
function createUpstreamForward(run: GenerationRun) {
  const { request, observation } = run;
  const { routingPreferences, routingModelIds } = run.prepared;
  // 模块内部已把读取 / 解析失败降级为「无规则」，这里拿到 null 就当没配置。
  const preferencesFor = (modelId: string) =>
    routingPreferences[routingModelIds.indexOf(modelId)] ?? null;
  return async (
    model: TransportModel,
    attemptSignal: AbortSignal,
    onDispatch?: () => void,
    attempt?: { role: 'primary' | 'fallback'; timing: UpstreamTiming }
  ): Promise<Response> => {
    const route = resolveProviderUpstream(model.provider, model.providerModelId);
    if (!route.apiKey) throw new Error(`Missing key for ${model.provider}`);
    let preferences =
      model.provider === 'openrouter' ? preferencesFor(model.providerModelId) : null;
    // With the fallback model selected as primary there is no other model to race,
    // so the two attempts differ by provider: primary in order, second reversed.
    const racesSameModel =
      attempt !== undefined &&
      request.model.provider === 'openrouter' &&
      request.model.providerModelId ===
        (request.model.firstTokenPolicy?.fallbackModelId ?? FIRST_TOKEN_FALLBACK_MODEL_ID);
    if (attempt?.role === 'fallback' || racesSameModel) {
      const providers =
        request.model.firstTokenPolicy?.fallbackProviders ??
        resolveFallbackProviders({
          fallback_model_id: model.providerModelId,
        });
      preferences = fallbackProviderPreferences(
        preferences,
        racesSameModel && attempt?.role === 'fallback' && providers
          ? [providers[1], providers[0]]
          : providers
      );
    }
    const actualRequest = {
      ...request,
      model: { ...request.model, ...model, openRouterModelId: model.providerModelId },
    };
    const body = JSON.stringify(buildUpstreamBody(actualRequest, preferences));
    attemptSignal.throwIfAborted();
    onDispatch?.();
    if (!observation.prepared) {
      observation.prepared = true;
      observeGenerationPrepare({
        ...observation,
        durationMs: performance.now() - observation.startedAt,
        outcome: 'ready',
      });
    }
    // 带首字竞争的真实 attempt 由竞争器计数，其余路径只在实际 POST 前计一次。
    if (!onDispatch) {
      observation.directDispatched = true;
      observation.directDispatchedAt = performance.now();
      observeGenerationDispatch({
        provider: model.provider,
        model: model.providerModelId,
        role: 'primary',
        phase: 'generation',
        dispatchOffsetMs: performance.now() - observation.startedAt,
      });
    }
    const response = await forwardToUpstream({
      ...route,
      method: 'POST',
      body,
      signal: attemptSignal,
      timing: attempt?.timing,
    });
    if (!onDispatch) observation.headersMs = performance.now() - observation.directDispatchedAt;
    return response;
  };
}

export type DispatchOutcome =
  | { kind: 'response'; response: Response }
  | { kind: 'finished'; result: GenerationResult };

/**
 * 发出上游请求：带首字策略的流式请求走首发/兜底竞速，其余直连。
 *
 * 拿到 headers 前的失败都在这里收口：被中止且是用户手动停止的按已接受报价结算，
 * 其余释放预留、按上游失败返回；首字截止原样抛出，由会话层补发 start 并记超时。
 */
export async function dispatchUpstream(run: GenerationRun): Promise<DispatchOutcome> {
  const { request, signal, log, hooks, observation } = run;
  const forward = createUpstreamForward(run);
  try {
    if (request.firstToken && request.model.firstTokenPolicy && request.stream) {
      const elapsed = performance.now() - request.firstToken.requestStartedAt;
      const delivered = await forwardWithFirstTokenFallback({
        primary: request.model,
        requestedModelId: request.model.modelId,
        totalBudgetMs: request.model.firstTokenPolicy.deadlineMs,
        thinkingEnabled: request.thinkingEnabled ?? true,
        fallbackModelId: request.model.firstTokenPolicy.fallbackModelId,
        primaryAttemptId: request.firstToken.primaryAttemptId,
        timeoutMs: request.model.firstTokenPolicy.timeoutMs,
        fallbackTimeoutMs: request.model.firstTokenPolicy.fallbackTimeoutMs,
        remainingFirstTokenMs: request.model.firstTokenPolicy.deadlineMs - elapsed,
        remainingObservationMs: 110_000 - elapsed,
        requestStartedAt: request.firstToken.requestStartedAt,
        signal,
        store: request.firstToken.store,
        deferPersistence: request.firstToken.deferPersistence,
        onReady: request.firstToken.onReady,
        forward,
        onObservationError: (err) =>
          log.sys.warn(
            { err, event: 'llm.attempt.observation_failed', historyId: request.historyId },
            '模型调用观测写入失败'
          ),
      });
      run.billing = {
        ...run.prepared.selectedBilling,
        provider: delivered.model.provider,
        providerModelId: delivered.model.providerModelId,
      };
      observation.provider = delivered.model.provider;
      observation.model = delivered.model.providerModelId;
      run.deliveryPersisted = delivered.deliveryPersisted;
      return { kind: 'response', response: delivered.response };
    }
    return { kind: 'response', response: await forward(request.model, signal) };
  } catch (err) {
    if (signal.aborted) {
      // Headers 前的系统取消可被既有业务收口吸收；只保留遥测原因，不改返回/结算。
      observation.signalOutcome =
        signal.reason instanceof FirstTokenDeadlineError || signal.reason?.name === 'TimeoutError'
          ? 'timeout'
          : 'cancelled';
      // 先清空再结算：结算自身抛错时，外层收口不能再结算一次。
      const settleAbort = run.settleAbortedBeforeStream;
      run.settleAbortedBeforeStream = undefined;
      const stopped = settleAbort ? await settleAbort() : null;
      if (stopped) return { kind: 'finished', result: stopped };
    }
    await run.releaseReservation();
    log.sys.error(
      {
        event: 'llm.upstream.error',
        err,
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        provider: run.billing.provider,
        model: run.billing.providerModelId,
      },
      'upstream request failed'
    );
    hooks?.onError?.(toError(err));
    if (err instanceof FirstTokenDeadlineError || signal.reason instanceof FirstTokenDeadlineError)
      throw err instanceof FirstTokenDeadlineError ? err : signal.reason;
    return { kind: 'finished', result: run.finish(run.failed()) };
  }
}

/** 上游非 2xx：不扣费，记录失败。 */
export async function rejectUpstreamResponse(
  run: GenerationRun,
  upstreamRes: Response,
  saveHistory: SaveHistory
): Promise<GenerationResult> {
  const { request, log, billing } = run;
  await run.releaseReservation();
  await upstreamRes.body?.cancel().catch(() => undefined);
  log.sys.error(
    {
      event: 'llm.upstream.rejected',
      userId: request.userId,
      sessionId: request.sessionId ?? null,
      provider: billing.provider,
      model: billing.providerModelId,
      upstreamStatus: upstreamRes.status,
    },
    'upstream rejected generation'
  );
  saveHistory({
    assistant_reply: null,
    status: 'upstream_error',
    upstream_status: upstreamRes.status,
    generation_id: null,
    finish_reason: null,
  });
  // Provider error messages can echo prompt fragments; report status without response text.
  run.hooks?.onError?.(new Error(`upstream ${upstreamRes.status}`));
  return run.finish(run.failed({ upstreamStatus: upstreamRes.status }));
}
