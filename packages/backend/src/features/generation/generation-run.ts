/**
 * 一次生成内共享的结算写入与错误归一。
 */

import { settleGeneration, type GenerationSettlementEntry } from './settle.js';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import type { BillingPlan } from './precheck.js';
import type { GenerationLogger, GenerationRequest } from './types.js';

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
