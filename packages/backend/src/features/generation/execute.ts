/**
 * backend / features / generation / execute.ts
 *
 * 唯一的生成与计费出口（架构铁律 6）。把本模块的四段能力串成 GenerationService：
 *   免费额度预留 → 定档扣费额与余额预检 → 上游转发与 SSE tap → 终态结算（settle.ts）。
 *
 * 任何要调聊天 LLM 的路径都必须进这里。别处另起「转发 + 扣费 + 落库」会让计费口径漂移，
 * 因为 charge_id 幂等语义、finish_reason 计费闸门、免费额度两阶段都只实现在这一条链上。
 *
 * 客户端断开不终止上游：本函数自行 drain 到 [DONE] 再落库，用户切后台回来仍能看到完整回复。
 *
 * 免费额度预留失败、钱包查询失败会原样抛出，调用方按 500 处理。
 * 上游侧的失败（连不上 / 非 2xx / 流中断）不抛出，统一从 GenerationResult.status 收口。
 */

import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  getModelBillingContext,
  getPricingConfig,
  type ModelBillingContext,
} from '../../platform/model-tiers.js';
import { getProviderPreferencesForModels } from '../../platform/provider-routing.js';
import { readVipStrategy } from '../../platform/vip-strategy.js';
import {
  LLM_PROVIDER_CAPABILITIES,
  MAX_CONVERSATION_REASONING_LENGTH,
  type OpenRouterProviderPreferences,
} from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import { settleGeneration, type GenerationSettlementEntry } from './settle.js';
import { reserveCharacterFreeQuota, type FreeQuotaReservation } from './quota.js';
import { checkWalletBalance, resolveBillingPlan, type BillingPlan } from './precheck.js';
import {
  createSseTap,
  forwardToUpstream,
  resolveProviderUpstream,
  createLeadingThinkingSplitter,
  readExposedReasoning,
  type SseTapResult,
} from './upstream.js';
import { applyPromptCaching, type UpstreamMessage } from './prompt-caching.js';
import {
  FirstTokenDeadlineError,
  forwardWithFirstTokenFallback,
  type TransportModel,
} from './first-token-fallback.js';
import { GenerationCleanupPendingError } from './types.js';
import {
  observeGenerationDispatch,
  observeGenerationAttempt,
  observeGenerationPrepare,
  observeGenerationTerminal,
  type GenerationOutcome,
} from '../../lib/engineering-observability.js';
import type {
  GenerationHooks,
  GenerationLogger,
  GenerationRequest,
  GenerationResult,
  GenerationService,
} from './types.js';

/** 一次生成里只有这五个字段随终态变化，其余结算入参全程固定。 */
type HistoryOutcome = Pick<
  GenerationSettlementEntry,
  | 'assistant_reply'
  | 'status'
  | 'upstream_status'
  | 'generation_id'
  | 'finish_reason'
  | 'provider_response'
>;

type SaveHistory = (outcome: HistoryOutcome) => void;

/** 与会话 streaming 陈旧回收口径一致，避免一轮生成无限占住会话。 */
export const GENERATION_TIMEOUT_MS = 120_000;

/** Only generation completion; actual delivery/billing eligibility is decided separately. */
function hasCompletedReply(result: Pick<SseTapResult, 'completed' | 'content'>) {
  return result.completed && result.content.trim().length > 0;
}

/** 只有 OpenRouter 明确确认自然结束后才能最终扣费。 */
function isBillableReply(result: Pick<SseTapResult, 'completed' | 'content' | 'finishReason'>) {
  return hasCompletedReply(result) && result.finishReason === 'stop';
}

function buildUpstreamBody(
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
      : { reasoning: { enabled: thinkingEnabled, exclude: !thinkingEnabled } }),
    ...(request.promptCaching &&
    capability.promptCachingMode === 'venice_prompt_cache_key' &&
    request.sessionId
      ? { prompt_cache_key: `session:${request.sessionId}` }
      : {}),
    // v1 恒为空对象（引擎不消费预设、不传采样参数），留着是为了后续接入预设采样参数时不改这里
    ...request.sampling,
  };
}

