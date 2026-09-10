/**
 * backend / features / generation / apply-charge.ts
 *
 * settle.ts 即时结算与 sync-job.ts 回捞共用的定档扣费拼装：
 *   - resolveReplyOutcome：回复体验口径（complete / incomplete / empty）；
 *   - resolveBillingChatStatus：RPC 闸门输入 chat_status
 *     （finish_reason 未到且有 generation_id 时报 'success'，其余用生成终态原样）；
 *   - 免费额度收口条件（complete 且 finish_reason=stop）只写一遍。
 *
 * 回捞路径已按 settle 口径接入：success + length/content_filter 是 incomplete，
 * 不再因为 chat_history.status=success 就打 complete。金额仍由 RPC 按
 * chat_status + finish_reason 决定（081），charge_id 幂等，不会多扣。
 *
 * 金额判定不在应用层：charge_llm_usage RPC 按 metadata 的 chat_status + finish_reason
 * 自行计算（见 081_finish_reason_billing_gate.sql）。
 */

import { MiniappCharacterFreeQuotaRepository } from '../../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import { resolveUsageBillingGate } from '../billing/usage-pricing.js';

export type ReplyOutcome = 'complete' | 'incomplete' | 'empty';

const wallets = new MiniappWalletRepository();
const freeQuotas = new MiniappCharacterFreeQuotaRepository();

/**
 * 回复体验口径。complete 要求生成终态 success 且 finish_reason 是自然收尾
 * （'stop'）或尚未到齐（null，交给回捞后重判）。
 */
export function resolveReplyOutcome(input: {
  assistantReply: string | null;
  generationStatus: string;
  finishReason: string | null;
}): ReplyOutcome {
  const hasContent = (input.assistantReply ?? '').trim().length > 0;
  if (!hasContent) return 'empty';
  if (
    input.generationStatus === 'success' &&
    (input.finishReason === 'stop' || input.finishReason === null)
  ) {
    return 'complete';
  }
  return 'incomplete';
}

/**
 * RPC 闸门输入 chat_status。与抽出前 settle chargeRound 相同：
 * finish_reason 未到但已拿到 generation_id 时报 'success'，让 RPC 判
 * pending_finish_reason 等回捞；其余情形原样使用生成终态。
 */
export function resolveBillingChatStatus(input: {
  generationStatus: string;
  finishReason: string | null;
  generationId: string | null;
}): string {
  return input.finishReason === null && input.generationId ? 'success' : input.generationStatus;
}

export interface LlmChargeCommand {
  chargeId: string;
  generationId: string | null;
  userId: string;
  modelId: string | null;
  /** 本轮请求的 OpenRouter 模型 id */
  requestedModel: string;
  /** 用量元数据里观测到的实际模型（上游可能路由到别家）；未知传 null */
  observedModel: string | null;
  requestedDisplayName: string;
  catalogVersion: number;
  pricingConfigVersion: number;
  usageCostUsd: number | null;
  exchangeRate: number;
  modelMarkup: number;
  calculatedAmount: number;
  fallbackUsed: boolean;
  /** 生成终态（success / upstream_error / stream_interrupted） */
  generationStatus: string;
  finishReason: string | null;
  assistantReply: string | null;
  /**
   * 路径专属的附加 metadata，先铺底再被统一字段覆盖。
   * settle 传 billing_mode / fixed_deduction_* / requested_model；
   * sync-job 铺原 charge metadata + source: chat_history_sync。
   */
  baseMetadata?: Record<string, unknown>;
}

export interface LlmChargeResult {
  replyOutcome: ReplyOutcome;
  billingChatStatus: string;
  /** RPC 实际扣减额 */
  chargedAmount: number;
  /** RPC 记录的应扣额 */
  calculatedAmount: number;
}

/**
 * 结算一笔 LLM 定档扣费：闸门标签 → charge_llm_usage → 免费额度收口。
 * 异常原样抛出：settle 消化打日志并返回 0；sync-job 冒泡以便下一轮重试。
 */
export async function applyLlmCharge(command: LlmChargeCommand): Promise<LlmChargeResult> {
  const replyOutcome = resolveReplyOutcome({
    assistantReply: command.assistantReply,
    generationStatus: command.generationStatus,
    finishReason: command.finishReason,
  });
  const billingChatStatus = resolveBillingChatStatus({
    generationStatus: command.generationStatus,
    finishReason: command.finishReason,
    generationId: command.generationId,
  });

  const observed = command.observedModel?.trim() ? command.observedModel : null;
  const actualModel = observed ?? command.requestedModel;
  const routedToDifferentModel = actualModel !== command.requestedModel;

  const result = await wallets.chargeLlmUsage({
    chargeId: command.chargeId,
    generationId: command.generationId,
    userId: command.userId,
    modelId: command.modelId,
    modelOpenRouterId: actualModel,
    modelDisplayName: routedToDifferentModel ? actualModel : command.requestedDisplayName,
    catalogVersion: command.catalogVersion,
    pricingConfigVersion: command.pricingConfigVersion,
    usageCostUsd: command.usageCostUsd,
    exchangeRate: command.exchangeRate,
    modelMarkup: command.modelMarkup,
    calculatedAmount: command.calculatedAmount,
    fallbackUsed: command.fallbackUsed,
    metadata: {
      ...(command.baseMetadata ?? {}),
      chat_status: billingChatStatus,
      generation_status: command.generationStatus,
      reply_outcome: replyOutcome,
      reply_char_count: (command.assistantReply ?? '').length,
      finish_reason: command.finishReason,
      billing_gate: resolveUsageBillingGate({
        status: billingChatStatus,
        finishReason: command.finishReason,
      }),
    },
  });

  // 免费额度两阶段收口：只有自然收尾的完整回复才消费预留，其余释放。
  // finish_reason 未到时保持预留，等回捞拿到终态后再走到这里。
  if (command.finishReason !== null) {
    await freeQuotas.finalizePending(
      command.chargeId,
      replyOutcome === 'complete' && command.finishReason === 'stop'
    );
  }

  return {
    replyOutcome,
    billingChatStatus,
    chargedAmount: Number(result.charge.charged_amount),
    calculatedAmount: Number(result.charge.calculated_amount),
  };
}
