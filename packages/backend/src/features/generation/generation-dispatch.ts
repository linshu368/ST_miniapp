import {
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  LLM_PROVIDER_CAPABILITIES,
  fallbackProviderPreferences,
  resolveFallbackProviders,
} from '@miniapp/shared';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import {
  observeGenerationDispatch,
  observeGenerationPrepare,
} from '../../lib/engineering-observability.js';
import { resolveProviderUpstream, forwardToUpstream } from './upstream.js';
import {
  forwardWithFirstTokenFallback,
  type PersistGate,
  type TransportModel,
} from './first-token-fallback.js';
import { buildUpstreamBody } from './generation-body.js';
import { learnSurplusReasoningRejection, surplusReasoningBody } from './surplus-reasoning.js';
import { revealsReasoning } from './reasoning-display.js';
import { forwardSurplusCall } from './surplus-call-transport.js';
import { forwardRelayCall } from './relay-call-transport.js';
import {
  surplusRouteBody,
  surplusRouteHeaders,
  surplusRouteProvider,
  type SurplusRoute,
} from './surplus-route.js';
import type { UpstreamTiming } from './upstream-timing.js';
import { recordLlmCall } from './call-ledger.js';
import { noteFreeZonePrimaryCall } from '../free-zone/unroutable-guard.js';
import type { TurnFacts } from './turn-outcome.js';
import type {
  GenerationRequest,
  GenerationPreparation,
  GenerationLogger,
  GenerationMessage,
} from './types.js';

export interface ExecutionObservation {
  startedAt: number;
  prepared: boolean;
  directDispatched: boolean;
  directDispatchedAt: number;
  headersMs?: number;
  firstTokenMs?: number;
  signalOutcome?: 'timeout' | 'cancelled';
  provider: string;
  model: string;
  /** 聊天成功率指标用（turn-outcome.ts） */
  turn?: TurnFacts;
}

type DispatchInput = {
  request: GenerationRequest;
  prepared: GenerationPreparation;
  signal: AbortSignal;
  observation: ExecutionObservation;
  log: GenerationLogger;
};

export function missingProviderKey(input: DispatchInput): Error | null {
  const { request, log } = input;
  if (resolveProviderUpstream(request.model.provider).apiKey) return null;
  const apiKeyEnv = LLM_PROVIDER_CAPABILITIES[request.model.provider].apiKeyEnv;
  const err = new Error(`${apiKeyEnv} is required for ${request.model.provider} generation`);
  log.sys.error(
    {
      event: 'llm.upstream.missing_key',
      err,
      userId: request.userId,
      sessionId: request.sessionId ?? null,
      provider: request.model.provider,
      model: request.model.providerModelId,
    },
    'upstream provider API key is missing'
  );
  return err;
}

