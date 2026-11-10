import { randomUUID } from 'node:crypto';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import { reserveCharacterFreeQuota, type FreeQuotaReservation } from './quota.js';
import { checkWalletBalance, resolveBillingPlan, type BillingPlan } from './precheck.js';
import { GenerationCleanupPendingError } from './types.js';
import type {
  GenerationHooks,
  GenerationLogger,
  GenerationPreparation,
  GenerationRequest,
  GenerationResult,
} from './types.js';
import { FirstTokenDeadlineError } from './first-token-fallback.js';
import type { SseTapResult } from './upstream.js';
import { prepareGeneration } from './generation-prepare.js';
import { createHistoryWriter, toError, type SaveHistory } from './generation-settlement.js';
import {
  dispatchGeneration,
  missingProviderKey,
  type ExecutionObservation,
} from './generation-dispatch.js';
import { consumeNonStream } from './generation-nonstream.js';
import { consumeStream } from './generation-stream.js';

export const GENERATION_TIMEOUT_MS = 120_000;

interface Execution {
  request: GenerationRequest;
  hooks?: GenerationHooks;
  log: GenerationLogger;
  observation: ExecutionObservation;
  signal: AbortSignal;
  chargeId: string;
  prepared: GenerationPreparation;
  billing: ModelBillingContext;
  reservation: FreeQuotaReservation;
  releaseReservation(): Promise<void>;
  plan: BillingPlan;
  saveHistory: SaveHistory;
  settleAbortedBeforeStream?: () => Promise<GenerationResult | null>;
}

export async function executeGeneration(
  request: GenerationRequest,
  hooks: GenerationHooks | undefined,
  log: GenerationLogger,
  observation: ExecutionObservation
): Promise<GenerationResult> {
  const state = await prepareExecution(request, hooks, log, observation);
  try {
    state.signal.throwIfAborted();
    const denial = await checkAdmission(state);
    if (denial) return finish(state, denial);
    return await runAcceptedExecution(state);
  } catch (err) {
    if (
      state.signal.aborted &&
      state.settleAbortedBeforeStream &&
      !(err instanceof GenerationCleanupPendingError)
    ) {
      const stopped = await state.settleAbortedBeforeStream();
      if (stopped) return stopped;
    }
    await state.releaseReservation();
    throw err;
  }
}

async function prepareExecution(
  request: GenerationRequest,
  hooks: GenerationHooks | undefined,
  log: GenerationLogger,
  observation: ExecutionObservation
): Promise<Execution> {
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
  if (
    prepared.modelId !== request.model.modelId ||
    prepared.provider !== request.model.provider ||
    prepared.providerModelId !== request.model.providerModelId ||
    prepared.characterId !== request.characterId ||
    (prepared.paidAdmission &&
      (prepared.paidAdmission.userId !== request.userId ||
        prepared.paidAdmission.plan.chargeId !== chargeId ||
        prepared.selectedBilling.isFree))
  )
    throw new Error('Generation preparation identity differs');
  await hooks?.onBeforeReserve?.(chargeId);
  signal.throwIfAborted();
  const billing = prepared.selectedBilling;
  const reservation = await reserveCharacterFreeQuota({
    chargeId,
    userId: request.userId,
    characterId: request.characterId,
    billing,
    log,
    signal,
    quotaLimit: prepared.quotaLimit,
  });
  let released: Promise<void> | undefined;
  const releaseReservation = () =>
    (released ??= (async () => {
      const decision = await reservation.finalize(false);
      if (reservation.granted && decision?.status !== 'released' && decision?.status !== 'consumed')
        throw new GenerationCleanupPendingError();
    })());
  // The assignment is completed before any dispatch; writer reads the chosen transport at settlement.
  const state = {
    request,
    hooks,
    log,
    observation,
    signal,
    chargeId,
    prepared,
    billing,
    reservation,
    releaseReservation,
  } as Execution;
  state.saveHistory = (outcome) =>
    createHistoryWriter({ request, billing: state.billing, plan: state.plan, log })(outcome);
  return state;
}

async function checkAdmission(state: Execution): Promise<GenerationResult | null> {
  const { request, prepared, billing, chargeId, reservation, log, signal } = state;
  state.plan =
    prepared.paidAdmission?.plan ??
    resolveBillingPlan({
      chargeId,
      billing,
      isFreeRound: reservation.isFreeRound,
      pricing: prepared.pricing,
      entitlement: request.model.entitlement,
      discountRate: prepared.vipStrategy.discountRate,
      discountConfigVersion: prepared.vipStrategy.discountVersion,
      ...(prepared.creatorUserId && request.characterId
        ? {
            creator: {
              characterId: request.characterId,
              creatorUserId: prepared.creatorUserId,
              payerUserId: request.userId,
            },
          }
        : {}),
      log,
    });
  if (state.plan.snapshot.requires_vip && !state.plan.snapshot.vip_active) {
    await state.releaseReservation();
    return failed(state, { denial: 'vip_required' });
  }
  const precheck = await withAbort(
    prepared.paidAdmission?.balance ??
      checkWalletBalance({
        userId: request.userId,
        requiredAmount: state.plan.fixedDeduction.amount,
        walletPolicy: state.plan.snapshot.wallet_policy,
        openRouterModelId: billing.openRouterModelId,
        log,
      }),
    signal
  );
  if (precheck.ok) return null;
  await state.releaseReservation();
  return failed(state, {
    status: 'insufficient_balance',
    balance: {
      creditsRequired: precheck.creditsRequired,
      creditsAvailable: precheck.creditsAvailable,
    },
  });
}

