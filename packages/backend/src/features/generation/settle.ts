/**
 * backend / features / generation / settle.ts
 *
 * 生成出口的终态结算段：**星尘实扣就发生在这里**，是 execute.ts 的最后一步。
 *
 *   补 OpenRouter 用量元数据 → 实扣（charge_llm_usage）→ 免费额度收口
 *   → 回写 chat_history 的计费列 → 累加轮次并触发邀请奖励检查
 *
 * 为什么是 fire-and-forget：第一步要等 OpenRouter 的异步用量统计（约 1.5 秒起），
 * 挂在请求里会让用户在回复已经流完之后仍然等着。所以 SSE 收流后立即返回，
 * 结算在后台跑完；失败只打日志，不影响这一轮已经交付给用户的回复。
 *
 * 与请求内同步的 finalizeTurn 分写同一行的不同列（列归属见
 * ConversationHistoryRepository 头注释），因此两者谁先落地都不会互相覆盖。
 *
 * finish_reason 还没到时不在这里定结论：挂 pending 交给 sync-job.ts 回捞后结算。
 */

import type { FastifyBaseLogger } from 'fastify';
import { getDomainDb } from '../../lib/supabase.js';
import { ConversationHistoryRepository } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { MiniappCharacterFreeQuotaRepository } from '../../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import {
  getInitialBillingDecision,
  resolveUsageBillingGate,
  shouldRecordUsageCharge,
  type FixedDeductionCategory,
} from '../billing/usage-pricing.js';
import {
  buildGenerationMetadata,
  fetchGenerationDataForSettlement,
  type GenerationData,
} from './openrouter-metadata.js';

/**
 * 一轮生成结算所需的全部输入。
 *
 * 身份与轮次列（user_id / model / user_input / history / character_id / session_id）
 * 在开轮 RPC 建行时就已落库，这里带着它们只是为了日志与计费快照，**不再回写**。
 */
export interface GenerationSettlementEntry {
  user_id: string | null;
  model: string;
  charge_id: string;
  model_id: string | null;
  model_display_name: string;
  model_markup: number;
  fixed_deduction: number;
  fixed_deduction_category: FixedDeductionCategory;
  catalog_version: number;
  pricing_config_version: number;
  exchange_rate: number;
  user_input: string;
  assistant_reply: string | null;
  history: unknown[];
  character_id?: string | null;
  session_id?: string | null;
  /** 开轮 RPC 预建的轮次行 id；结算结果回写到这一行 */
  history_id?: string | null;
  status: 'success' | 'upstream_error' | 'stream_interrupted';
  upstream_status?: number | null;
  generation_id?: string | null;
  finish_reason?: string | null;
}

const wallets = new MiniappWalletRepository();
const freeQuotas = new MiniappCharacterFreeQuotaRepository();
let historyRepository: ConversationHistoryRepository | null = null;

function history(): ConversationHistoryRepository {
  return (historyRepository ??= new ConversationHistoryRepository());
}

type ReplyOutcome = 'complete' | 'incomplete' | 'empty';

function resolveReplyOutcome(
  entry: GenerationSettlementEntry,
  finishReason: string | null
): ReplyOutcome {
  const hasContent = (entry.assistant_reply ?? '').trim().length > 0;
  if (!hasContent) return 'empty';
  if (entry.status === 'success' && (finishReason === 'stop' || finishReason === null)) {
    return 'complete';
  }
  return 'incomplete';
}

async function checkInviteChatRoundsReward(userId: string, log: FastifyBaseLogger): Promise<void> {
  const { data, error } = await getDomainDb('miniapp_traffic').rpc(
    'check_invite_chat_rounds_reward',
    {
      p_invitee_user_id: userId,
    }
  );

  if (error) {
    log.error(
      { kind: 'sys', event: 'chathistory.invite_reward.check_failed', err: error, userId },
      'invite chat-round reward check failed'
    );
    return;
  }

  const row = (
    data as Array<{
      status: string;
      credits: number;
      total_round: number;
      threshold_rounds: number;
    }>
  )?.[0];
  if (row?.status === 'granted') {
    log.info(
      {
        kind: 'biz',
        event: 'chathistory.invite_reward.granted',
        userId,
        credits: Number(row.credits),
        totalRound: Number(row.total_round),
        thresholdRounds: Number(row.threshold_rounds),
      },
      'invite chat-round reward granted'
    );
  }
}

