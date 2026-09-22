// MiniApp 钱包领域的前后端共享契约
import { z } from 'zod';

import { FEATURE_FREE_TRIAL_LIMIT, type FeatureFreeTrialFeature } from './feature-free-trials.js';

/** runtime_config key：用户与单张角色卡的免费对话轮次上限。 */
export const CHARACTER_FREE_CHAT_QUOTA_LIMIT_CONFIG_KEY = 'miniapp_character_free_chat_quota_limit';

/** 配置缺失或无效时的兜底值。 */
export const DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT = 40;

export function parseCharacterFreeChatQuotaLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_CHARACTER_FREE_CHAT_QUOTA_LIMIT;
  }
  return parsed;
}

export const FreeQuotaExhaustedDialogConfigSchema = z.object({
  text: z.string().trim().min(1).max(200),
});

export type FreeQuotaExhaustedDialogConfig = z.infer<typeof FreeQuotaExhaustedDialogConfigSchema>;

export const DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG: FreeQuotaExhaustedDialogConfig = {
  text: '和「{characterName}」的免费轮次用完了。这是这张卡的免费额度，其他角色不受影响。往后每轮消耗星尘。',
};

// ==== GET /api/wallet/balance ====
export interface GetWalletBalanceData {
  credits: number;
  /** 充值钱包 */
  main_credits: number;
  /** 专项星尘钱包 */
  bonus_credits: number;
  /** 展示用合计，必须等于 main_credits + bonus_credits */
  total_credits: number;
  first_paid_at: string | null;
  last_paid_at: string | null;
  total_paid_amount: string;
}

export const WalletDebitPolicySchema = z.enum(['main_only', 'main_then_bonus']);
export type WalletDebitPolicy = z.infer<typeof WalletDebitPolicySchema>;

export const BillableCapabilitySchema = z.enum([
  'text_light',
  'text_standard',
  'text_premium',
  'image_basic',
  'image_advanced',
  'voice',
]);
export type BillableCapability = z.infer<typeof BillableCapabilitySchema>;

export const BillingGatingErrorCodeSchema = z.enum([
  'VIP_REQUIRED',
  'MAIN_CREDITS_INSUFFICIENT',
  'TOTAL_CREDITS_INSUFFICIENT',
  'FEATURE_FREE_TRIAL_EXHAUSTED',
  'ADVANCED_IMAGE_UNAVAILABLE',
]);
export type BillingGatingErrorCode = z.infer<typeof BillingGatingErrorCodeSchema>;

export const WalletSplitErrorCodeSchema = z.enum([
  'INVALID_AMOUNT',
  'INVALID_WALLET_SPLIT',
  'UNSUPPORTED_WALLET_POLICY',
  'MAIN_CREDITS_INSUFFICIENT',
  'TOTAL_CREDITS_INSUFFICIENT',
]);
export type WalletSplitErrorCode = z.infer<typeof WalletSplitErrorCodeSchema>;

export interface WalletAmountSplit {
  main_credits: number;
  bonus_credits: number;
  total_credits: number;
}

export interface WalletDebitSplit extends WalletAmountSplit {
  policy: WalletDebitPolicy;
  debit_key: string;
}

export interface WalletRefundSplit extends WalletAmountSplit {
  refund_key: string;
  debit_key: string;
}

export interface BillableCapabilityRules {
  capability: BillableCapability;
  wallet_policy: WalletDebitPolicy;
  requires_vip: boolean;
  free_trial_feature: FeatureFreeTrialFeature | null;
  free_trial_limit: number | null;
}

export type WalletContractResult<T, C extends string = WalletSplitErrorCode> =
  | { ok: true; value: T }
  | { ok: false; code: C; message: string };

const nonnegativeInteger = z.number().int().nonnegative();

export const WalletAmountSplitSchema = z
  .object({
    main_credits: nonnegativeInteger,
    bonus_credits: nonnegativeInteger,
    total_credits: nonnegativeInteger,
  })
  .superRefine((split, ctx) => {
    if (split.main_credits + split.bonus_credits !== split.total_credits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'main_credits + bonus_credits must equal total_credits',
      });
    }
  });

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

