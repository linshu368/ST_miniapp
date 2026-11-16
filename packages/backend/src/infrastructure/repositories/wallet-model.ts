import { type DailyCheckinRpcData } from '../../features/vip/claimed-checkin.js';

export type NumericValue = string | number;

/**
 * MiniApp 钱包行
 */
export interface MiniappWalletRow {
  /** 用户 ID */
  user_id: string;
  /** 主星尘 */
  main_credits: number;
  /** 奖励星尘 */
  bonus_credits: number;
  /** 总星尘 */
  total_credits: number | null;
  /** 首次付费时间 */
  first_paid_at: string | null;
  /** 最后一次付费时间 */
  last_paid_at: string | null;
  /** 总付费金额 */
  total_paid_amount: string | number;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
}

/**
 * 原始 MiniApp 钱包行
 */
export type RawMiniappWalletRow = Omit<
  MiniappWalletRow,
  'main_credits' | 'bonus_credits' | 'total_credits'
> & {
  /** 主星尘 */
  main_credits: NumericValue;
  /** 奖励星尘 */
  bonus_credits: NumericValue;
  /** 总星尘 */
  total_credits: NumericValue | null;
};

/**
 * 钱包 RPC 结果
 */
export interface WalletRpcResult {
  /** 钱包 */
  wallet?: RawMiniappWalletRow;
  /** 签到 */
  checkin?: DailyCheckinRpcData;
  /** 扣费 */
  charge?: LlmUsageChargeRow;
  archived_charge?: ArchivedLlmUsageCharge;
  /** 扣费状态 */
  charge_status?: string;
  /** 对账状态 */
  reconcile_status?: string;
  /** 退款状态 */
  refund_status?: 'refunded' | 'already_refunded';
}

/**
 * 媒体结算状态
 */
export type MediaSettlementStatus =
  | 'charged'
  | 'already_charged'
  | 'free_trial_consumed'
  | 'already_free_trial_consumed'
  | 'insufficient_balance'
  | 'free_trial_invalid';

/**
 * LLM 用量扣费行
 */
export interface LlmUsageChargeRow {
  charge_key: string;
  /** 生成 ID */
  generation_id: string | null;
  /** 用户 ID */
  user_id: string;
  /** 模型 ID */
  model_id: string | null;
  /** 模型 OpenRouter ID */
  model_openrouter_id: string;
  /** 模型显示名称 */
  model_display_name: string;
  /** 模型目录版本 */
  catalog_version: number;
  /** 定价配置版本 */
  pricing_config_version: number;
  /** 使用成本 USD */
  usage_cost_usd: NumericValue | null;
  /** 汇率 */
  exchange_rate: NumericValue;
  /** 模型标记 */
  model_markup: NumericValue;
  /** 初始金额 */
  initial_amount: NumericValue;
  /** 计算金额 */
  calculated_amount: NumericValue;
  /** 扣费金额 */
  charged_amount: NumericValue;
  /** 回退使用 */
  fallback_used: boolean;
  /** 状态 */
  status: 'pending' | 'failed' | 'free' | 'charged' | 'partial' | 'reconciled' | 'historical';
  /** 元数据 */
  metadata: Record<string, unknown>;
  /** 创建时间 */
  created_at: string;
  /** 对账时间 */
  reconciled_at: string | null;
}

/** Permanent dedup facts survive the 100-detail retention cap; no price is reconstructed. */
export interface ArchivedLlmUsageCharge {
  charge_key: string;
  generation_id: string | null;
  user_id: string;
  status: Exclude<LlmUsageChargeRow['status'], 'pending'>;
  charged_amount: NumericValue;
}

export type ChargeLlmUsageResult =
  | {
      kind: 'detailed';
      wallet: MiniappWalletRow;
      charge: LlmUsageChargeRow;
      alreadyCharged: boolean;
    }
  | { kind: 'archived'; archivedCharge: ArchivedLlmUsageCharge; alreadyCharged: true };

/**
 * 扣费 LLM 用量输入
 */
export interface ChargeLlmUsageInput {
  /** 扣费 ID */
  chargeId: string;
  /** 生成 ID */
  generationId: string | null;
  /** 用户 ID */
  userId: string;
  /** 模型 ID */
  modelId: string | null;
  /** 模型 OpenRouter ID */
  modelOpenRouterId: string;
  /** 模型显示名称 */
  modelDisplayName: string;
  /** 模型目录版本 */
  catalogVersion: number;
  /** 定价配置版本 */
  pricingConfigVersion: number;
  /** 使用成本 USD */
  usageCostUsd: number | null;
  /** 汇率 */
  exchangeRate: number;
  /** 模型标记 */
  modelMarkup: number;
  /** 计算金额 */
  calculatedAmount: number;
  /** 回退使用 */
  fallbackUsed: boolean;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 签到 RPC 数据
 */

/**
 * 签到状态
 */
export interface DailyCheckinStatus {
  /** 可领取 */
  can_claim: boolean;
  /** 上次领取时间 */
  last_claimed_at: string | null;
  /** 下次领取时间 */
  next_claim_at: string | null;
  /** 奖励星尘 */
  reward_credits: number;
  /** 基础签到星尘 */
  base_reward_credits: number;
  /** VIP 签到星尘 */
  vip_reward_credits: number;
  main_reward_credits: number;
  bonus_reward_credits: number;
}