/**
 * 结算一轮生成。fire-and-forget：调用方不 await，异常一律内部消化。
 */
export function settleGeneration(entry: GenerationSettlementEntry, log: FastifyBaseLogger): void {
  const clog = log.child({ module: 'generation-settle' });
  void (async () => {
    try {
      await runSettlement(entry, clog);
    } catch (err: unknown) {
      clog.error(
        { kind: 'sys', event: 'chathistory.unexpected', err, userId: entry.user_id },
        'unexpected error'
      );
    }
  })();
}

async function runSettlement(
  entry: GenerationSettlementEntry,
  clog: FastifyBaseLogger
): Promise<void> {
  // 只有可能扣费的轮次才值得等上游统计；免费轮拿了也用不上。
  const wantsUsageData = Boolean(entry.generation_id) && entry.fixed_deduction > 0;
  let llmMetadata: Record<string, unknown> = {};
  let finishReason = entry.finish_reason ?? null;

  if (wantsUsageData) {
    const genData = await fetchUsageData(entry.generation_id as string, clog);
    if (genData) {
      llmMetadata = buildGenerationMetadata(genData);
      if (typeof genData.finish_reason === 'string') {
        // 上游的 finish_reason 比 SSE tap 的观测值权威，拿到就用它。
        finishReason = genData.finish_reason;
      } else {
        // 上游统计还没给出 finish_reason。这一列归 finalizeTurn（写的是 tap 观测值），
        // 这里不能把它覆盖成 null——那会抹掉一个已知正确的值，还会让本行反复被回捞。
        delete llmMetadata.llm_finish_reason;
      }
    }
  }

  if (!entry.user_id) {
    throw new Error('production chat history requires user_id');
  }

  let actualDeduction = 0;

  // 每轮生成都保留一条明细；只有 finish_reason=stop 的正常完整回复才扣星尘。
  if (shouldRecordUsageCharge(entry.status)) {
    actualDeduction = await chargeRound({ entry, llmMetadata, finishReason, clog });
  }

  if (!entry.history_id) {
    clog.error(
      {
        kind: 'sys',
        event: 'chathistory.update.missing_id',
        userId: entry.user_id,
        model: entry.model,
      },
      'missing history_id'
    );
    return;
  }

  try {
    await history().recordBillingOutcome({
      historyId: entry.history_id,
      deductionRate: actualDeduction,
      metadata: llmMetadata,
    });
  } catch (err) {
    clog.error(
      {
        kind: 'sys',
        event: 'chathistory.update.failed',
        err,
        userId: entry.user_id,
        model: entry.model,
      },
      'update failed'
    );
    return;
  }

  clog.info(
    { kind: 'biz', event: 'chathistory.saved', userId: entry.user_id, model: entry.model },
    'saved'
  );

  if (entry.status !== 'success') return;

  // total_round 回写 app_core.users 与 app_core.miniapp_user_settings
  // （归属地图裁决 6 的存量豁免：chat_history 属 experience，计数落 app_core）。
  const { error: roundErr } = await getDomainDb('app_core').rpc('increment_user_total_round', {
    p_user_id: entry.user_id,
    p_delta: 1,
  });
  if (roundErr) {
    clog.error(
      {
        kind: 'sys',
        event: 'chathistory.round.increment_failed',
        err: roundErr,
        userId: entry.user_id,
      },
      'increment total_round failed'
    );
    return;
  }

  await checkInviteChatRoundsReward(entry.user_id, clog);
}

