import { getSupabaseClient } from '../../lib/supabase.js';
import type { GetWalletBalanceData, WalletSpendingRecord } from '@miniapp/shared';

type NumericValue = string | number;

export interface MiniappWalletRow {
  user_id: string;
  main_credits: number;
  bonus_credits: number;
  total_credits: number | null;
  first_paid_at: string | null;
  last_paid_at: string | null;
  total_paid_amount: string | number;
  created_at: string;
  updated_at: string;
}

type RawMiniappWalletRow = Omit<
  MiniappWalletRow,
  'main_credits' | 'bonus_credits' | 'total_credits'
> & {
  main_credits: NumericValue;
  bonus_credits: NumericValue;
  total_credits: NumericValue | null;
};

interface WalletRpcResult {
  wallet?: RawMiniappWalletRow;
  checkin?: DailyCheckinRpcData;
  charge?: LlmUsageChargeRow;
  charge_status?: string;
  reconcile_status?: string;
  refund_status?: 'refunded' | 'already_refunded';
}

export interface LlmUsageChargeRow {
  charge_key: string;
  generation_id: string | null;
  user_id: string;
  model_id: string | null;
  model_openrouter_id: string;
  model_display_name: string;
  catalog_version: number;
  pricing_config_version: number;
  usage_cost_usd: NumericValue | null;
  exchange_rate: NumericValue;
  model_markup: NumericValue;
  initial_amount: NumericValue;
  calculated_amount: NumericValue;
  charged_amount: NumericValue;
  fallback_used: boolean;
  status: 'pending' | 'failed' | 'free' | 'charged' | 'partial' | 'reconciled' | 'historical';
  created_at: string;
  reconciled_at: string | null;
}

export interface ChargeLlmUsageInput {
  chargeId: string;
  generationId: string | null;
  userId: string;
  modelId: string | null;
  modelOpenRouterId: string;
  modelDisplayName: string;
  catalogVersion: number;
  pricingConfigVersion: number;
  usageCostUsd: number | null;
  exchangeRate: number;
  modelMarkup: number;
  calculatedAmount: number;
  fallbackUsed: boolean;
  metadata?: Record<string, unknown>;
}

interface DailyCheckinRpcData {
  claimed_at: string;
  next_claim_at: string;
  reward_credits: number;
  wallet_ledger_id?: string;
}

export interface DailyCheckinStatus {
  can_claim: boolean;
  last_claimed_at: string | null;
  next_claim_at: string | null;
  reward_credits: number;
}