export async function execute(
  request: GenerationRequest,
  hooks?: GenerationHooks,
  log: GenerationLogger = createLogger('generation')
): Promise<GenerationResult> {
  const observation = {
    startedAt: performance.now(),
    prepared: false,
    directDispatched: false,
    directDispatchedAt: 0,
    headersMs: undefined as number | undefined,
    firstTokenMs: undefined as number | undefined,
    signalOutcome: undefined as 'timeout' | 'cancelled' | undefined,
    provider: request.model.provider,
    model: request.model.providerModelId,
  };
  let outcome: GenerationOutcome = 'error';
  try {
    const result = await executeGeneration(request, hooks, log, observation);
    const reason = result.finishReason;
    outcome =
      reason === 'user_cancelled'
        ? 'user_cancelled'
        : observation.signalOutcome === 'timeout'
          ? 'timeout'
          : result.denial === 'vip_required'
            ? 'vip_required'
            : reason === 'content_filter' || reason === 'refusal'
              ? 'filtered'
              : reason === 'length'
                ? 'length'
                : reason === 'timeout' || reason === 'first_token_timeout'
                  ? 'timeout'
                  : reason === 'cancelled'
                    ? 'cancelled'
                    : (observation.signalOutcome ?? result.status);
    return result;
  } catch (err) {
    if (
      err instanceof FirstTokenDeadlineError ||
      request.signal?.reason instanceof FirstTokenDeadlineError ||
      request.signal?.reason?.name === 'TimeoutError'
    )
      outcome = 'timeout';
    else if (request.signal?.aborted) outcome = 'cancelled';
    throw err;
  } finally {
    if (!observation.prepared)
      observeGenerationPrepare({
        ...observation,
        durationMs: performance.now() - observation.startedAt,
        outcome: outcome === 'error' ? 'error' : 'rejected',
      });
    if (observation.directDispatched)
      observeGenerationAttempt({
        ...observation,
        role: 'primary',
        phase: 'generation',
        dispatched: true,
        outcome:
          outcome === 'success'
            ? 'completed'
            : outcome === 'timeout' ||
                outcome === 'filtered' ||
                outcome === 'length' ||
                outcome === 'user_cancelled'
              ? outcome
              : outcome === 'cancelled'
                ? 'cancelled'
                : outcome === 'upstream_error'
                  ? 'upstream_error'
                  : 'stream_interrupted',
        durationMs: performance.now() - observation.directDispatchedAt,
        headersMs: observation.headersMs,
        firstTokenMs: observation.firstTokenMs,
      });
    observeGenerationTerminal({
      ...observation,
      stream: request.stream,
      durationMs: performance.now() - observation.startedAt,
      outcome,
    });
  }
}