/** 拉用量统计。拿不到不是错误——sync-job 会在 24h 窗口内继续补。 */
async function fetchUsageData(
  generationId: string,
  clog: FastifyBaseLogger
): Promise<GenerationData | null> {
  try {
    const genData = await fetchGenerationDataForSettlement(generationId);
    if (!genData || genData.error) {
      clog.warn(
        {
          kind: 'sys',
          event: 'chathistory.generation.fetch_incomplete',
          generationId,
          err: genData?.error ?? null,
        },
        'usage data not available yet, leaving it to the sync job'
      );
    }
    return genData;
  } catch (err) {
    clog.error(
      { kind: 'sys', event: 'chathistory.generation.fetch_error', err, generationId },
      'error during generation data fetch'
    );
    return null;
  }
}

/** 实扣与免费额度收口。返回真实扣减额，回写进 chat_history.deduction_rate。 */
async function chargeRound(input: {
  entry: GenerationSettlementEntry;
  llmMetadata: Record<string, unknown>;
  finishReason: string | null;
  clog: FastifyBaseLogger;
}): Promise<number> {
  const { entry, llmMetadata, finishReason, clog } = input;
  const userId = entry.user_id as string;
  const usageCost = llmMetadata.llm_usage;
  const replyOutcome = resolveReplyOutcome(entry, finishReason);

  // 已经拿到 generation id、但 finish_reason 尚未同步时必须先保持待结算。
  // generation_status 保留真实生成终态，chat_status 仅作为现有计费 RPC 的闸门输入。
  const billingStatus = finishReason === null && entry.generation_id ? 'success' : entry.status;
  const billingGate = resolveUsageBillingGate({ status: billingStatus, finishReason });
  const billingDecision = getInitialBillingDecision({
    usageCost,
    exchangeRate: entry.exchange_rate,
    modelMarkup: entry.model_markup,
    fixedDeduction: entry.fixed_deduction,
  });
  const { hasActualUsage } = billingDecision;
  const intendedDeduction = billingDecision.amount;
  llmMetadata.llm_intended_deduction = intendedDeduction;

  try {
    const actualModel =
      typeof llmMetadata.llm_model === 'string' && llmMetadata.llm_model.trim()
        ? llmMetadata.llm_model
        : entry.model;
    const routedToDifferentModel = actualModel !== entry.model;
    const result = await wallets.chargeLlmUsage({
      chargeId: entry.charge_id,
      generationId: entry.generation_id ?? null,
      userId,
      modelId: entry.model_id,
      modelOpenRouterId: actualModel,
      modelDisplayName: routedToDifferentModel ? actualModel : entry.model_display_name,
      catalogVersion: entry.catalog_version,
      pricingConfigVersion: entry.pricing_config_version,
      usageCostUsd: hasActualUsage ? (usageCost as number) : null,
      exchangeRate: entry.exchange_rate,
      modelMarkup: entry.model_markup,
      calculatedAmount: intendedDeduction,
      fallbackUsed: billingDecision.pending,
      metadata: {
        chat_status: billingStatus,
        generation_status: entry.status,
        reply_outcome: replyOutcome,
        reply_char_count: (entry.assistant_reply ?? '').length,
        requested_model: entry.model,
        billing_mode: 'fixed_tier',
        billing_gate: billingGate,
        finish_reason: finishReason,
        fixed_deduction_category: entry.fixed_deduction_category,
        fixed_deduction: entry.fixed_deduction,
      },
    });
    const actualDeduction = Number(result.charge.charged_amount);

    if (finishReason !== null) {
      await freeQuotas.finalizePending(
        entry.charge_id,
        replyOutcome === 'complete' && finishReason === 'stop'
      );
    }

    clog.info(
      {
        kind: 'biz',
        event: 'chathistory.billing.recorded',
        userId,
        chargeId: entry.charge_id,
        intendedAmount: intendedDeduction,
        chargedAmount: actualDeduction,
        pending: billingDecision.pending,
      },
      'LLM usage billing record created'
    );
    return actualDeduction;
  } catch (chargeErr) {
    clog.error(
      {
        kind: 'sys',
        event: 'chathistory.billing.failed',
        err: chargeErr,
        userId,
        chargeId: entry.charge_id,
      },
      'atomic LLM usage charge failed'
    );
    return 0;
  }
}
