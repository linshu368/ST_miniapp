/**
 * 文本模型的受理报价与资格判断。
 *
 * 折扣、取整和钱包策略只调用 shared 纯函数。原价必须由调用方从运行时配置传入，
 * 这里不保存 test 目录价。受理后的 payable 写入快照，sync 与 charge RPC 都读这份快照。
 */

import {
  quoteTextModelUsage,
  resolveBillableCapabilityRules,
  resolveEffectiveSelectedModelId,
  resolveEnabledCatalogModel,
  toPublicModelCatalog,
  type FixedDeductionConfig,
  type ModelCatalog,
  type ModelCatalogTierKey,
  type PublicModelCatalog,
  type VipEntitlementSummary,
  type WalletDebitPolicy,
} from '@miniapp/shared';

export interface TextEntitlement {
  active: boolean;
  validUntil: string | null;
}

export interface AcceptedTextQuote {
  original_credits: number;
  discount_rate: number | null;
  discounted_exact: number;
  payable_credits: number;
  wallet_policy: WalletDebitPolicy;
  requires_vip: boolean;
  vip_active: boolean;
  vip_valid_until: string | null;
  model_tier: ModelCatalogTierKey;
}

export type TextWalletDenial = 'MAIN_CREDITS_INSUFFICIENT' | 'TOTAL_CREDITS_INSUFFICIENT';

export type TextModelAccessCode = 'VIP_REQUIRED' | 'NO_LIGHT_MODEL' | 'INVALID_PRICE';

export class TextModelAccessError extends Error {
  constructor(readonly code: TextModelAccessCode) {
    super(code);
    this.name = 'TextModelAccessError';
  }
}

export function quoteAcceptedTextUsage(input: {
  originalCredits: number;
  tier: ModelCatalogTierKey;
  isVip: boolean;
  isFreeRound: boolean;
  vipValidUntil: string | null;
  /** 省略时使用 0.95。受理方传入已发布折扣，调用后不得再读取新配置重算。 */
  discountRate?: number;
  discountConfigVersion?: number | null;
}): AcceptedTextQuote & { discount_config_version: number | null } {
  const quoted = quoteTextModelUsage({
    original_credits: input.originalCredits,
    is_vip: input.isVip,
    is_free_round: input.isFreeRound,
    tier: input.tier,
    ...(input.discountRate === undefined ? {} : { discount_rate: input.discountRate }),
  });
  if (!quoted.ok) {
    throw new TextModelAccessError('INVALID_PRICE');
  }
  return {
    original_credits: quoted.value.original_credits,
    discount_rate: quoted.value.discount_rate,
    discounted_exact: quoted.value.discounted_exact,
    payable_credits: quoted.value.payable_credits,
    wallet_policy: quoted.value.wallet_policy,
    requires_vip: quoted.value.requires_vip,
    vip_active: input.isVip,
    vip_valid_until: input.vipValidUntil,
    model_tier: input.tier,
    discount_config_version: input.discountConfigVersion ?? null,
  };
}

/** 未知付费档按标准能力失败关闭：要 VIP，且只扣充值钱包。 */
export function tierForTextQuote(modelTier: ModelCatalogTierKey | null): ModelCatalogTierKey {
  return modelTier ?? 'standard';
}

export function originalCreditsForDecision(input: {
  category:
    | 'free_quota'
    | 'free_quota_exhausted'
    | 'light'
    | 'standard'
    | 'premium'
    | 'standard_fallback';
  undiscountedAmount: number;
  config: FixedDeductionConfig;
}): number {
  if (input.category === 'free_quota') return input.config.freeQuotaExhausted;
  return input.undiscountedAmount;
}

export function coverageForTextWallet(input: {
  policy: WalletDebitPolicy;
  payableCredits: number;
  mainCredits: number;
  bonusCredits: number;
}): { ok: true } | { ok: false; code: TextWalletDenial; available: number } {
  if (input.payableCredits === 0) return { ok: true };
  if (input.policy === 'main_only') {
    if (input.mainCredits >= input.payableCredits) return { ok: true };
    return {
      ok: false,
      code: 'MAIN_CREDITS_INSUFFICIENT',
      available: input.mainCredits,
    };
  }
  const available = input.mainCredits + input.bonusCredits;
  if (available >= input.payableCredits) return { ok: true };
  return { ok: false, code: 'TOTAL_CREDITS_INSUFFICIENT', available };
}

export interface ResolvedTextModelSelection {
  modelId: string;
  openRouterModelId: string;
  tier: ModelCatalogTierKey | null;
  isFree: boolean;
  /** 仅 VIP 失效把标准/旗舰换成轻量时为 true。无效历史选择的回落不算。 */
  vipFallback: boolean;
}

