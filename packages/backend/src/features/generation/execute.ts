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
import {
  getModelBillingContext,
  getPricingConfig,
  type ModelBillingContext,
} from '../../platform/model-tiers.js';
import {
  getProviderPreferencesForModels,
  getProviderRoutingConfig,
} from '../../platform/provider-routing.js';
import { readVipStrategy } from '../../platform/vip-strategy.js';
import { MAX_CONVERSATION_REASONING_LENGTH } from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import { reserveCharacterFreeQuota, type FreeQuotaReservation } from './quota.js';
import { checkWalletBalance, resolveBillingPlan } from './precheck.js';
import { getCharacterCreatorOwner } from './creator-billing.js';
import {
  getCharacterFreeChatQuotaLimit,
  isQuotaTrackableCharacterId,
} from '../billing/free-quota.js';
import {
  createLeadingThinkingSplitter,
  readExposedReasoning,
  type SseTapResult,
} from './upstream.js';
import {
  createAbortedBeforeStreamSettler,
  dispatchUpstream,
  rejectUpstreamResponse,
} from './generation-dispatch.js';
import {
  admitPaidRound,
  assertPreparedIdentity,
  createGenerationRun,
  createHistoryWriter,
  failMissingUpstreamKey,
  resolveRoundPlan,
  toError,
  withAbort,
  type GenerationObservation,
  type SaveHistory,
} from './generation-run.js';
import { consumeStreamingResponse, settleEmptyStream } from './generation-stream.js';
import { FirstTokenDeadlineError } from './first-token-fallback.js';
import { GenerationCleanupPendingError } from './types.js';
import {
  observeGenerationAttempt,
  observeGenerationPrepare,
  observeGenerationTerminal,
  type GenerationOutcome,
} from '../../lib/engineering-observability.js';
import type {
  GenerationHooks,
  GenerationPreparation,
  ResolvedModel,
  GenerationLogger,
  GenerationRequest,
  GenerationResult,
  GenerationService,
} from './types.js';

/** Starts only independent reads. Admission/quote/quota writes remain in execute. */
export function prepareGeneration(input: {
  model: ResolvedModel | Promise<ResolvedModel>;
  characterId: string | null;
  useFallback: boolean;
  payer?: { userId: string; chargeId: string; log: GenerationLogger; signal: AbortSignal };
}): Promise<GenerationPreparation> {
  // These reads do not depend on the selected model or on prompt construction.
  // Start them now, rather than introducing another wave after those awaits.
  // Conversation fallback always uses OpenRouter. Other consumers retain lazy
  // routing reads, so a direct Venice request does not gain a needless DB query.
  const routingConfig = input.useFallback ? getProviderRoutingConfig() : undefined;
  const independent = Promise.all([
    getPricingConfig(),
    readVipStrategy(),
    getCharacterCreatorOwner(input.characterId),
  ]);
  const transport = Promise.resolve(input.model).then(async (model) => {
    const routingModelIds = [
      ...new Set([
        ...(model.provider === 'openrouter' ? [model.providerModelId] : []),
        ...(input.useFallback && model.firstTokenPolicy?.fallbackModelId
          ? [model.firstTokenPolicy.fallbackModelId]
          : []),
      ]),
    ];
    const billing = Promise.resolve(
      model.billingContext ??
        getModelBillingContext({
          provider: model.provider,
          providerModelId: model.providerModelId,
        })
    );
    const [selectedBilling, routingPreferences, quotaLimit] = await Promise.all([
      billing,
      getProviderPreferencesForModels(routingModelIds, routingConfig),
      billing.then((value) =>
        value.isFree && isQuotaTrackableCharacterId(input.characterId)
          ? getCharacterFreeChatQuotaLimit()
          : undefined
      ),
    ]);
    return { model, selectedBilling, routingModelIds, routingPreferences, quotaLimit };
  });
  const work = Promise.all([independent, transport]).then(
    ([
      [pricing, vipStrategy, creatorUserId],
      { model, selectedBilling, routingModelIds, routingPreferences, quotaLimit },
    ]): GenerationPreparation => {
      let paidAdmission: GenerationPreparation['paidAdmission'];
      // Never speculate on free quota. Paid admission uses the same frozen quote
      // and exactly one read; no reservation, wallet initialization or debit here.
      if (input.payer && !selectedBilling.isFree) {
        input.payer.signal.throwIfAborted();
        const { userId, chargeId, log } = input.payer;
        const plan = resolveBillingPlan({
          chargeId,
          billing: selectedBilling,
          isFreeRound: false,
          pricing,
          entitlement: model.entitlement,
          discountRate: vipStrategy.discountRate,
          discountConfigVersion: vipStrategy.discountVersion,
          ...(creatorUserId && input.characterId
            ? {
                creator: {
                  characterId: input.characterId,
                  creatorUserId,
                  payerUserId: userId,
                },
              }
            : {}),
          log,
        });
        const balance =
          plan.snapshot.requires_vip && !plan.snapshot.vip_active
            ? Promise.resolve({ ok: true } as const)
            : checkWalletBalance({
                userId,
                requiredAmount: plan.fixedDeduction.amount,
                walletPolicy: plan.snapshot.wallet_policy,
                openRouterModelId: selectedBilling.openRouterModelId,
                log,
              });
        void balance.catch(() => undefined);
        paidAdmission = { userId, plan, balance };
      }
      return {
        modelId: model.modelId,
        provider: model.provider,
        providerModelId: model.providerModelId,
        characterId: input.characterId,
        pricing,
        selectedBilling,
        vipStrategy,
        routingModelIds,
        routingPreferences,
        creatorUserId,
        quotaLimit,
        paidAdmission,
      };
    }
  );
  // Admission can fail before execute reaches its await. Observe rejection now,
  // while keeping the original rejected promise for the eventual consumer.
  void work.catch(() => undefined);
  return work;
}

