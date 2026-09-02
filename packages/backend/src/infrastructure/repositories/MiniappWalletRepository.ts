import { getDomainDb } from '../../lib/supabase.js';
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
  metadata: Record<string, unknown>;
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
  /**
   * 本 repository 横跨三个域，所以显式持有三个域客户端：
   * · billing —— 钱包、账本、LLM 扣费，是本 repository 的主表；
   * · app_core —— 只读 runtime_config 里的签到奖励额度；
   * · miniapp_features —— 签到记录与 claim_daily_checkin RPC。
   *
   * 后两个是 099 之前就有的跨域直读，本阶段只把限定名改对，不重构调用关系。
   */
  private readonly db = getDomainDb('billing');
  private readonly appCoreDb = getDomainDb('app_core');
  private readonly featuresDb = getDomainDb('miniapp_features');

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

  /**
   * 语音生成实扣。幂等键 = chat_message_audio.id（每次生成一行，天然一费一单）。
   *
   * 与 chargeLlmUsage 区别：语音没有 OpenRouter model catalog 字段，另开 RPC；
   * wallet_ledger 用 reference_type='voice_usage' 与 llm_usage 区分。
   *
   * RPC 在同一事务内完成钱包扣减、ledger 与语音 ready 收口；余额不足不呈现成功音频。
   */
  async chargeVoiceUsage(input: {
    chargeKey: string;
    userId: string;
    audioId: string;
    amount: number;
    metadata?: Record<string, unknown>;
  }): Promise<{
    wallet: MiniappWalletRow;
    chargeStatus: 'charged' | 'already_charged' | 'insufficient_balance';
    alreadyCharged: boolean;
    charged: boolean;
  }> {
    const { data, error } = await this.db.rpc('charge_voice_usage', {
      p_charge_key: input.chargeKey,
      p_user_id: input.userId,
      p_audio_id: input.audioId,
      p_amount: input.amount,
      p_metadata: input.metadata ?? {},
    });

    if (error) throw new Error(`记录语音扣费失败：${error.message}`);
    const result = data as WalletRpcResult & {
      charge_status?: string;
      ledger_id?: string | null;
    };
    if (!result.wallet) throw new Error('记录语音扣费失败：返回结果不完整');

    const status = (result.charge_status ?? '') as
      | 'charged'
      | 'already_charged'
      | 'insufficient_balance';
    return {
      wallet: normalizeWallet(result.wallet),
      chargeStatus: status,
      alreadyCharged: status === 'already_charged',
      charged: status === 'charged',
    };
  }

  async listSpending(userId: string): Promise<WalletSpendingRecord[]> {
    const { data, error } = await this.db
      .from('llm_usage_charges')
      .select('charge_key,model_id,model_display_name,charged_amount,status,metadata,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(`查询消费明细失败：${error.message}`);
    const llmRows = (
      (data ?? []) as Array<{
        charge_key: string;
        model_id: string | null;
        model_display_name: string;
        charged_amount: NumericValue;
        status: WalletSpendingRecord['status'];
        metadata: Record<string, unknown> | null;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.charge_key,
      model_id: row.model_id,
      model_display_name: row.model_display_name,
      charged_amount: toNumber(row.charged_amount),
      status: row.status,
      finish_reason:
        typeof row.metadata?.finish_reason === 'string' ? row.metadata.finish_reason : null,
      reply_outcome: readReplyOutcome(row.metadata ?? {}),
      status_label: formatSpendingStatus(row.status, row.metadata ?? {}),
      created_at: row.created_at,
    }));

    // 语音扣费走 wallet_ledger（reference_type='voice_usage'），不在 llm_usage_charges 里。
    // 客服对账要能看到「角色语音 15」，这里 UNION 一段拼到消费明细前端。
    const { data: voiceRows, error: voiceError } = await this.db
      .from('wallet_ledger')
      .select('reference_id,amount,metadata,created_at')
      .eq('user_id', userId)
      .eq('reference_type', 'voice_usage')
      .order('created_at', { ascending: false })
      .limit(100);
    if (voiceError) throw new Error(`查询语音消费明细失败：${voiceError.message}`);

    const voiceRecords = (
      (voiceRows ?? []) as Array<{
        reference_id: string | null;
        amount: NumericValue;
        metadata: Record<string, unknown> | null;
        created_at: string;
      }>
    )?.map((row) => {
      const amount = Math.abs(toNumber(row.amount));
      const label =
        typeof row.metadata?.voice_price_label === 'string'
          ? row.metadata.voice_price_label
          : '角色语音';
      return {
        id: row.reference_id ?? row.created_at,
        model_id: null,
        model_display_name: '语音消费 ' + label,
        charged_amount: amount,
        status: 'charged' as const,
        finish_reason: null,
        reply_outcome: null,
        status_label: '已扣费',
        created_at: row.created_at,
      };
    });

    return [...llmRows, ...voiceRecords].sort(
      (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
    );
  }

  async getDailyCheckinStatus(userId: string): Promise<DailyCheckinStatus> {
    const { data: configRow, error: configError } = await this.appCoreDb
      .from('runtime_config')
      .select('value, text_value')
      .eq('key', 'miniapp_daily_checkin_bonus_credits')
      .maybeSingle();

    if (configError) {
      throw new Error(`查询签到配置失败：${configError.message}`);
    }

    const rewardCredits = parsePositiveInteger(configRow?.value ?? configRow?.text_value, 40);

    const { data, error } = await this.featuresDb
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
    const { data, error } = await this.featuresDb.rpc('claim_daily_checkin', {
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

export function formatSpendingStatus(
  status: WalletSpendingRecord['status'],
  metadata: Record<string, unknown>
): string {
  const replyOutcome = readReplyOutcome(metadata);

  if (status === 'pending') return '待结算';
  if (status === 'charged' || status === 'reconciled') return '已扣费';
  if (status === 'partial') return '余额不足，部分扣费';
  if (status === 'free') return '本次免费';
  if (replyOutcome === 'incomplete') return '截断未扣除';
  if (replyOutcome === 'empty') return '生成失败，未扣除';
  const finishReason = typeof metadata.finish_reason === 'string' ? metadata.finish_reason : null;
  const generationStatus =
    typeof metadata.generation_status === 'string'
      ? metadata.generation_status
      : typeof metadata.chat_status === 'string'
        ? metadata.chat_status
        : null;
  if (finishReason && finishReason !== 'stop') return '截断未扣除';
  if (generationStatus === 'stream_interrupted') return '截断未扣除';
  if (generationStatus === 'upstream_error') return '生成失败，未扣除';
  return '未扣除';
}

function readReplyOutcome(
  metadata: Record<string, unknown>
): WalletSpendingRecord['reply_outcome'] {
  const value = metadata.reply_outcome;
  return value === 'complete' || value === 'incomplete' || value === 'empty' ? value : null;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