async function runAcceptedExecution(state: Execution): Promise<GenerationResult> {
  const { request, hooks, signal, observation } = state;
  const missing = missingProviderKey(state);
  if (missing) {
    await state.releaseReservation();
    hooks?.onError?.(missing);
    return finish(state, failed(state));
  }
  await hooks?.onBeforeDispatch?.({
    ...state.plan.snapshot,
    billing_mode: 'fixed_tier',
    provider: state.billing.provider,
    provider_model_id: state.billing.providerModelId,
  });
  state.settleAbortedBeforeStream = () => settleStoppedBeforeStream(state);
  signal.throwIfAborted();
  const upstreamStartedAt = Date.now();
  let dispatched: Awaited<ReturnType<typeof dispatchGeneration>>;
  try {
    dispatched = await dispatchGeneration(state);
  } catch (err) {
    return handleDispatchFailure(state, err);
  }
  state.billing = dispatched.billing;
  const upstreamRes = dispatched.response;
  if (!upstreamRes.ok) return rejectResponse(state, upstreamRes);
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
  const consume = {
    request,
    upstreamRes,
    billing: state.billing,
    chargeId: state.chargeId,
    reservation: state.reservation,
    headerGenerationId,
    saveHistory: state.saveHistory,
    hooks,
    log: state.log,
    upstreamStartedAt,
  };
  if (!request.stream) return finish(state, await consumeNonStream(consume));
  if (!upstreamRes.body) return emptyResponse(state, headerGenerationId);
  state.settleAbortedBeforeStream = undefined;
  return finish(
    state,
    await consumeStream({
      ...consume,
      signal,
      observation,
      deliveryPersisted: dispatched.deliveryPersisted,
      releaseReservation: state.releaseReservation,
    })
  );
}

async function settleStoppedBeforeStream(state: Execution): Promise<GenerationResult | null> {
  const interrupted: SseTapResult = {
    completed: false,
    content: '',
    deltaCount: 0,
    generationId: null,
    finishReason: 'timeout',
    usage: null,
    responseMetadata: {},
  };
  const outcome = state.hooks?.onBeforeSettle
    ? await state.hooks.onBeforeSettle(interrupted, state.releaseReservation)
    : interrupted;
  if (outcome.finishReason !== 'user_cancelled') return null;
  await state.releaseReservation();
  state.saveHistory({
    assistant_reply: null,
    status: 'stream_interrupted',
    generation_id: null,
    finish_reason: outcome.finishReason,
  });
  return finish(
    state,
    failed(state, {
      status: 'stream_interrupted',
      chargeId: state.chargeId,
      finishReason: outcome.finishReason,
    })
  );
}

async function handleDispatchFailure(state: Execution, err: unknown): Promise<GenerationResult> {
  const { signal, observation, request, log, hooks } = state;
  if (signal.aborted) {
    observation.signalOutcome =
      signal.reason instanceof FirstTokenDeadlineError || signal.reason?.name === 'TimeoutError'
        ? 'timeout'
        : 'cancelled';
    const settleAbort = state.settleAbortedBeforeStream;
    state.settleAbortedBeforeStream = undefined;
    const stopped = await settleAbort?.();
    if (stopped) return stopped;
  }
  await state.releaseReservation();
  log.sys.error(
    {
      event: 'llm.upstream.error',
      err,
      userId: request.userId,
      sessionId: request.sessionId ?? null,
      provider: state.billing.provider,
      model: state.billing.providerModelId,
    },
    'upstream request failed'
  );
  hooks?.onError?.(toError(err));
  if (err instanceof FirstTokenDeadlineError || signal.reason instanceof FirstTokenDeadlineError)
    throw err instanceof FirstTokenDeadlineError ? err : signal.reason;
  return finish(state, failed(state));
}

async function rejectResponse(state: Execution, response: Response): Promise<GenerationResult> {
  await state.releaseReservation();
  await response.body?.cancel().catch(() => undefined);
  state.log.sys.error(
    {
      event: 'llm.upstream.rejected',
      userId: state.request.userId,
      sessionId: state.request.sessionId ?? null,
      provider: state.billing.provider,
      model: state.billing.providerModelId,
      upstreamStatus: response.status,
    },
    'upstream rejected generation'
  );
  state.saveHistory({
    assistant_reply: null,
    status: 'upstream_error',
    upstream_status: response.status,
    generation_id: null,
    finish_reason: null,
  });
  state.hooks?.onError?.(new Error(`upstream ${response.status}`));
  return finish(state, failed(state, { upstreamStatus: response.status }));
}

async function emptyResponse(
  state: Execution,
  generationId: string | null
): Promise<GenerationResult> {
  await state.releaseReservation();
  state.saveHistory({
    assistant_reply: null,
    status: 'stream_interrupted',
    upstream_status: null,
    generation_id: generationId,
    finish_reason: null,
  });
  return finish(
    state,
    failed(state, { status: 'stream_interrupted', generationId, chargeId: state.chargeId })
  );
}

function failed(state: Execution, overrides: Partial<GenerationResult> = {}): GenerationResult {
  return {
    status: 'upstream_error',
    content: '',
    generationId: null,
    finishReason: null,
    chargeId: null,
    modelId: state.billing.modelId,
    modelOpenRouterId: state.billing.openRouterModelId,
    ...overrides,
  };
}
function finish(state: Execution, result: GenerationResult): GenerationResult {
  state.hooks?.onDone?.(result);
  return result;
}

/** Abort only speculative reads; quota and identity writes retain their completion. */
function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