export function resolveTextModelSelection(input: {
  catalog: ModelCatalog;
  persistedModelId: string | null;
  vipActive: boolean;
}): ResolvedTextModelSelection {
  const effectiveId = resolveEffectiveSelectedModelId(input.catalog, input.persistedModelId);
  const located = locateEnabledModel(input.catalog, effectiveId);
  if (!located) {
    throw new TextModelAccessError('NO_LIGHT_MODEL');
  }
  const rules = resolveBillableCapabilityRules(capabilityForTier(located.tier));
  if (rules.requires_vip && !input.vipActive) {
    const light = lightFallbackModel(input.catalog);
    if (!light) throw new TextModelAccessError('NO_LIGHT_MODEL');
    return {
      modelId: light.model.id,
      openRouterModelId: light.model.openrouter_model_id,
      tier: 'light',
      isFree: light.model.is_free,
      vipFallback: true,
    };
  }
  return {
    modelId: located.model.id,
    openRouterModelId: located.model.openrouter_model_id,
    tier: located.tier,
    isFree: located.model.is_free,
    vipFallback: false,
  };
}

export function presentTextModelCatalog(input: {
  catalog: ModelCatalog;
  pricing: FixedDeductionConfig;
  vip: VipEntitlementSummary;
  discountRate?: number;
}): PublicModelCatalog {
  const catalog = toPublicModelCatalog(input.catalog);
  return {
    ...catalog,
    tiers: catalog.tiers.map((tier) => {
      const original = input.pricing[tier.key];
      const quote = quoteAcceptedTextUsage({
        originalCredits: original,
        tier: tier.key,
        isVip: input.vip.active,
        isFreeRound: false,
        vipValidUntil: input.vip.valid_until,
        ...(input.discountRate === undefined ? {} : { discountRate: input.discountRate }),
      });
      return {
        ...tier,
        requires_vip: quote.requires_vip,
        locked: quote.requires_vip && !input.vip.active,
        original_credits: quote.original_credits,
        discount_rate: quote.discount_rate,
        discounted_exact: quote.discounted_exact,
        payable_credits: quote.payable_credits,
        wallet_policy: quote.wallet_policy,
      };
    }),
  };
}

/** 给 charge metadata / sync 重放用。只拷贝已固化字段，不重新报价。 */
export function frozenLlmChargeMetadata(snapshot: {
  fixed_deduction: number;
  fixed_deduction_category: string;
  original_credits?: number;
  discount_rate?: number | null;
  discounted_exact?: number;
  payable_credits?: number;
  wallet_policy?: WalletDebitPolicy;
  requires_vip?: boolean;
  vip_active?: boolean;
  vip_valid_until?: string | null;
  model_tier?: string | null;
  vip_discount_config_version?: number | null;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    billing_mode: 'fixed_tier',
    fixed_deduction_category: snapshot.fixed_deduction_category,
    fixed_deduction: snapshot.fixed_deduction,
    payable_credits: snapshot.payable_credits ?? snapshot.fixed_deduction,
  };
  if (snapshot.original_credits !== undefined)
    metadata.original_credits = snapshot.original_credits;
  if (snapshot.discount_rate !== undefined) metadata.discount_rate = snapshot.discount_rate;
  if (snapshot.discounted_exact !== undefined)
    metadata.discounted_exact = snapshot.discounted_exact;
  if (snapshot.wallet_policy !== undefined) metadata.wallet_policy = snapshot.wallet_policy;
  if (snapshot.requires_vip !== undefined) metadata.requires_vip = snapshot.requires_vip;
  if (snapshot.vip_active !== undefined) metadata.vip_active = snapshot.vip_active;
  if (snapshot.vip_valid_until !== undefined) metadata.vip_valid_until = snapshot.vip_valid_until;
  if (snapshot.model_tier !== undefined) metadata.model_tier = snapshot.model_tier;
  if (snapshot.vip_discount_config_version !== undefined) {
    metadata.vip_discount_config_version = snapshot.vip_discount_config_version;
  }
  return metadata;
}

function capabilityForTier(tier: ModelCatalogTierKey) {
  if (tier === 'light') return 'text_light' as const;
  if (tier === 'standard') return 'text_standard' as const;
  return 'text_premium' as const;
}

function locateEnabledModel(catalog: ModelCatalog, modelId: string) {
  for (const tier of catalog.tiers) {
    const model = tier.models.find((candidate) => candidate.id === modelId && candidate.enabled);
    if (model) return { tier: tier.tier, model };
  }
  return null;
}

function lightFallbackModel(catalog: ModelCatalog) {
  const tier = catalog.tiers.find((candidate) => candidate.tier === 'light');
  if (!tier) return null;
  const preferred = tier.models.find(
    (model) => model.enabled && model.id === catalog.default_model_id
  );
  const model = preferred ?? tier.models.find((candidate) => candidate.enabled);
  if (!model) return null;
  resolveEnabledCatalogModel(catalog, model.id);
  return { model };
}
