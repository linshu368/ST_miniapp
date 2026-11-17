import { LlmModelProviderSchema, type LlmModelProvider } from '@miniapp/shared';
import type {
  ChatHistorySyncRow,
  LlmBillingSnapshot,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import { calculateUsageDeduction } from '../billing/usage-pricing.js';
import { applyLlmCharge } from './apply-charge.js';
import { frozenLlmChargeMetadata } from './text-billing.js';
import { readCreatorRewardSnapshot } from './creator-billing.js';

let walletRepository: MiniappWalletRepository | null = null;
function wallets(): MiniappWalletRepository {
  return (walletRepository ??= new MiniappWalletRepository());
}

export interface ReconciledChargeResult {
  settled: boolean;
  intendedDeduction?: number;
  deductionRate?: number;
}

/**
 * 结算这一行对应的计费记录，单独返回主表金额，保留上游元数据不变。
 *
 * 定档：finish_reason 到齐后走 applyLlmCharge（与 settle 同一套标签）。
 * 无 charge 行时按请求时快照重建；已 charged / free 的行也重入以补额度收口和金额回写。
 * 历史 usage 口径仍走 reconcileLlmUsage。都靠 charge_id 幂等，重复跑不会多扣。
 *
 * 导出给单测：锁死回捞后 success + length 是 incomplete，而不是旧的 complete。
 */
export async function reconcileCharge(input: {
  record: Pick<
    ChatHistorySyncRow,
    | 'id'
    | 'user_id'
    | 'model'
    | 'llm_charge_id'
    | 'assistant_reply'
    | 'status'
    | 'llm_billing_snapshot'
  > & { callProvider?: LlmModelProvider | null };
  generationId: string | null;
  genData: Record<string, unknown>;
  finishReason: string | null;
}): Promise<ReconciledChargeResult> {
  const { record, generationId, genData, finishReason } = input;
  const chargeId = record.llm_charge_id;
  if (typeof chargeId !== 'string' || chargeId.length === 0) return { settled: false };

  const usageCost = genData.usage;
  const snapshot = readBillingSnapshot(
    record.llm_billing_snapshot,
    record.callProvider ?? undefined
  );
  const originalCharge = await wallets().findLlmUsageCharge(chargeId);

  if (originalCharge && originalCharge.metadata?.billing_mode !== 'fixed_tier') {
    if (typeof usageCost === 'number' && Number.isFinite(usageCost) && finishReason === 'stop') {
      const intendedDeduction = calculateUsageDeduction(
        usageCost,
        Number(originalCharge.exchange_rate),
        Number(originalCharge.model_markup)
      );
      const reconciled = await wallets().reconcileLlmUsage({
        chargeId,
        usageCostUsd: usageCost,
        calculatedAmount: intendedDeduction,
        metadata: { source: 'chat_history_sync' },
      });
      return {
        settled: true,
        intendedDeduction,
        deductionRate: Number(reconciled.charge.charged_amount),
      };
    }
    return { settled: false };
  }

  if (finishReason === null) return { settled: false };

  const command = buildFixedTierChargeCommand({
    chargeId,
    generationId,
    record,
    genData,
    finishReason,
    snapshot,
    originalCharge,
    usageCost,
  });
  if (!command) return { settled: false };

  const result = await applyLlmCharge(command);
  return {
    settled: !result.pending,
    intendedDeduction: result.calculatedAmount,
    deductionRate: result.chargedAmount,
  };
}

function buildFixedTierChargeCommand(input: {
  chargeId: string;
  generationId: string | null;
  record: Pick<ChatHistorySyncRow, 'user_id' | 'model' | 'assistant_reply' | 'status'>;
  genData: Record<string, unknown>;
  finishReason: string;
  snapshot: LlmBillingSnapshot | null;
  originalCharge: {
    user_id: string;
    model_id: string | null;
    model_openrouter_id: string;
    model_display_name: string;
    catalog_version: number;
    pricing_config_version: number;
    exchange_rate: unknown;
    model_markup: unknown;
    calculated_amount: unknown;
    metadata: Record<string, unknown> | null;
  } | null;
  usageCost: unknown;
}) {
  const {
    chargeId,
    generationId,
    record,
    genData,
    finishReason,
    snapshot,
    originalCharge,
    usageCost,
  } = input;
  if (!originalCharge && !snapshot) return null;

  const userId = originalCharge?.user_id ?? record.user_id;
  if (typeof userId !== 'string' || userId.length === 0) return null;

  const displayName = (
    snapshot?.model_display_name ??
    originalCharge?.model_display_name ??
    ''
  ).trim();
  if (!displayName) return null;

  const requestedModel = originalCharge?.model_openrouter_id ?? record.model;
  if (typeof requestedModel !== 'string' || requestedModel.trim() === '') return null;

  const fixedDeduction = resolveFixedDeductionAmount(snapshot, originalCharge);
  const observedModel =
    typeof genData.model === 'string' && genData.model.trim() ? genData.model : null;

  return {
    chargeId,
    generationId,
    userId,
    modelId: snapshot?.model_id ?? originalCharge?.model_id ?? null,
    requestedModel,
    observedModel,
    requestedDisplayName: displayName,
    catalogVersion: originalCharge?.catalog_version ?? snapshot?.catalog_version ?? 0,
    pricingConfigVersion:
      originalCharge?.pricing_config_version ?? snapshot?.pricing_config_version ?? 0,
    usageCostUsd: typeof usageCost === 'number' && Number.isFinite(usageCost) ? usageCost : null,
    exchangeRate: Number(originalCharge?.exchange_rate ?? snapshot?.exchange_rate ?? 1),
    modelMarkup: Number(originalCharge?.model_markup ?? snapshot?.model_markup ?? 0),
    calculatedAmount: fixedDeduction,
    fallbackUsed: false,
    generationStatus: record.status,
    finishReason,
    assistantReply: record.assistant_reply,
    baseMetadata: {
      ...(originalCharge?.metadata ?? {}),
      requested_model: requestedModel,
      provider:
        snapshot?.provider ||
        (typeof originalCharge?.metadata?.provider === 'string'
          ? originalCharge.metadata.provider
          : 'openrouter'),
      provider_model_id:
        snapshot?.provider_model_id ||
        (typeof originalCharge?.metadata?.provider_model_id === 'string'
          ? originalCharge.metadata.provider_model_id
          : requestedModel),
      ...frozenLlmChargeMetadata({
        fixed_deduction: fixedDeduction,
        fixed_deduction_category:
          snapshot?.fixed_deduction_category ||
          (typeof originalCharge?.metadata?.fixed_deduction_category === 'string'
            ? originalCharge.metadata.fixed_deduction_category
            : ''),
        original_credits: snapshot?.original_credits,
        discount_rate: snapshot?.discount_rate,
        discounted_exact: snapshot?.discounted_exact,
        payable_credits: snapshot?.payable_credits ?? fixedDeduction,
        wallet_policy: snapshot?.wallet_policy,
        requires_vip: snapshot?.requires_vip,
        vip_active: snapshot?.vip_active,
        vip_valid_until: snapshot?.vip_valid_until,
        model_tier: snapshot?.model_tier,
        vip_discount_config_version: snapshot?.vip_discount_config_version,
        creator_reward:
          snapshot?.creator_reward ??
          readCreatorRewardSnapshot(originalCharge?.metadata?.creator_reward),
      }),
      source: 'chat_history_sync',
    },
  };
}

function resolveFixedDeductionAmount(
  snapshot: LlmBillingSnapshot | null,
  charge: { metadata?: Record<string, unknown> | null; calculated_amount: unknown } | null
): number {
  if (snapshot && Number.isFinite(snapshot.fixed_deduction) && snapshot.fixed_deduction >= 0) {
    return snapshot.fixed_deduction;
  }
  if (!charge) return 0;
  const fromMeta = Number(charge.metadata?.fixed_deduction ?? charge.calculated_amount);
  return Number.isFinite(fromMeta) && fromMeta >= 0 ? fromMeta : 0;
}

function readBillingSnapshot(
  value: unknown,
  provider?: LlmModelProvider
): LlmBillingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.billing_mode !== undefined && row.billing_mode !== 'fixed_tier') return null;

  const modelDisplayName =
    typeof row.model_display_name === 'string' ? row.model_display_name.trim() : '';
  if (!modelDisplayName) return null;

  const fixedDeduction = Number(row.fixed_deduction);
  const catalogVersion = Number(row.catalog_version);
  const pricingConfigVersion = Number(row.pricing_config_version);
  const exchangeRate = Number(row.exchange_rate);
  const modelMarkup = Number(row.model_markup);
  if (!Number.isFinite(fixedDeduction) || fixedDeduction < 0) return null;
  if (!Number.isInteger(catalogVersion) || !Number.isInteger(pricingConfigVersion)) return null;
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return null;
  if (!Number.isFinite(modelMarkup) || modelMarkup < 0) return null;

  return {
    charge_id: typeof row.charge_id === 'string' ? row.charge_id : '',
    model_id: typeof row.model_id === 'string' ? row.model_id : null,
    provider: provider ?? readProviderFromSnapshot(row),
    provider_model_id:
      typeof row.provider_model_id === 'string' && row.provider_model_id.trim()
        ? row.provider_model_id
        : undefined,
    model_display_name: modelDisplayName,
    model_markup: modelMarkup,
    fixed_deduction: fixedDeduction,
    fixed_deduction_category:
      typeof row.fixed_deduction_category === 'string' ? row.fixed_deduction_category : '',
    catalog_version: catalogVersion,
    pricing_config_version: pricingConfigVersion,
    exchange_rate: exchangeRate,
    billing_mode: 'fixed_tier',
    ...readFrozenPriceFields(row),
  };
}