export function createWalletAmountSplit(
  mainCredits: number,
  bonusCredits: number,
  totalCredits?: number
): WalletContractResult<WalletAmountSplit> {
  if (!isNonNegativeInteger(mainCredits) || !isNonNegativeInteger(bonusCredits)) {
    return {
      ok: false,
      code: 'INVALID_WALLET_SPLIT',
      message: 'wallet split amounts must be non-negative integers',
    };
  }

  const total = mainCredits + bonusCredits;
  if (totalCredits !== undefined && totalCredits !== total) {
    return {
      ok: false,
      code: 'INVALID_WALLET_SPLIT',
      message: 'main_credits + bonus_credits must equal total_credits',
    };
  }

  return {
    ok: true,
    value: {
      main_credits: mainCredits,
      bonus_credits: bonusCredits,
      total_credits: total,
    },
  };
}

export function isConsistentWalletBalance(
  balance: Pick<
    GetWalletBalanceData,
    'credits' | 'main_credits' | 'bonus_credits' | 'total_credits'
  >
): boolean {
  const split = createWalletAmountSplit(
    balance.main_credits,
    balance.bonus_credits,
    balance.total_credits
  );
  return split.ok && balance.credits === balance.total_credits;
}

export function resolveBillableCapabilityRules(
  capability: BillableCapability
): BillableCapabilityRules {
  switch (capability) {
    case 'text_light':
      return {
        capability,
        wallet_policy: 'main_then_bonus',
        requires_vip: false,
        free_trial_feature: null,
        free_trial_limit: null,
      };
    case 'text_standard':
    case 'text_premium':
      return {
        capability,
        wallet_policy: 'main_only',
        requires_vip: true,
        free_trial_feature: null,
        free_trial_limit: null,
      };
    case 'image_basic':
      return {
        capability,
        wallet_policy: 'main_only',
        requires_vip: false,
        free_trial_feature: 'basic_image',
        free_trial_limit: FEATURE_FREE_TRIAL_LIMIT,
      };
    case 'voice':
      return {
        capability,
        wallet_policy: 'main_only',
        requires_vip: false,
        free_trial_feature: 'voice',
        free_trial_limit: FEATURE_FREE_TRIAL_LIMIT,
      };
    case 'image_advanced':
      return {
        capability,
        wallet_policy: 'main_only',
        requires_vip: true,
        free_trial_feature: null,
        free_trial_limit: null,
      };
  }
}

export function assertWalletPolicyForCapability(
  capability: BillableCapability,
  policy: WalletDebitPolicy
): WalletContractResult<BillableCapabilityRules, 'UNSUPPORTED_WALLET_POLICY'> {
  const rules = resolveBillableCapabilityRules(capability);
  if (rules.wallet_policy !== policy) {
    return {
      ok: false,
      code: 'UNSUPPORTED_WALLET_POLICY',
      message: `${capability} does not allow wallet policy ${policy}`,
    };
  }
  return { ok: true, value: rules };
}