async function executeGeneration(
  request: GenerationRequest,
  hooks: GenerationHooks | undefined,
  log: GenerationLogger,
  observation: {
    startedAt: number;
    prepared: boolean;
    directDispatched: boolean;
    directDispatchedAt: number;
    headersMs?: number;
    firstTokenMs?: number;
    signalOutcome?: 'timeout' | 'cancelled';
    provider: string;
    model: string;
  }
): Promise<GenerationResult> {
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)])
    : AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  const chargeId = request.plannedChargeId ?? randomUUID();
  // Both transport choices use one published routing snapshot, read alongside pricing.
  const routingModelIds = [
    ...new Set([
      ...(request.model.provider === 'openrouter' ? [request.model.providerModelId] : []),
      ...(request.firstToken && request.model.firstTokenPolicy?.fallbackModelId
        ? [request.model.firstTokenPolicy.fallbackModelId]
        : []),
    ]),
  ];
  const [pricing, selectedBilling, vipStrategy, routingPreferences] = await withAbort(
    Promise.all([
      getPricingConfig(),
      request.model.billingContext ??
        getModelBillingContext({
          provider: request.model.provider,
          providerModelId: request.model.providerModelId,
        }),
      readVipStrategy(),
      getProviderPreferencesForModels(routingModelIds),
    ]),
    signal
  );

  let billing = selectedBilling;
  let deliveryPersisted = Promise.resolve();
  const finish = (result: GenerationResult): GenerationResult => {
    hooks?.onDone?.(result);
    return result;
  };
  const failed = (overrides: Partial<GenerationResult> = {}): GenerationResult => ({
    status: 'upstream_error',
    content: '',
    generationId: null,
    finishReason: null,
    chargeId: null,
    modelId: billing.modelId,
    modelOpenRouterId: billing.openRouterModelId,
    ...overrides,
  });

  await hooks?.onBeforeReserve?.(chargeId);
  signal.throwIfAborted();
  const reservation = await reserveCharacterFreeQuota({
    chargeId,
    userId: request.userId,
    characterId: request.characterId,
    billing,
    log,
    signal,
  });
  let released: Promise<void> | undefined;
  const releaseReservation = (): Promise<void> =>
    (released ??= (async () => {
      const decision = await reservation.finalize(false);
      if (reservation.granted && decision?.status !== 'released' && decision?.status !== 'consumed')
        throw new GenerationCleanupPendingError();
    })());

  let settleAbortedBeforeStream: (() => Promise<GenerationResult | null>) | undefined;
  try {
    signal.throwIfAborted();
    const plan = resolveBillingPlan({
      chargeId,
      billing,
      isFreeRound: reservation.isFreeRound,
      pricing,
      entitlement: request.model.entitlement,
      discountRate: vipStrategy.discountRate,
      discountConfigVersion: vipStrategy.discountVersion,
      log,
    });

    if (plan) {
      if (plan.snapshot.requires_vip && !plan.snapshot.vip_active) {
        await releaseReservation();
        return finish(failed({ denial: 'vip_required' }));
      }
      const precheck = await withAbort(
        checkWalletBalance({
          userId: request.userId,
          requiredAmount: plan.fixedDeduction.amount,
          walletPolicy: plan.snapshot.wallet_policy,
          openRouterModelId: billing.openRouterModelId,
          log,
        }),
        signal
      );
      if (!precheck.ok) {
        await releaseReservation();
        return finish({
          status: 'insufficient_balance',
          content: '',
          generationId: null,
          finishReason: null,
          chargeId: null,
          modelId: billing.modelId,
          modelOpenRouterId: billing.openRouterModelId,
          balance: {
            creditsRequired: precheck.creditsRequired,
            creditsAvailable: precheck.creditsAvailable,
          },
        });
      }
    }

    // The quote and quota remain tied to the selected model; only transport identity changes.
    const saveHistory: SaveHistory = (outcome) =>
      createHistoryWriter({ request, billing, plan, log })(outcome);

    // 模块内部已把读取 / 解析失败降级为「无规则」，这里拿到 null 就当没配置。
    const preferencesFor = (modelId: string) =>
      routingPreferences[routingModelIds.indexOf(modelId)] ?? null;
    const upstream = resolveProviderUpstream(billing.provider);
    if (!upstream.apiKey) {
      await releaseReservation();
      const apiKeyEnv = LLM_PROVIDER_CAPABILITIES[billing.provider].apiKeyEnv;
      const err = new Error(`${apiKeyEnv} is required for ${billing.provider} generation`);
      log.sys.error(
        {
          event: 'llm.upstream.missing_key',
          err,
          userId: request.userId,
          sessionId: request.sessionId ?? null,
          provider: billing.provider,
          model: billing.providerModelId,
        },
        'upstream provider API key is missing'
      );
      hooks?.onError?.(err);
      return finish(failed());
    }
    await hooks?.onBeforeDispatch?.({
      ...plan.snapshot,
      billing_mode: 'fixed_tier',
      provider: billing.provider,
      provider_model_id: billing.providerModelId,
    });
    // After admission the original quote is durable. An explicit manual stop while
    // waiting for headers is still a real round, even without a generation ID.
    settleAbortedBeforeStream = async () => {
      const interrupted: SseTapResult = {
        completed: false,
        content: '',
        deltaCount: 0,
        generationId: null,
        finishReason: 'timeout',
        usage: null,
        responseMetadata: {},
      };
      const outcome = hooks?.onBeforeSettle
        ? await hooks.onBeforeSettle(interrupted, releaseReservation)
        : interrupted;
      if (outcome.finishReason !== 'user_cancelled') return null;
      await releaseReservation();
      saveHistory({
        assistant_reply: null,
        status: 'stream_interrupted',
        generation_id: null,
        finish_reason: outcome.finishReason,
      });
      return finish(
        failed({ status: 'stream_interrupted', chargeId, finishReason: outcome.finishReason })
      );
    };
    signal.throwIfAborted();
    let upstreamRes: Response;
    const upstreamStartedAt = Date.now();
    try {
      const forward = async (
        model: TransportModel,
        attemptSignal: AbortSignal,
        onDispatch?: () => void
      ): Promise<Response> => {
        const route = resolveProviderUpstream(model.provider);
        if (!route.apiKey) throw new Error(`Missing key for ${model.provider}`);
        const preferences =
          model.provider === 'openrouter' ? preferencesFor(model.providerModelId) : null;
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
          url: route.url,
          method: 'POST',
          body,
          signal: attemptSignal,
          apiKey: route.apiKey,
          provider: model.provider,
        });
        if (!onDispatch) observation.headersMs = performance.now() - observation.directDispatchedAt;
        return response;
      };
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
        billing = {
          ...selectedBilling,
          provider: delivered.model.provider,
          providerModelId: delivered.model.providerModelId,
        };
        observation.provider = delivered.model.provider;
        observation.model = delivered.model.providerModelId;
        deliveryPersisted = delivered.deliveryPersisted;
        upstreamRes = delivered.response;
      } else upstreamRes = await forward(request.model, signal);
    } catch (err) {
      if (signal.aborted) {
        // Headers 前的系统取消可被既有业务收口吸收；只保留遥测原因，不改返回/结算。
        observation.signalOutcome =
          signal.reason instanceof FirstTokenDeadlineError || signal.reason?.name === 'TimeoutError'
            ? 'timeout'
            : 'cancelled';
        const settleAbort = settleAbortedBeforeStream;
        settleAbortedBeforeStream = undefined;
        const stopped = await settleAbort();
        if (stopped) return stopped;
      }
      await releaseReservation();
      log.sys.error(
        {
          event: 'llm.upstream.error',
          err,
          userId: request.userId,
          sessionId: request.sessionId ?? null,
          provider: billing.provider,
          model: billing.providerModelId,
        },
        'upstream request failed'
      );
      hooks?.onError?.(toError(err));
      if (
        err instanceof FirstTokenDeadlineError ||
        signal.reason instanceof FirstTokenDeadlineError
      )
        throw err instanceof FirstTokenDeadlineError ? err : signal.reason;
      return finish(failed());
    }

    // 上游非 2xx → 不扣费，记录失败
    if (!upstreamRes.ok) {
      await releaseReservation();
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
      hooks?.onError?.(new Error(`upstream ${upstreamRes.status}`));
      return finish(failed({ upstreamStatus: upstreamRes.status }));
    }

    const headerGenerationId = upstreamRes.headers.get('x-generation-id');
    if (headerGenerationId && !request.firstToken) {
      try {
        await hooks?.onGenerationId?.(headerGenerationId);
      } catch (err) {
        await upstreamRes.body?.cancel().catch(() => undefined);
        throw err;
      }
    }
    hooks?.onStreamOpen?.();

    if (!request.stream) {
      return finish(
        await consumeNonStream({
          request,
          upstreamRes,
          billing,
          chargeId,
          reservation,
          headerGenerationId,
          saveHistory,
          hooks,
          log,
          upstreamStartedAt,
        })
      );
    }

    if (!upstreamRes.body) {
      // 2xx 但没有正文属于 empty：不扣费，并给前端一个可重试的异常终态。
      await releaseReservation();
      saveHistory({
        assistant_reply: null,
        status: 'stream_interrupted',
        upstream_status: null,
        generation_id: headerGenerationId,
        finish_reason: null,
      });
      return finish({
        status: 'stream_interrupted',
        content: '',
        generationId: headerGenerationId,
        finishReason: null,
        chargeId,
        modelId: billing.modelId,
        modelOpenRouterId: billing.openRouterModelId,
      });
    }

    settleAbortedBeforeStream = undefined;
    // The flush path and pipeline error path share one settlement promise. In particular,
    // a deadline during a slow CAS/quota finalize must never trigger another settlement.
    let settlement: Promise<void> | undefined;
    let settledResult: SseTapResult | undefined;
    let firstTokenAt: number | null = null;
    const settleOnce = (observed: SseTapResult): Promise<void> => {
      settlement ??= (async () => {
        let interrupted = signal.aborted
          ? { ...observed, completed: false, finishReason: 'timeout' }
          : observed;
        try {
          try {
            await deliveryPersisted;
          } catch (err) {
            log.sys.error(
              { err, event: 'llm.delivery.persistence_failed', historyId: request.historyId },
              '生成身份确认失败，保留回复但不结算'
            );
            interrupted = {
              ...interrupted,
              completed: false,
              finishReason: 'delivery_persistence_failed',
            };
          }
          settledResult = hooks?.onBeforeSettle
            ? await hooks.onBeforeSettle(interrupted, releaseReservation)
            : interrupted;
        } catch (err) {
          // A failed persisted claim cannot be charged based only on locally observed [DONE].
          await releaseReservation();
          throw err;
        }
        await settleStream({
          result: settledResult,
          request,
          billing,
          reservation,
          saveHistory,
          log,
          upstreamStartedAt,
          firstTokenAt,
        });
      })();
      return settlement;
    };
    let firstTokenSeen = false;
    const noteFirstToken = (text: string): void => {
      if (!firstTokenSeen && text.trim()) {
        firstTokenSeen = true;
        firstTokenAt = Date.now();
        if (observation.directDispatched)
          observation.firstTokenMs = performance.now() - observation.directDispatchedAt;
        hooks?.onFirstToken?.();
      }
    };
    const tap = createSseTap({
      generationId: headerGenerationId,
      onGenerationId: request.firstToken ? undefined : hooks?.onGenerationId,
      onReasoningDelta:
        request.thinkingEnabled === false
          ? undefined
          : (delta) => {
              noteFirstToken(delta);
              hooks?.onReasoningDelta?.(delta);
            },
      onDelta: (delta) => {
        noteFirstToken(delta);
        hooks?.onDelta?.(delta);
      },
      onEnd: settleOnce,
    });

    try {
      await pipeline(
        Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream),
        tap,
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        { signal }
      );
    } catch (err) {
      // 流被上游或网络打断时 flush 不触发，终态要在这里补齐，否则预留的免费轮会一直挂着
      const partial = tap.snapshot();
      log.sys.error(
        {
          event: 'llm.stream.failed',
          err,
          userId: request.userId,
          sessionId: request.sessionId ?? null,
          generationId: partial.generationId,
        },
        'upstream stream aborted'
      );
      await settleOnce({ ...partial, completed: false });
      const actual = settledResult ?? partial;
      hooks?.onError?.(toError(err));
      return finish({
        status: 'stream_interrupted',
        content: actual.content,
        generationId: actual.generationId,
        finishReason: actual.finishReason,
        chargeId,
        modelId: billing.modelId,
        modelOpenRouterId: billing.openRouterModelId,
      });
    }

    const tapped = settledResult ?? tap.snapshot();
    return finish({
      status:
        hasCompletedReply(tapped) &&
        (tapped.finishReason === 'stop' || tapped.finishReason === null)
          ? 'success'
          : 'stream_interrupted',
      content: tapped.content,
      generationId: tapped.generationId,
      finishReason: tapped.finishReason,
      chargeId,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
    });
  } catch (err) {
    if (
      signal.aborted &&
      settleAbortedBeforeStream &&
      !(err instanceof GenerationCleanupPendingError)
    ) {
      const stopped = await settleAbortedBeforeStream();
      if (stopped) return stopped;
    }
    await releaseReservation();
    throw err;
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** 结算入参的固定字段一次绑定，终态只补那五个会变的。 */
function createHistoryWriter(input: {
  request: GenerationRequest;
  billing: ModelBillingContext;
  plan: BillingPlan;
  log: GenerationLogger;
}): SaveHistory {
  const { request, billing, plan, log } = input;
  return (outcome) => {
    settleGeneration(
      {
        first_token_observation: Boolean(request.firstToken),
        user_id: request.userId,
        model: billing.openRouterModelId,
        provider: billing.provider,
        provider_model_id: billing.providerModelId,
        ...plan.snapshot,
        user_input: request.userInput,
        history: request.messages,
        character_id: request.characterId,
        session_id: request.sessionId ?? null,
        history_id: request.historyId ?? null,
        ...outcome,
      },
      log
    );
  };
}

/**
 * 流终态：完整交付与扣费终态分开判断。finish_reason 暂缺时保留免费额度预留，
 * 让 chat history 同步任务拿到 OpenRouter 的真实终态后再消费或释放。
 */
async function settleStream(input: {
  result: SseTapResult;
  request: GenerationRequest;
  billing: ModelBillingContext;
  reservation: FreeQuotaReservation;
  saveHistory: SaveHistory;
  log: GenerationLogger;
  upstreamStartedAt: number;
  firstTokenAt: number | null;
}): Promise<void> {
  const { result, request, billing, reservation, saveHistory, log } = input;
  const delivered = hasCompletedReply(result);
  const billable = isBillableReply(result);
  const waitingForFinishReason =
    billing.provider === 'openrouter' && delivered && result.finishReason === null;
  if (!waitingForFinishReason) {
    await reservation.finalize(billable);
  }

  if (delivered && (result.finishReason === 'stop' || result.finishReason === null)) {
    log.biz.info(
      {
        event: 'llm.generation.completed',
        userId: request.userId,
        sessionId: request.sessionId ?? null,
        provider: billing.provider,
        model: billing.providerModelId,
        generationId: result.generationId,
        replyChars: result.content.length,
      },
      waitingForFinishReason ? 'LLM 回复已完整交付，等待计费终态' : 'LLM 生成完成'
    );
    saveHistory({
      assistant_reply: result.content,
      status: 'success',
      upstream_status: null,
      generation_id: result.generationId,
      finish_reason: result.finishReason,
      provider_response: providerResponse(input),
    });
    return;
  }

  log.biz.warn(
    {
      event: 'llm.generation.interrupted',
      userId: request.userId,
      sessionId: request.sessionId ?? null,
      provider: billing.provider,
      model: billing.providerModelId,
      generationId: result.generationId,
    },
    result.finishReason === 'user_cancelled'
      ? 'user stopped generation; settling the accepted quote'
      : 'generation produced an incomplete or empty reply, skipping deduction'
  );
  saveHistory({
    assistant_reply: result.deltaCount > 0 ? result.content : null,
    status: 'stream_interrupted',
    upstream_status: null,
    generation_id: result.generationId,
    finish_reason: result.finishReason,
    provider_response: providerResponse(input),
  });
}

function providerResponse(input: {
  result: SseTapResult;
  billing: ModelBillingContext;
  upstreamStartedAt: number;
  firstTokenAt: number | null;
}): GenerationSettlementEntry['provider_response'] {
  if (input.billing.provider !== 'venice') return undefined;
  return {
    usage: input.result.usage,
    responseMetadata: input.result.responseMetadata,
    latencyMs:
      input.firstTokenAt === null
        ? null
        : Math.max(0, input.firstTokenAt - input.upstreamStartedAt),
    generationTimeMs: Math.max(0, Date.now() - input.upstreamStartedAt),
  };
}

/** 非流式生成。MVP 的对话路径全走流式，这条分支只是让出口对 stream=false 也完整。 */
async function consumeNonStream(input: {
  request: GenerationRequest;
  upstreamRes: Response;
  billing: ModelBillingContext;
  chargeId: string | null;
  reservation: FreeQuotaReservation;
  headerGenerationId: string | null;
  saveHistory: SaveHistory;
  hooks?: GenerationHooks;
  log: GenerationLogger;
  upstreamStartedAt: number;
}): Promise<GenerationResult> {
  const { request, upstreamRes, billing, chargeId, reservation, saveHistory, hooks, log } = input;
  let generationId = input.headerGenerationId;

  let responseBody: string;
  try {
    responseBody = await upstreamRes.text();
  } catch (err) {
    await reservation.finalize(false);
    log.sys.error(
      { event: 'llm.upstream.body_read_failed', err, userId: request.userId },
      'failed to read non-streaming upstream response'
    );
    hooks?.onError?.(toError(err));
    return {
      status: 'upstream_error',
      content: '',
      generationId,
      finishReason: null,
      chargeId: null,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
    };
  }

  let assistantReply: string | null = null;
  let finishReason: string | null = null;
  let responseParsed = false;
  let usage: Record<string, unknown> | null = null;
  let responseMetadata: Record<string, unknown> = {};
  let exposedReasoning = '';
  try {
    const parsed = JSON.parse(responseBody);
    responseParsed = true;
    if (!generationId && typeof parsed?.id === 'string') generationId = parsed.id;
    const choice = parsed?.choices?.[0];
    if (choice?.message && typeof choice.message === 'object' && !Array.isArray(choice.message)) {
      exposedReasoning = readExposedReasoning(choice.message).slice(
        0,
        MAX_CONVERSATION_REASONING_LENGTH
      );
      const hasStructuredReasoning = exposedReasoning.length > 0;
      if (typeof choice.message.content === 'string') {
        const content: string[] = [];
        const splitter = createLeadingThinkingSplitter({
          onContent: (text) => content.push(text),
          onReasoning: (text) => {
            if (!hasStructuredReasoning)
              exposedReasoning += text.slice(
                0,
                MAX_CONVERSATION_REASONING_LENGTH - exposedReasoning.length
              );
          },
        });
        splitter.push(choice.message.content, !hasStructuredReasoning);
        splitter.finish();
        assistantReply = content.join('');
      }
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    if (parsed?.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage)) {
      usage = parsed.usage as Record<string, unknown>;
    }
    responseMetadata = Object.fromEntries(
      ['id', 'object', 'created', 'model', 'usage', 'venice_parameters'].flatMap((key) =>
        key in parsed ? [[key, parsed[key]]] : []
      )
    );
  } catch {
    log.sys.warn(
      { event: 'llm.upstream.invalid_non_stream_response', userId: request.userId },
      'successful upstream response was not valid JSON'
    );
  }

  if (!responseParsed) {
    await reservation.finalize(false);
    saveHistory({
      assistant_reply: null,
      status: 'upstream_error',
      upstream_status: upstreamRes.status,
      generation_id: generationId,
      finish_reason: null,
    });
    return {
      status: 'upstream_error',
      content: '',
      generationId,
      finishReason: null,
      chargeId: null,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
      upstreamStatus: upstreamRes.status,
    };
  }

  if (generationId && generationId !== input.headerGenerationId) {
    try {
      await hooks?.onGenerationId?.(generationId);
    } catch (err) {
      // The complete body has already been read. Preserve it even when identity
      // storage fails; the local failure must not erase an observed response.
      const release = async () => {
        await reservation.finalize(false);
      };
      await release();
      const observed: SseTapResult = {
        completed: false,
        content: assistantReply ?? '',
        deltaCount: assistantReply ? 1 : 0,
        generationId,
        finishReason: 'error',
        usage,
        responseMetadata,
      };
      const outcome = hooks?.onBeforeSettle
        ? await hooks.onBeforeSettle(observed, release)
        : observed;
      saveHistory({
        assistant_reply: outcome.content || null,
        status: 'stream_interrupted',
        upstream_status: null,
        generation_id: generationId,
        finish_reason: outcome.finishReason,
      });
      hooks?.onError?.(toError(err));
      return {
        status: 'stream_interrupted',
        content: outcome.content,
        generationId,
        finishReason: outcome.finishReason,
        chargeId,
        modelId: billing.modelId,
        modelOpenRouterId: billing.openRouterModelId,
      };
    }
  }

  const hasContent = typeof assistantReply === 'string' && assistantReply.trim().length > 0;
  const delivered = responseParsed && hasContent;
  const billable = delivered && finishReason === 'stop';
  const waitingForFinishReason =
    billing.provider === 'openrouter' && delivered && finishReason === null;
  if (!waitingForFinishReason) {
    await reservation.finalize(billable);
  }
  const status =
    delivered && (finishReason === 'stop' || finishReason === null)
      ? 'success'
      : 'stream_interrupted';
  saveHistory({
    assistant_reply: assistantReply,
    status,
    upstream_status: null,
    generation_id: generationId,
    finish_reason: finishReason,
    provider_response:
      billing.provider === 'venice'
        ? {
            usage,
            responseMetadata,
            latencyMs: null,
            generationTimeMs: Math.max(0, Date.now() - input.upstreamStartedAt),
          }
        : undefined,
  });
  const reasoningIsFirstToken =
    request.thinkingEnabled !== false && exposedReasoning.trim().length > 0;
  if (reasoningIsFirstToken) hooks?.onFirstToken?.();
  if (request.thinkingEnabled !== false && exposedReasoning)
    hooks?.onReasoningDelta?.(exposedReasoning);
  if (assistantReply) {
    if (!reasoningIsFirstToken) hooks?.onFirstToken?.();
    hooks?.onDelta?.(assistantReply);
  }
  return {
    status,
    content: assistantReply ?? '',
    generationId,
    finishReason,
    chargeId,
    modelId: billing.modelId,
    modelOpenRouterId: billing.openRouterModelId,
  };
}

export const generationService: GenerationService = { execute };

/** Race only non-generation preparation; quota/CAS writes retain their real completion. */
function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