export class MiniappWalletRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  async getOrCreate(userId: string): Promise<MiniappWalletRow> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;

    const { data, error } = await this.db
      .from('user_wallets')
      .insert({ user_id: userId })
      .select('*')
      .single();

    if (error) {
      const afterRace = await this.findByUserId(userId);
      if (afterRace) return afterRace;
      throw new Error(`创建 MiniApp 钱包失败：${error.message}`);
    }

    return normalizeWallet(data as RawMiniappWalletRow);
  }

  private async findByUserId(userId: string): Promise<MiniappWalletRow | null> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询 MiniApp 钱包失败：${error.message}`);
    return data ? normalizeWallet(data as RawMiniappWalletRow) : null;
  }

  async deduct(userId: string, amount: number): Promise<MiniappWalletRow> {
    const { data, error } = await this.db.rpc('deduct_wallet_credits', {
      p_user_id: userId,
      p_amount: amount,
    });

    if (error) {
      throw new Error(`扣除 MiniApp 钱包余额失败：${error.message}`);
    }

    return normalizeWallet(data as RawMiniappWalletRow);
  }

  async chargeLlmUsage(input: ChargeLlmUsageInput): Promise<{
    wallet: MiniappWalletRow;
    charge: LlmUsageChargeRow;
    alreadyCharged: boolean;
  }> {
    const { data, error } = await this.db.rpc('charge_llm_usage', {
      p_charge_key: input.chargeId,
      p_generation_id: input.generationId,
      p_user_id: input.userId,
      p_model_id: input.modelId,
      p_model_openrouter_id: input.modelOpenRouterId,
      p_model_display_name: input.modelDisplayName,
      p_catalog_version: input.catalogVersion,
      p_pricing_config_version: input.pricingConfigVersion,
      p_usage_cost_usd: input.usageCostUsd,
      p_exchange_rate: input.exchangeRate,
      p_model_markup: input.modelMarkup,
      p_calculated_amount: input.calculatedAmount,
      p_fallback_used: input.fallbackUsed,
      p_metadata: input.metadata ?? {},
    });

    if (error) throw new Error(`记录 LLM 用量扣费失败：${error.message}`);
    const result = data as WalletRpcResult;
    if (!result.wallet || !result.charge) {
      throw new Error('记录 LLM 用量扣费失败：返回结果不完整');
    }
    return {
      wallet: normalizeWallet(result.wallet),
      charge: result.charge,
      alreadyCharged: result.charge_status === 'already_charged',
    };
  }

  async reconcileLlmUsage(input: {
    chargeId: string;
    usageCostUsd: number;
    calculatedAmount: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ wallet: MiniappWalletRow; charge: LlmUsageChargeRow }> {
    const { data, error } = await this.db.rpc('reconcile_llm_usage', {
      p_charge_key: input.chargeId,
      p_usage_cost_usd: input.usageCostUsd,
      p_calculated_amount: input.calculatedAmount,
      p_metadata: input.metadata ?? {},
    });
    if (error) throw new Error(`对账 LLM 用量扣费失败：${error.message}`);
    const result = data as WalletRpcResult;
    if (!result.wallet || !result.charge) {
      throw new Error('对账 LLM 用量扣费失败：返回结果不完整');
    }
    return { wallet: normalizeWallet(result.wallet), charge: result.charge };
  }

  async findLlmUsageCharge(chargeId: string): Promise<LlmUsageChargeRow | null> {
    const { data, error } = await this.db
      .from('llm_usage_charges')
      .select('*')
      .eq('charge_key', chargeId)
      .maybeSingle();
    if (error) throw new Error(`查询 LLM 用量扣费失败：${error.message}`);
    return (data as LlmUsageChargeRow | null) ?? null;
  }

  async listSpending(userId: string): Promise<WalletSpendingRecord[]> {
    const { data, error } = await this.db
      .from('llm_usage_charges')
      .select('charge_key,model_id,model_display_name,charged_amount,status,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(`查询消费明细失败：${error.message}`);
    return (
      (data ?? []) as Array<{
        charge_key: string;
        model_id: string | null;
        model_display_name: string;
        charged_amount: NumericValue;
        status: WalletSpendingRecord['status'];
        created_at: string;
      }>
    ).map((row) => ({
      id: row.charge_key,
      model_id: row.model_id,
      model_display_name: row.model_display_name,
      charged_amount: toNumber(row.charged_amount),
      status: row.status,
      created_at: row.created_at,
    }));
  }

  async chargeChatMessage(input: {
    userId: string;
    sessionId: string;
    clientMessageId: string;
    amount: number;
  }): Promise<{ wallet: MiniappWalletRow; alreadyCharged: boolean }> {
    const { data, error } = await this.db.rpc('charge_chat_message', {
      p_user_id: input.userId,
      p_session_id: input.sessionId,
      p_client_message_id: input.clientMessageId,
      p_amount: input.amount,
    });

    if (error) {
      throw new Error(`扣除聊天消息费用失败：${error.message}`);
    }

    const result = data as WalletRpcResult;
    if (!result.wallet) {
      throw new Error('扣除聊天消息费用失败：返回结果缺少钱包信息');
    }

    return {
      wallet: normalizeWallet(result.wallet),
      alreadyCharged: result.charge_status === 'already_charged',
    };
  }

  async reserveChatMessage(input: {
    userId: string;
    sessionId: string;
    clientMessageId: string;
    amount: number;
  }): Promise<{ wallet: MiniappWalletRow; alreadyReserved: boolean }> {
    const { data, error } = await this.db.rpc('reserve_chat_message', {
      p_user_id: input.userId,
      p_session_id: input.sessionId,
      p_client_message_id: input.clientMessageId,
      p_amount: input.amount,
    });

    if (error) {
      throw new Error(`预留聊天消息扣费失败：${error.message}`);
    }

    const result = data as WalletRpcResult;
    if (!result.wallet) {
      throw new Error('预留聊天消息扣费失败：返回结果缺少钱包信息');
    }

    return {
      wallet: normalizeWallet(result.wallet),
      alreadyReserved:
        result.charge_status === 'already_reserved' || result.charge_status === 'already_charged',
    };
  }

  async finalizeChatMessageCharge(input: {
    userId: string;
    sessionId: string;
    clientMessageId: string;
  }): Promise<MiniappWalletRow> {
    const { data, error } = await this.db.rpc('finalize_chat_message_charge', {
      p_user_id: input.userId,
      p_session_id: input.sessionId,
      p_client_message_id: input.clientMessageId,
    });

    if (error) {
      throw new Error(`确认聊天消息扣费失败：${error.message}`);
    }

    const result = data as WalletRpcResult;
    if (!result.wallet) {
      throw new Error('确认聊天消息扣费失败：返回结果缺少钱包信息');
    }

    return normalizeWallet(result.wallet);
  }

  async refundChatMessage(input: {
    userId: string;
    sessionId: string;
    clientMessageId: string;
    reason: string;
  }): Promise<MiniappWalletRow | null> {
    const { data, error } = await this.db.rpc('refund_chat_message_charge', {
      p_user_id: input.userId,
      p_session_id: input.sessionId,
      p_client_message_id: input.clientMessageId,
      p_reason: input.reason,
    });

    if (error) {
      throw new Error(`退回聊天消息费用失败：${error.message}`);
    }

    const result = data as WalletRpcResult;
    return result.wallet ? normalizeWallet(result.wallet) : null;
  }

  async getDailyCheckinStatus(userId: string): Promise<DailyCheckinStatus> {
    const { data: configRow, error: configError } = await this.db
      .from('runtime_config')
      .select('value, text_value')
      .eq('key', 'miniapp_daily_checkin_bonus_credits')
      .maybeSingle();

    if (configError) {
      throw new Error(`查询签到配置失败：${configError.message}`);
    }

    const rewardCredits = parsePositiveInteger(configRow?.value ?? configRow?.text_value, 40);

    const { data, error } = await this.db
      .from('daily_checkins')
      .select('claimed_at')
      .eq('user_id', userId)
      .order('claimed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`查询签到状态失败：${error.message}`);
    }

    const lastClaimedAt = (data as { claimed_at?: string } | null)?.claimed_at ?? null;
    const nextClaimAt = lastClaimedAt
      ? new Date(new Date(lastClaimedAt).getTime() + 24 * 60 * 60 * 1000).toISOString()
      : null;

    return {
      can_claim: !nextClaimAt || Date.now() >= new Date(nextClaimAt).getTime(),
      last_claimed_at: lastClaimedAt,
      next_claim_at: nextClaimAt,
      reward_credits: rewardCredits,
    };
  }

  async claimDailyCheckin(userId: string): Promise<{
    wallet: MiniappWalletRow;
    checkin: DailyCheckinRpcData;
  }> {
    const { data, error } = await this.db.rpc('claim_daily_checkin', {
      p_user_id: userId,
    });

    if (error) {
      throw new Error(`领取签到奖励失败：${error.message}`);
    }

    const result = data as WalletRpcResult;
    if (!result.wallet || !result.checkin) {
      throw new Error('领取签到奖励失败：返回结果缺少钱包或签到信息');
    }

    return {
      wallet: normalizeWallet(result.wallet),
      checkin: result.checkin,
    };
  }
}

export function toWalletBalance(row: MiniappWalletRow): GetWalletBalanceData {
  const mainCredits = toNumber(row.main_credits);
  const bonusCredits = toNumber(row.bonus_credits);
  const credits =
    row.total_credits === null ? mainCredits + bonusCredits : toNumber(row.total_credits);
  return {
    credits,
    main_credits: mainCredits,
    bonus_credits: bonusCredits,
    total_credits: credits,
    first_paid_at: row.first_paid_at,
    last_paid_at: row.last_paid_at,
    total_paid_amount: String(row.total_paid_amount ?? '0.00'),
  };
}

function normalizeWallet(row: RawMiniappWalletRow): MiniappWalletRow {
  return {
    ...row,
    main_credits: toNumber(row.main_credits),
    bonus_credits: toNumber(row.bonus_credits),
    total_credits: row.total_credits === null ? null : toNumber(row.total_credits),
  };
}

function toNumber(value: NumericValue): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`无效的数值字段：${String(value)}`);
  return parsed;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
