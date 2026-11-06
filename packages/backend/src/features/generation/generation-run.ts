/**
 * 一次生成调用内共享的状态（GenerationRun）与准入阶段：报价、VIP 门槛、余额预检、上游密钥。
 */

import { LLM_PROVIDER_CAPABILITIES } from '@miniapp/shared';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import { checkWalletBalance, resolveBillingPlan, type BillingPlan } from './precheck.js';
import type { FreeQuotaReservation } from './quota.js';
import { settleGeneration, type GenerationSettlementEntry } from './settle.js';
import { GenerationCleanupPendingError } from './types.js';
import { resolveProviderUpstream } from './upstream.js';
import type {
  GenerationHooks,
  GenerationLogger,
  GenerationPreparation,
  GenerationRequest,
  GenerationResult,
} from './types.js';

/** 一次生成里只有这五个字段随终态变化，其余结算入参全程固定。 */
export type HistoryOutcome = Pick<
  GenerationSettlementEntry,
  | 'assistant_reply'
  | 'status'
  | 'upstream_status'
  | 'generation_id'
  | 'finish_reason'
  | 'provider_response'
>;

export type SaveHistory = (outcome: HistoryOutcome) => void;

/** execute 的遥测状态：各阶段原地写入派发、首字与中止原因，execute 的 finally 统一上报。 */
export interface GenerationObservation {
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

/**
 * 单次 executeGeneration 调用内共享的状态，按引用传给各阶段函数。
 *
 * 会变的三项（兜底换模型后的 billing、竞速胜出方的身份写入、拿到流之前被中止时的结算）
 * 原本是闭包里的 let；放进同一个对象，阶段函数读到的永远是当前值，而不是拆分时拷下的快照。
 */
export interface GenerationRun {
  readonly request: GenerationRequest;
  readonly hooks: GenerationHooks | undefined;
  readonly log: GenerationLogger;
  readonly signal: AbortSignal;
  readonly chargeId: string;
  readonly prepared: GenerationPreparation;
  readonly reservation: FreeQuotaReservation;
  readonly observation: GenerationObservation;
  /** 报价与额度始终绑定所选模型；首字竞速换到兜底模型时只替换 provider 与 providerModelId。 */
  billing: ModelBillingContext;
  /** 竞速胜出方的生成身份写入；流结算前必须等它完成。 */
  deliveryPersisted: Promise<void>;
  /** 准入之后、开始读流之前被中止时的结算；派发失败已处理或进入流式消费后清空。 */
  settleAbortedBeforeStream: (() => Promise<GenerationResult | null>) | undefined;
  /** 释放免费额度预留，多次调用共用同一个结果。 */
  releaseReservation(): Promise<void>;
  /** 所有终态都经这里返回，保证 onDone 恰好触发一次。 */
  finish(result: GenerationResult): GenerationResult;
  failed(overrides?: Partial<GenerationResult>): GenerationResult;
}

/** 预热结果必须与本次请求同一模型、角色、付款人和 charge，否则说明调用方串用了别的请求的预热。 */
export function assertPreparedIdentity(
  prepared: GenerationPreparation,
  request: GenerationRequest,
  chargeId: string
): void {
  if (
    prepared.modelId !== request.model.modelId ||
    prepared.provider !== request.model.provider ||
    prepared.providerModelId !== request.model.providerModelId ||
    prepared.characterId !== request.characterId ||
    (prepared.paidAdmission &&
      (prepared.paidAdmission.userId !== request.userId ||
        prepared.paidAdmission.plan.chargeId !== chargeId ||
        prepared.selectedBilling.isFree))
  ) {
    throw new Error('Generation preparation identity differs');
  }
}

export function createGenerationRun(
  input: Pick<
    GenerationRun,
    'request' | 'hooks' | 'log' | 'signal' | 'chargeId' | 'prepared' | 'reservation' | 'observation'
  >
): GenerationRun {
  const { hooks, reservation } = input;
  let released: Promise<void> | undefined;
  const run: GenerationRun = {
    ...input,
    billing: input.prepared.selectedBilling,
    deliveryPersisted: Promise.resolve(),
    settleAbortedBeforeStream: undefined,
    releaseReservation: () =>
      (released ??= (async () => {
        const decision = await reservation.finalize(false);
        if (
          reservation.granted &&
          decision?.status !== 'released' &&
          decision?.status !== 'consumed'
        )
          throw new GenerationCleanupPendingError();
      })()),
    finish: (result) => {
      hooks?.onDone?.(result);
      return result;
    },
    failed: (overrides = {}) => ({
      status: 'upstream_error',
      content: '',
      generationId: null,
      finishReason: null,
      chargeId: null,
      modelId: run.billing.modelId,
      modelOpenRouterId: run.billing.openRouterModelId,
      ...overrides,
    }),
  };
  return run;
}

/** 付费轮复用预热时冻结的报价；免费轮和没有预热的请求按预留结果现算。 */
export function resolveRoundPlan(run: GenerationRun): BillingPlan {
  const { request, prepared, chargeId, log } = run;
  const { vipStrategy, creatorUserId } = prepared;
  return (
    prepared.paidAdmission?.plan ??
    resolveBillingPlan({
      chargeId,
      billing: run.billing,
      isFreeRound: run.reservation.isFreeRound,
      pricing: prepared.pricing,
      entitlement: request.model.entitlement,
      discountRate: vipStrategy.discountRate,
      discountConfigVersion: vipStrategy.discountVersion,
      ...(creatorUserId && request.characterId
        ? {
            creator: {
              characterId: request.characterId,
              creatorUserId,
              payerUserId: request.userId,
            },
          }
        : {}),
      log,
    })
  );
}

/** VIP 门槛与余额预检。拒绝时先释放预留再返回终态；放行返回 null。 */
export async function admitPaidRound(
  run: GenerationRun,
  plan: BillingPlan
): Promise<GenerationResult | null> {
  if (plan.snapshot.requires_vip && !plan.snapshot.vip_active) {
    await run.releaseReservation();
    return run.finish(run.failed({ denial: 'vip_required' }));
  }
  const precheck = await withAbort(
    run.prepared.paidAdmission?.balance ??
      checkWalletBalance({
        userId: run.request.userId,
        requiredAmount: plan.fixedDeduction.amount,
        walletPolicy: plan.snapshot.wallet_policy,
        openRouterModelId: run.billing.openRouterModelId,
        log: run.log,
      }),
    run.signal
  );
  if (precheck.ok) return null;
  await run.releaseReservation();
  return run.finish({
    status: 'insufficient_balance',
    content: '',
    generationId: null,
    finishReason: null,
    chargeId: null,
    modelId: run.billing.modelId,
    modelOpenRouterId: run.billing.openRouterModelId,
    balance: {
      creditsRequired: precheck.creditsRequired,
      creditsAvailable: precheck.creditsAvailable,
    },
  });
}

/** 缺 API key 是配置故障：释放预留、记系统错误，按上游失败收口；有 key 返回 null。 */
export async function failMissingUpstreamKey(run: GenerationRun): Promise<GenerationResult | null> {
  const { billing, request, log } = run;
  const upstream = resolveProviderUpstream(billing.provider);
  if (upstream.apiKey) return null;
  await run.releaseReservation();
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
  run.hooks?.onError?.(err);
  return run.finish(run.failed());
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** 结算入参的固定字段一次绑定，终态只补那五个会变的。 */
export function createHistoryWriter(input: {
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

/** Race only non-generation preparation; quota/CAS writes retain their real completion. */
export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