export function allocateWalletDebit(input: {
  policy: WalletDebitPolicy;
  amount: number;
  main_credits: number;
  bonus_credits: number;
  debit_key: string;
}): WalletContractResult<WalletDebitSplit> {
  const policyParsed = WalletDebitPolicySchema.safeParse(input.policy);
  if (!policyParsed.success) {
    return {
      ok: false,
      code: 'UNSUPPORTED_WALLET_POLICY',
      message: 'wallet debit policy is not supported',
    };
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return {
      ok: false,
      code: 'INVALID_AMOUNT',
      message: 'debit amount must be a positive integer',
    };
  }
  if (!isNonNegativeInteger(input.main_credits) || !isNonNegativeInteger(input.bonus_credits)) {
    return {
      ok: false,
      code: 'INVALID_WALLET_SPLIT',
      message: 'available wallet balances must be non-negative integers',
    };
  }
  const debitKey = input.debit_key.trim();
  if (!debitKey) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'debit_key is required' };
  }

  if (policyParsed.data === 'main_only') {
    if (input.main_credits < input.amount) {
      return {
        ok: false,
        code: 'MAIN_CREDITS_INSUFFICIENT',
        message: 'main wallet cannot cover the full amount',
      };
    }
    return {
      ok: true,
      value: {
        policy: 'main_only',
        debit_key: debitKey,
        main_credits: input.amount,
        bonus_credits: 0,
        total_credits: input.amount,
      },
    };
  }

  // 轻量文本才允许的原子组合扣：先 main 再 bonus，余额不足时整笔失败。
  if (input.main_credits + input.bonus_credits < input.amount) {
    return {
      ok: false,
      code: 'TOTAL_CREDITS_INSUFFICIENT',
      message: 'main and bonus wallets cannot cover the full amount together',
    };
  }
  const mainCredits = Math.min(input.main_credits, input.amount);
  const bonusCredits = input.amount - mainCredits;
  return {
    ok: true,
    value: {
      policy: 'main_then_bonus',
      debit_key: debitKey,
      main_credits: mainCredits,
      bonus_credits: bonusCredits,
      total_credits: input.amount,
    },
  };
}

export function allocateWalletRefund(input: {
  original_debit: WalletAmountSplit;
  refund_key: string;
  debit_key: string;
}): WalletContractResult<WalletRefundSplit> {
  const original = WalletAmountSplitSchema.safeParse(input.original_debit);
  if (!original.success) {
    return {
      ok: false,
      code: 'INVALID_WALLET_SPLIT',
      message: 'original debit split must satisfy main + bonus = total',
    };
  }
  const refundKey = input.refund_key.trim();
  const debitKey = input.debit_key.trim();
  if (!refundKey || !debitKey) {
    return {
      ok: false,
      code: 'INVALID_AMOUNT',
      message: 'refund_key and debit_key are required',
    };
  }
  if (original.data.total_credits <= 0) {
    return {
      ok: false,
      code: 'INVALID_AMOUNT',
      message: 'refund total must be a positive integer',
    };
  }

  return {
    ok: true,
    value: {
      refund_key: refundKey,
      debit_key: debitKey,
      main_credits: original.data.main_credits,
      bonus_credits: original.data.bonus_credits,
      total_credits: original.data.total_credits,
    },
  };
}

// ==== GET /api/wallet/spending ====
export interface WalletSpendingRecord {
  id: string;
  model_id: string | null;
  model_display_name: string;
  charged_amount: number;
  status: 'pending' | 'failed' | 'free' | 'charged' | 'partial' | 'reconciled' | 'historical';
  finish_reason: string | null;
  reply_outcome: 'complete' | 'incomplete' | 'empty' | null;
  status_label: string;
  created_at: string;
  main_delta?: number;
  bonus_delta?: number;
  original_amount?: number | null;
  discount_rate?: number | null;
  refund_of?: string | null;
  source_label?: string;
}

export interface GetWalletSpendingData {
  items: WalletSpendingRecord[];
}

// ==== GET /api/wallet/free-quota/:characterId ====
export interface GetCharacterFreeQuotaData {
  character_id: string;
  quota_limit: number;
  used_rounds: number;
  remaining_rounds: number;
  exhausted: boolean;
  exhausted_dialog: FreeQuotaExhaustedDialogConfig;
}

// ==== GET /api/wallet/checkin ====
export interface DailyCheckinStatus {
  can_claim: boolean;
  last_claimed_at: string | null;
  next_claim_at: string | null;
  reward_credits: number;
  base_reward_credits?: number;
  vip_reward_credits?: number;
}

export interface GetDailyCheckinData {
  checkin: DailyCheckinStatus;
}

// ==== POST /api/wallet/checkin ====
export interface PostDailyCheckinData {
  wallet: GetWalletBalanceData;
  checkin: {
    claimed_at: string;
    next_claim_at: string;
    reward_credits: number;
    base_reward_credits?: number;
    vip_reward_credits?: number;
  };
}