/** 与会话 streaming 陈旧回收口径一致，避免一轮生成无限占住会话。 */
export const GENERATION_TIMEOUT_MS = 120_000;

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

/**
 * 一轮生成的编排：取预热 → 身份校验 → 预留免费额度 → 准入 → 派发 → 按响应形态收口。
 *
 * 开始预留之后任何异常都要经过下方 catch：头前被中止且是用户手动停止的按已接受报价结算，
 * 其余释放预留后原样抛出。各阶段共享的可变状态都在 GenerationRun 里，按引用传递。
 */
async function executeGeneration(
  request: GenerationRequest,
  hooks: GenerationHooks | undefined,
  log: GenerationLogger,
  observation: GenerationObservation
): Promise<GenerationResult> {
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)])
    : AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  const chargeId = request.plannedChargeId ?? randomUUID();
  const prepared = await withAbort(
    request.preparation ??
      prepareGeneration({
        model: request.model,
        characterId: request.characterId,
        useFallback: Boolean(request.firstToken),
      }),
    signal
  );
  assertPreparedIdentity(prepared, request, chargeId);

  await hooks?.onBeforeReserve?.(chargeId);
  signal.throwIfAborted();
  const reservation = await reserveCharacterFreeQuota({
    chargeId,
    userId: request.userId,
    characterId: request.characterId,
    billing: prepared.selectedBilling,
    log,
    signal,
    quotaLimit: prepared.quotaLimit,
  });
  const run = createGenerationRun({
    request,
    hooks,
    log,
    signal,
    chargeId,
    prepared,
    reservation,
    observation,
  });

  try {
    signal.throwIfAborted();
    const plan = resolveRoundPlan(run);
    const denied = await admitPaidRound(run, plan);
    if (denied) return denied;

    // The quote and quota remain tied to the selected model; only transport identity changes.
    const saveHistory: SaveHistory = (outcome) =>
      createHistoryWriter({ request, billing: run.billing, plan, log })(outcome);
    const missingKey = await failMissingUpstreamKey(run);
    if (missingKey) return missingKey;
    await hooks?.onBeforeDispatch?.({
      ...plan.snapshot,
      billing_mode: 'fixed_tier',
      provider: run.billing.provider,
      provider_model_id: run.billing.providerModelId,
    });
    run.settleAbortedBeforeStream = createAbortedBeforeStreamSettler(run, saveHistory);
    signal.throwIfAborted();
    const upstreamStartedAt = Date.now();
    const dispatched = await dispatchUpstream(run);
    if (dispatched.kind === 'finished') return dispatched.result;
    const upstreamRes = dispatched.response;

    if (!upstreamRes.ok) return await rejectUpstreamResponse(run, upstreamRes, saveHistory);

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
      return run.finish(
        await consumeNonStream({
          request,
          upstreamRes,
          billing: run.billing,
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

    if (!upstreamRes.body) return await settleEmptyStream(run, headerGenerationId, saveHistory);

    run.settleAbortedBeforeStream = undefined;
    return await consumeStreamingResponse(run, {
      body: upstreamRes.body,
      headerGenerationId,
      saveHistory,
      upstreamStartedAt,
    });
  } catch (err) {
    if (
      signal.aborted &&
      run.settleAbortedBeforeStream &&
      !(err instanceof GenerationCleanupPendingError)
    ) {
      const stopped = await run.settleAbortedBeforeStream();
      if (stopped) return stopped;
    }
    await run.releaseReservation();
    throw err;
  }
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