function readProviderFromSnapshot(value: unknown): LlmModelProvider {
  if (!value || typeof value !== 'object') return 'openrouter';
  const row = value as Record<string, unknown>;
  const parsed = LlmModelProviderSchema.safeParse(row.provider);
  return parsed.success ? parsed.data : 'openrouter';
}

function readFrozenPriceFields(
  row: Record<string, unknown>
): Pick<
  LlmBillingSnapshot,
  | 'original_credits'
  | 'discount_rate'
  | 'discounted_exact'
  | 'payable_credits'
  | 'wallet_policy'
  | 'requires_vip'
  | 'vip_active'
  | 'vip_valid_until'
  | 'model_tier'
  | 'vip_discount_config_version'
  | 'creator_reward'
> {
  const originalCredits = readOptionalNumber(row.original_credits);
  const payableCredits = readOptionalNumber(row.payable_credits);
  const discountedExact = readOptionalNumber(row.discounted_exact);
  const walletPolicy =
    row.wallet_policy === 'main_only' || row.wallet_policy === 'main_then_bonus'
      ? row.wallet_policy
      : undefined;
  return {
    ...(originalCredits === undefined ? {} : { original_credits: originalCredits }),
    ...(row.discount_rate === null || typeof row.discount_rate === 'number'
      ? { discount_rate: row.discount_rate }
      : {}),
    ...(discountedExact === undefined ? {} : { discounted_exact: discountedExact }),
    ...(payableCredits === undefined ? {} : { payable_credits: payableCredits }),
    ...(walletPolicy === undefined ? {} : { wallet_policy: walletPolicy }),
    ...(typeof row.requires_vip === 'boolean' ? { requires_vip: row.requires_vip } : {}),
    ...(typeof row.vip_active === 'boolean' ? { vip_active: row.vip_active } : {}),
    ...(row.vip_valid_until === null || typeof row.vip_valid_until === 'string'
      ? { vip_valid_until: row.vip_valid_until }
      : {}),
    ...(typeof row.model_tier === 'string' ? { model_tier: row.model_tier } : {}),
    ...(row.vip_discount_config_version === null ||
    typeof row.vip_discount_config_version === 'number'
      ? { vip_discount_config_version: row.vip_discount_config_version }
      : {}),
    ...(row.creator_reward === undefined
      ? {}
      : { creator_reward: readCreatorRewardSnapshot(row.creator_reward) }),
  };
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
