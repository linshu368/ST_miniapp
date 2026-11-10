import type { ModelBillingContext } from '../../platform/model-tiers.js';
import { settleGeneration, type GenerationSettlementEntry } from './settle.js';
import type { FreeQuotaReservation } from './quota.js';
import type { BillingPlan } from './precheck.js';
import type { SseTapResult } from './upstream.js';
import type { GenerationRequest, GenerationLogger } from './types.js';
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

export function hasCompletedReply(result: Pick<SseTapResult, 'completed' | 'content'>) {
  return result.completed && result.content.trim().length > 0;
}

/** 只有明确自然结束的有效回复才可进入计费资格判断。 */
function isBillableReply(result: Pick<SseTapResult, 'completed' | 'content' | 'finishReason'>) {
  return hasCompletedReply(result) && result.finishReason === 'stop';
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

/**
 * 流终态：完整交付与扣费终态分开判断。finish_reason 暂缺时保留免费额度预留，
 * 让 chat history 同步任务拿到 OpenRouter 的真实终态后再消费或释放。
 */
export async function settleStream(input: {
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