function createForward(input: DispatchInput) {
  const { request, prepared, signal, observation } = input;
  return async (
    model: TransportModel,
    attemptSignal: AbortSignal,
    onDispatch?: () => void,
    attempt?: { role: 'primary' | 'fallback'; timing: UpstreamTiming; gate?: PersistGate }
  ): Promise<Response> => {
    const route = resolveProviderUpstream(model.provider, model.providerModelId);
    if (!route.apiKey) throw new Error(`Missing key for ${model.provider}`);
    const preferences = dispatchPreferences(request, prepared, model, attempt?.role);
    const isFallback = attempt?.role === 'fallback';
    const actualRequest = {
      ...request,
      model: {
        ...request.model,
        ...model,
        openRouterModelId: model.providerModelId,
        // 兜底（含出字后重写）不带首发的折扣底线和供应商白名单
        freeZone: isFallback ? undefined : request.model.freeZone,
      },
    };
    const surplusRoute =
      actualRequest.model.provider === 'surplus'
        ? resolveSurplusRoute(actualRequest.model)
        : undefined;
    const body = {
      ...buildUpstreamBody(actualRequest, preferences),
      ...surplusRouteBody(surplusRoute),
      // 深度思考开关：Surplus 按模型声明的写法、按供应商的规矩发思考强度（其他供应商不受影响）
      ...(actualRequest.model.provider === 'surplus'
        ? surplusReasoningBody(
            isFallback ? prepared.fallbackSurplusReasoning : prepared.surplusReasoning,
            actualRequest.thinkingEnabled ?? true,
            surplusRouteProvider(surplusRoute)
          )
        : {}),
    };
    const dispatch = async () => {
      signal.throwIfAborted();
      attemptSignal.throwIfAborted();
      onDispatch?.();
      markPrepared(observation);
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
      const freeZone =
        actualRequest.model.provider === 'surplus' ? actualRequest.model.freeZone : undefined;
      const headers = surplusRouteHeaders(surplusRoute);
      const response = await forwardToUpstream({
        ...route,
        method: 'POST',
        body: JSON.stringify(body),
        signal: attemptSignal,
        timing: attempt?.timing,
        // 首发凑不到折扣底线时 Surplus 直接 404，交给兜底，不会派给更贵的卖家；兜底不设底线。
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
      if (!onDispatch) observation.headersMs = performance.now() - observation.directDispatchedAt;
      // 供应商不认 reasoning 字段：记下来，之后发给它的请求不再带（这一轮交给兜底）
      if (freeZone) void learnSurplusReasoningRejection(response, freeZone.providers[0]);
      return response;
    };
    if (model.provider === 'packy' || model.provider === 'onexmodel')
      return forwardRelayCall({
        request: actualRequest,
        signal: attemptSignal,
        log: input.log,
        dispatch,
      });
    // 每轮一行的 Surplus 调用记录属于首发；Surplus 兜底直接发，台账另起一行、成本按请求号补查（call-costs）
    return model.provider === 'surplus' && !isFallback
      ? forwardSurplusCall({
          request: actualRequest,
          body,
          signal: attemptSignal,
          log: input.log,
          reasoning: prepared.surplusReasoning,
          gate: attempt?.gate,
          dispatch,
        })
      : dispatch();
  };
}

/** 首发 Surplus 的路由来自 freeZone（折扣底线 + 白名单）；兜底自带 surplusRoute */
function resolveSurplusRoute(model: {
  surplusRoute?: SurplusRoute;
  freeZone?: { providers: string[]; minDiscountPct: number };
}): SurplusRoute | undefined {
  if (model.surplusRoute) return model.surplusRoute;
  if (!model.freeZone) return undefined;
  return { providers: model.freeZone.providers, minDiscountPct: model.freeZone.minDiscountPct };
}

/** 这一轮的兜底目标：畅聊专用兜底（Surplus），否则 OpenRouter + 模型目录兜底 */
export function fallbackTarget(model: GenerationRequest['model']): TransportModel {
  return (
    model.firstTokenPolicy?.fallback ?? {
      provider: 'openrouter',
      providerModelId: model.firstTokenPolicy?.fallbackModelId ?? FIRST_TOKEN_FALLBACK_MODEL_ID,
    }
  );
}

/** 出字后兜底（中断或拒答 → 擦掉重写）的上游调用：固定走首字兜底同一个目标，关闭思考展示。 */
export interface RecoveryForward {
  model: TransportModel;
  send(messages: GenerationMessage[], signal: AbortSignal): Promise<Response>;
}

export function createRecoveryForward(input: DispatchInput): RecoveryForward {
  const model = fallbackTarget(input.request.model);
  return {
    model,
    send: (messages, signal) =>
      createForward({
        ...input,
        request: { ...input.request, messages, thinkingEnabled: false },
        // 传一个空 onDispatch：这次调用不算首发直连，不改动本轮的首发观测。
      })(model, signal, () => undefined, {
        role: 'fallback',
        timing: { startedAt: performance.now() },
      }),
  };
}

function markPrepared(observation: ExecutionObservation): void {
  if (observation.prepared) return;
  observation.prepared = true;
  observeGenerationPrepare({
    ...observation,
    durationMs: performance.now() - observation.startedAt,
    outcome: 'ready',
  });
}

export async function dispatchGeneration(input: DispatchInput): Promise<{
  response: Response;
  billing: ModelBillingContext;
  deliveryPersisted: Promise<void>;
}> {
  const { request, prepared, observation, signal, log } = input;
  const forward = createForward(input);
  if (!request.firstToken || !request.model.firstTokenPolicy || !request.stream) {
    return {
      response: await forward(request.model, signal),
      billing: prepared.selectedBilling,
      deliveryPersisted: Promise.resolve(),
    };
  }
  const elapsed = performance.now() - request.firstToken.requestStartedAt;
  const policy = request.model.firstTokenPolicy;
  const { freeZone } = request.model;
  // 模型目录「免费畅聊」板块的模型没有 Surplus 那套参数，只按计费上下文认出是畅聊
  const freeZoneId = request.model.billingContext?.freeZone?.candidateId;
  const historyId = request.historyId;
  const delivered = await forwardWithFirstTokenFallback({
    primary: request.model,
    requestedModelId: request.model.modelId,
    totalBudgetMs: policy.deadlineMs,
    // 显示规则：免费模型的思考过程也算出字（见 reasoning-display.ts）
    thinkingEnabled: revealsReasoning(request),
    fallbackModelId: policy.fallbackModelId,
    fallback: policy.fallback,
    primaryAttemptId: request.firstToken.primaryAttemptId,
    // 畅聊免费模型可配同时发几路主请求（运营平台候选池「并发」）
    primaryCount: request.model.freeZone?.parallelRequests ?? 1,
    timeoutMs: policy.timeoutMs,
    fallbackTimeoutMs: policy.fallbackTimeoutMs,
    remainingFirstTokenMs: policy.deadlineMs - elapsed,
    remainingObservationMs: 110_000 - elapsed,
    requestStartedAt: request.firstToken.requestStartedAt,
    signal,
    store: request.firstToken.store,
    deferPersistence: request.firstToken.deferPersistence,
    onReady: request.firstToken.onReady,
    forward,
    // 每一路调用（收费轮与畅聊、含并发落败、被取消的、兜底）都记进 ops.llm_calls，事后补成本，
    // 每轮总成本 = 全部调用之和；畅聊候选池（Surplus）模型的主请求另外数连续拒单，够多就自动下架（unroutable-guard.ts）
    onCallSettled: (call) => {
      if (call.role === 'primary') observation.turn?.primaryCallEnds.push(call.endReason);
      if (historyId) {
        recordLlmCall(
          {
            ...call,
            chatHistoryId: historyId,
            lane: freeZoneId ? 'free_zone' : 'chat',
            candidateId: freeZoneId ?? null,
          },
          log.sys
        );
      }
      if (freeZone && call.role === 'primary') {
        noteFreeZonePrimaryCall({
          candidateId: freeZone.candidateId,
          providers: freeZone.providers,
          httpStatus: call.httpStatus,
        });
      }
    },
    onObservationError: (err) =>
      log.sys.warn(
        { err, event: 'llm.attempt.observation_failed', historyId: request.historyId },
        'Model attempt observation could not be confirmed'
      ),
  });
  observation.provider = delivered.model.provider;
  observation.model = delivered.model.providerModelId;
  if (observation.turn) observation.turn.deliveredRole = delivered.role;
  return {
    response: delivered.response,
    billing: {
      ...prepared.selectedBilling,
      provider: delivered.model.provider,
      providerModelId: delivered.model.providerModelId,
    },
    deliveryPersisted: delivered.deliveryPersisted,
  };
}

function dispatchPreferences(
  request: GenerationRequest,
  prepared: GenerationPreparation,
  model: TransportModel,
  role?: 'primary' | 'fallback'
) {
  // OpenRouter 专有的供应商偏好；Surplus 兜底有自己的路由
  if (model.provider !== 'openrouter') return null;
  let preferences =
    prepared.routingPreferences[prepared.routingModelIds.indexOf(model.providerModelId)] ?? null;
  const racesSameModel =
    role !== undefined &&
    request.model.provider === 'openrouter' &&
    request.model.providerModelId ===
      (request.model.firstTokenPolicy?.fallbackModelId ?? FIRST_TOKEN_FALLBACK_MODEL_ID);
  if (role === 'fallback' || racesSameModel) {
    const providers =
      request.model.firstTokenPolicy?.fallbackProviders ??
      resolveFallbackProviders({ fallback_model_id: model.providerModelId });
    preferences = fallbackProviderPreferences(
      preferences,
      racesSameModel && role === 'fallback' && providers ? [providers[1], providers[0]] : providers
    );
  }
  return preferences;
}
