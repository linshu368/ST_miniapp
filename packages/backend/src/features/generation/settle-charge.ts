import type { FastifyBaseLogger } from 'fastify';
import type { GenerationSettlementEntry } from './settle.js';
import type { OpenRouterGenerationMetadata } from './openrouter-metadata.js';
import { getInitialBillingDecision } from '../billing/usage-pricing.js';
import { applyLlmCharge } from './apply-charge.js';
import { frozenLlmChargeMetadata } from './text-billing.js';
import { WalletInsufficientBalanceError } from '../../infrastructure/repositories/wallet-errors.js';

/** 实扣与免费额度收口。settled 表示已不在等 finish_reason，可以打结算完成。 */
export async function chargeRound(input: {
  entry: GenerationSettlementEntry;
  providerMetadata: OpenRouterGenerationMetadata | null;
  finishReason: string | null;
  clog: FastifyBaseLogger;
}): Promise<{ chargedAmount: number; intendedDeduction: number; settled: boolean }> {
  const { entry, providerMetadata, finishReason, clog } = input;
  if ((entry.provider ?? 'openrouter') !== 'openrouter' && finishReason === null) {
    return { chargedAmount: 0, intendedDeduction: 0, settled: true };
  }
  const userId = entry.user_id as string;
  const usageCost = providerMetadata?.usage;
  const billingDecision = getInitialBillingDecision({
    usageCost,
    exchangeRate: entry.exchange_rate,
    modelMarkup: entry.model_markup,
    fixedDeduction: entry.fixed_deduction,
  });
  const { hasActualUsage } = billingDecision;
  const intendedDeduction = billingDecision.amount;

  const observedModel =
    typeof providerMetadata?.model === 'string' && providerMetadata.model.trim()
      ? providerMetadata.model
      : null;
  const waitingForFinishReason =
    (entry.provider ?? 'openrouter') === 'openrouter' &&
    finishReason === null &&
    Boolean(entry.generation_id);

  try {
    const result = await applyLlmCharge({
      chargeId: entry.charge_id,
      generationId: entry.generation_id ?? null,
      userId,
      modelId: entry.model_id,
      requestedModel: entry.model,
      observedModel,
      requestedDisplayName: entry.model_display_name,
      catalogVersion: entry.catalog_version,
      pricingConfigVersion: entry.pricing_config_version,
      usageCostUsd: hasActualUsage ? (usageCost as number) : null,
      exchangeRate: entry.exchange_rate,
      modelMarkup: entry.model_markup,
      calculatedAmount: intendedDeduction,
      fallbackUsed: billingDecision.pending,
      generationStatus: entry.status,
      finishReason,
      assistantReply: entry.assistant_reply,
      baseMetadata: {
        requested_model: entry.model,
        provider: entry.provider ?? 'openrouter',
        provider_model_id: entry.provider_model_id ?? entry.model,
        ...frozenLlmChargeMetadata(entry),
      },
    });

    clog.info(
      {
        kind: 'biz',
        event: 'chathistory.billing.recorded',
        userId,
        chargeId: entry.charge_id,
        intendedAmount: intendedDeduction,
        chargedAmount: result.chargedAmount,
        pending: billingDecision.pending,
      },
      'LLM usage billing record created'
    );
    return {
      chargedAmount: result.chargedAmount,
      intendedDeduction,
      settled: !waitingForFinishReason && !result.pending,
    };
  } catch (chargeErr) {
    if (chargeErr instanceof WalletInsufficientBalanceError) {
      clog.info(
        {
          kind: 'biz',
          event: 'chathistory.billing.balance_rejected',
          outcome: 'rejected',
          error_code: 'INSUFFICIENT_BALANCE',
          userId,
        },
        '余额不足，账单已失败'
      );
      return { chargedAmount: 0, intendedDeduction, settled: true };
    }
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
    return { chargedAmount: 0, intendedDeduction, settled: false };
  }
}
