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
import { forwardWithFirstTokenFallback, type TransportModel } from './first-token-fallback.js';
import { buildUpstreamBody } from './generation-body.js';
import { surplusReasoningBody } from './surplus-reasoning.js';
import { forwardSurplusCall } from './surplus-call-transport.js';
import type { UpstreamTiming } from './upstream-timing.js';
import type { GenerationRequest, GenerationPreparation, GenerationLogger } from './types.js';

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
    attempt?: { role: 'primary' | 'fallback'; timing: UpstreamTiming }
  ): Promise<Response> => {
    const route = resolveProviderUpstream(model.provider, model.providerModelId);
    if (!route.apiKey) throw new Error(`Missing key for ${model.provider}`);
    let preferences =
      model.provider === 'openrouter'
        ? (prepared.routingPreferences[prepared.routingModelIds.indexOf(model.providerModelId)] ??
          null)
        : null;
    const racesSameModel =
      attempt !== undefined &&
      request.model.provider === 'openrouter' &&
      request.model.providerModelId ===
        (request.model.firstTokenPolicy?.fallbackModelId ?? FIRST_TOKEN_FALLBACK_MODEL_ID);
    if (attempt?.role === 'fallback' || racesSameModel) {
      const providers =
        request.model.firstTokenPolicy?.fallbackProviders ??
        resolveFallbackProviders({ fallback_model_id: model.providerModelId });
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
    const body = {
      ...buildUpstreamBody(actualRequest, preferences),
      // 深度思考开关：Surplus 按模型声明的写法发思考强度（兜底等其他供应商不受影响）
      ...(actualRequest.model.provider === 'surplus'
        ? surplusReasoningBody(prepared.surplusReasoning, actualRequest.thinkingEnabled ?? true)
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
      const response = await forwardToUpstream({
        ...route,
        method: 'POST',
        body: JSON.stringify(body),
        signal: attemptSignal,
        timing: attempt?.timing,
        // 凑不到折扣底线时 Surplus 直接 404，交给兜底，不会派给更贵的卖家。
        ...(freeZone ? { headers: { 'X-Min-Discount': String(freeZone.minDiscountPct) } } : {}),
      });
      if (!onDispatch) observation.headersMs = performance.now() - observation.directDispatchedAt;
      return response;
    };
    return model.provider === 'surplus'
      ? forwardSurplusCall({
          request: actualRequest,
          body,
          signal: attemptSignal,
          log: input.log,
          reasoning: prepared.surplusReasoning,
          dispatch,
        })
      : dispatch();
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
  const delivered = await forwardWithFirstTokenFallback({
    primary: request.model,
    requestedModelId: request.model.modelId,
    totalBudgetMs: policy.deadlineMs,
    thinkingEnabled: request.thinkingEnabled ?? true,
    fallbackModelId: policy.fallbackModelId,
    primaryAttemptId: request.firstToken.primaryAttemptId,
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
    onObservationError: (err) =>
      log.sys.warn(
        { err, event: 'llm.attempt.observation_failed', historyId: request.historyId },
        'Model attempt observation could not be confirmed'
      ),
  });
  observation.provider = delivered.model.provider;
  observation.model = delivered.model.providerModelId;
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
