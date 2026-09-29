import { getDomainDb } from '../../lib/supabase.js';
import { createLogger } from '../../lib/logger.js';
import {
  createWalletBalanceSplit,
  type GetWalletBalanceData,
  type VipCheckinBonusConfig,
  type WalletSpendingRecord,
} from '@miniapp/shared';
import { quoteDailyCheckinReward } from '../../features/vip/checkin-reward.js';

type NumericValue = string | number;

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
type RawMiniappWalletRow = Omit<
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
interface WalletRpcResult {
  /** 钱包 */
  wallet?: RawMiniappWalletRow;
  /** 签到 */
  checkin?: DailyCheckinRpcData;
  /** 扣费 */
  charge?: LlmUsageChargeRow;
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
interface DailyCheckinRpcData {
  /** 已领取时间 */
  claimed_at: string;
  /** 下次领取时间 */
  next_claim_at: string;
  /** 奖励星尘 */
  reward_credits: number;
  /** 基础签到星尘 */
  base_reward_credits?: number;
  /** VIP 签到星尘 */
  vip_reward_credits?: number;
  /** 钱包 ledger ID */
  wallet_ledger_id?: string;
  vip_checkin_config_fallback?: boolean;
}

/** 配置缺失或无法解析时的基础签到额。线上发放仍以 runtime_config 为准。 */
export const DEFAULT_DAILY_CHECKIN_BASE_CREDITS = 60;

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
}

/**
 * MiniApp 钱包仓库
 */
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

  /**
   * 创建或获取 MiniApp 钱包
   * @param userId 用户 ID
   * @returns MiniApp 钱包
   */
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

  /**
   * 查询 MiniApp 钱包
   * @param userId 用户 ID
   * @returns MiniApp 钱包
   */
  private async findByUserId(userId: string): Promise<MiniappWalletRow | null> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询 MiniApp 钱包失败：${error.message}`);
    return data ? normalizeWallet(data as RawMiniappWalletRow) : null;
  }

  /**
   * 付费状态读钱包权威位：`first_paid_at` 由支付入账主路径在已完成订单结算时写入。
   * 只读，不创建钱包行。
   */
  async hasCompletedPayment(userId: string): Promise<boolean> {
    const wallet = await this.findByUserId(userId);
    return wallet?.first_paid_at != null;
  }

  /**
   * 预检查主星尘余额
   * @param userId 用户 ID
   * @param requiredAmount 所需星尘
   * @returns 预检查结果
   */
  async precheckMainCredits(
    userId: string,
    requiredAmount: number
  ): Promise<
    | { ok: true; wallet: MiniappWalletRow }
    | { ok: false; creditsRequired: number; creditsAvailable: number; wallet: MiniappWalletRow }
  > {
    const wallet = await this.getOrCreate(userId);
    return wallet.main_credits < requiredAmount
      ? {
          ok: false,
          creditsRequired: requiredAmount,
          creditsAvailable: wallet.main_credits,
          wallet,
        }
      : { ok: true, wallet };
  }

  /**
   * 扣费 LLM 用量
   * @param input 扣费 LLM 用量输入
   * @returns 扣费 LLM 用量结果
   */
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

  /**
   * 对账 LLM 用量扣费
   * @param input 对账 LLM 用量扣费输入
   * @returns 对账 LLM 用量扣费结果
   */
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

  /**
   * 查询 LLM 用量扣费
   * @param chargeId 扣费 ID
   * @returns LLM 用量扣费
   */
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

  /**
   * 语音生成结算
   * @param input 语音生成结算输入
   * @returns 语音生成结算结果
   */
  async settleVoiceGeneration(input: {
    audioId: string;
    userId: string;
    amount: number;
    metadata?: Record<string, unknown>;
  }): Promise<{
    wallet: MiniappWalletRow;
    chargeStatus: MediaSettlementStatus;
    charged: boolean;
    freeTrialConsumed: boolean;
  }> {
    const { data, error } = await this.db.rpc('settle_voice_generation', {
      p_audio_id: input.audioId,
      p_user_id: input.userId,
      p_amount: input.amount,
      p_metadata: input.metadata ?? {},
    });

    if (error) throw new Error(`语音生成结算失败：${error.message}`);
    const result = data as WalletRpcResult & {
      charge_status?: MediaSettlementStatus;
    };
    if (!result.wallet) throw new Error('语音生成结算失败：返回结果不完整');
    const status = result.charge_status ?? 'free_trial_invalid';
    return {
      wallet: normalizeWallet(result.wallet),
      chargeStatus: status,
      charged: status === 'charged' || status === 'already_charged',
      freeTrialConsumed:
        status === 'free_trial_consumed' || status === 'already_free_trial_consumed',
    };
  }

  /**
   * 查询消费明细
   * @param userId 用户 ID
   * @returns 消费明细
   */
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
    ).map((row) => mapLlmSpendingRow(row));

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
      // const label =
      //   typeof row.metadata?.voice_price_label === 'string'
      //     ? row.metadata.voice_price_label
      //     : '角色语音';
      return {
        id: row.reference_id ?? row.created_at,
        model_id: null,
        model_display_name: '语音消费',
        charged_amount: amount,
        status: 'charged' as const,
        finish_reason: null,
        reply_outcome: null,
        status_label: '已扣费',
        created_at: row.created_at,
      };
    });

    const { data: imageRows, error: imageError } = await this.db
      .from('wallet_ledger')
      .select('reference_id,amount,metadata,created_at')
      .eq('user_id', userId)
      .eq('reference_type', 'image_generation')
      .order('created_at', { ascending: false })
      .limit(100);
    if (imageError) throw new Error(`查询图片消费明细失败：${imageError.message}`);

    const imageRecords = (
      (imageRows ?? []) as Array<{
        reference_id: string | null;
        amount: NumericValue;
        metadata: Record<string, unknown> | null;
        created_at: string;
      }>
    )?.map((row) => ({
      id: row.reference_id ?? row.created_at,
      model_id: null,
      model_display_name: '图片消费',
      charged_amount: Math.abs(toNumber(row.amount)),
      status: 'charged' as const,
      finish_reason: null,
      reply_outcome: null,
      status_label: '已扣费',
      created_at: row.created_at,
    }));

    const { data: refundRows, error: refundError } = await this.db
      .from('wallet_ledger')
      .select('reference_id,amount,main_delta,bonus_delta,metadata,created_at')
      .eq('user_id', userId)
      .eq('entry_type', 'refund')
      .eq('reference_type', 'wallet_refund')
      .contains('metadata', { reason: 'llm_usage' })
      .order('created_at', { ascending: false })
      .limit(100);
    if (refundError) throw new Error(`查询文本退款明细失败：${refundError.message}`);

    const refundRecords = (
      (refundRows ?? []) as Array<{
        reference_id: string | null;
        amount: NumericValue;
        main_delta: NumericValue;
        bonus_delta: NumericValue;
        metadata: Record<string, unknown> | null;
        created_at: string;
      }>
    ).map((row) => mapLlmRefundSpendingRow(row));

    return [...llmRows, ...voiceRecords, ...imageRecords, ...refundRecords].sort(
      (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
    );
  }

  async getDailyCheckinStatus(
    userId: string,
    bonus: VipCheckinBonusConfig = { mode: 'same_as_base' }
  ): Promise<DailyCheckinStatus> {
    const { data: configRow, error: configError } = await this.appCoreDb
      .from('runtime_config')
      .select('value, text_value')
      .eq('key', 'miniapp_daily_checkin_bonus_credits')
      .maybeSingle();

    if (configError) {
      throw new Error(`查询签到配置失败：${configError.message}`);
    }

    const now = new Date();
    const baseRewardCredits = parsePositiveInteger(
      configRow?.value ?? configRow?.text_value,
      DEFAULT_DAILY_CHECKIN_BASE_CREDITS
    );

    const { data: membership, error: membershipError } = await this.db
      .from('vip_memberships')
      .select('valid_until')
      .eq('user_id', userId)
      .maybeSingle();
    if (membershipError) {
      createLogger('wallet').sys.error(
        { err: membershipError, event: 'wallet.checkin.vip_read_failed', userId },
        '签到预览读取 VIP 失败'
      );
    }
    const validUntil = membershipError
      ? null
      : ((membership as { valid_until?: string } | null)?.valid_until ?? null);
    const quote = quoteDailyCheckinReward({
      baseRewardCredits,
      validUntil,
      now: now.toISOString(),
      bonus,
    });

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
      can_claim: !nextClaimAt || now.getTime() >= new Date(nextClaimAt).getTime(),
      last_claimed_at: lastClaimedAt,
      next_claim_at: nextClaimAt,
      reward_credits: quote.reward_credits,
      base_reward_credits: quote.base_reward_credits,
      vip_reward_credits: quote.vip_reward_credits,
    };
  }

  /**
   * 已扣文本的补偿入口。余额只由 refund_llm_usage_charge 修改。
   */
  async refundLlmUsageCharge(input: { chargeId: string; reason: string }): Promise<{
    status: 'refunded' | 'already_refunded' | 'not_debited' | 'not_refundable' | 'not_found';
    wallet: MiniappWalletRow | null;
  }> {
    const { data, error } = await this.db.rpc('refund_llm_usage_charge', {
      p_charge_key: input.chargeId,
      p_reason: input.reason,
    });
    if (error) throw new Error(`退回 LLM 扣费失败：${error.message}`);
    const result = data as WalletRpcResult & { ok?: boolean; status?: string };
    const status = result.status;
    if (
      status !== 'refunded' &&
      status !== 'already_refunded' &&
      status !== 'not_debited' &&
      status !== 'not_refundable' &&
      status !== 'not_found'
    ) {
      throw new Error('退回 LLM 扣费失败：返回状态无法识别');
    }
    return {
      status,
      wallet: result.wallet ? normalizeWallet(result.wallet) : null,
    };
  }

  async claimDailyCheckin(userId: string): Promise<{
    wallet: MiniappWalletRow;
    checkin: ReturnType<typeof toClaimedCheckin>;
    configFallback: boolean;
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
      checkin: toClaimedCheckin(result.checkin),
      configFallback: result.checkin.vip_checkin_config_fallback === true,
    };
  }
}

export function toWalletBalance(row: MiniappWalletRow): GetWalletBalanceData {
  const mainCredits = toNumber(row.main_credits);
  const bonusCredits = toNumber(row.bonus_credits);
  const split = createWalletBalanceSplit(mainCredits, bonusCredits);
  if (!split.ok) {
    throw new Error('钱包余额拆分无效');
  }
  if (row.total_credits !== null && toNumber(row.total_credits) !== split.value.total_credits) {
    throw new Error('钱包余额不守恒');
  }
  return {
    credits: split.value.total_credits,
    main_credits: split.value.main_credits,
    bonus_credits: split.value.bonus_credits,
    total_credits: split.value.total_credits,
    first_paid_at: row.first_paid_at,
    last_paid_at: row.last_paid_at,
    total_paid_amount: String(row.total_paid_amount ?? '0.00'),
  };
}

/**
 * 转换为领取签到奖励结果
 * @param raw 签到 RPC 数据
 * @returns 领取签到奖励结果
 */
export function toClaimedCheckin(raw: DailyCheckinRpcData): {
  claimed_at: string;
  next_claim_at: string;
  reward_credits: number;
  base_reward_credits?: number;
  vip_reward_credits?: number;
} {
  const rewardCredits = readRewardInteger(raw.reward_credits);
  const baseRewardCredits =
    raw.base_reward_credits == null ? undefined : readRewardInteger(raw.base_reward_credits);
  const vipRewardCredits =
    raw.vip_reward_credits == null ? undefined : readRewardInteger(raw.vip_reward_credits);
  if (
    baseRewardCredits !== undefined &&
    vipRewardCredits !== undefined &&
    baseRewardCredits + vipRewardCredits !== rewardCredits
  ) {
    throw new Error('签到奖励拆分与总额不一致');
  }
  return {
    claimed_at: raw.claimed_at,
    next_claim_at: raw.next_claim_at,
    reward_credits: rewardCredits,
    base_reward_credits: baseRewardCredits,
    vip_reward_credits: vipRewardCredits,
  };
}

/**
 * 转换为 MiniApp 钱包行
 * @param row 原始 MiniApp 钱包行
 * @returns MiniApp 钱包行
 */
function normalizeWallet(row: RawMiniappWalletRow): MiniappWalletRow {
  return {
    ...row,
    main_credits: toNumber(row.main_credits),
    bonus_credits: toNumber(row.bonus_credits),
    total_credits: row.total_credits === null ? null : toNumber(row.total_credits),
  };
}

/**
 * 转换为数字
 * @param value 数值值
 * @returns 数字
 */
function toNumber(value: NumericValue): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`无效的数值字段：${String(value)}`);
  return parsed;
}

export function mapLlmSpendingRow(row: {
  charge_key: string;
  model_id: string | null;
  model_display_name: string;
  charged_amount: NumericValue;
  status: WalletSpendingRecord['status'];
  metadata: Record<string, unknown> | null;
  created_at: string;
}): WalletSpendingRecord {
  const metadata = row.metadata ?? {};
  const record: WalletSpendingRecord = {
    id: row.charge_key,
    model_id: row.model_id,
    model_display_name: row.model_display_name,
    charged_amount: toNumber(row.charged_amount),
    status: row.status,
    finish_reason: typeof metadata.finish_reason === 'string' ? metadata.finish_reason : null,
    reply_outcome: readReplyOutcome(metadata),
    status_label: formatSpendingStatus(row.status, metadata),
    created_at: row.created_at,
  };
  const mainDelta = readOptionalNumber(metadata.main_delta);
  const bonusDelta = readOptionalNumber(metadata.bonus_delta);
  const originalAmount = readOptionalNullableNumber(metadata, 'original_credits');
  const discountRate = readOptionalNullableNumber(metadata, 'discount_rate');
  if (mainDelta !== undefined) record.main_delta = mainDelta;
  if (bonusDelta !== undefined) record.bonus_delta = bonusDelta;
  if (originalAmount !== undefined) record.original_amount = originalAmount;
  if (discountRate !== undefined) record.discount_rate = discountRate;
  return record;
}

export function mapLlmRefundSpendingRow(row: {
  reference_id: string | null;
  amount: NumericValue;
  main_delta: NumericValue;
  bonus_delta: NumericValue;
  metadata: Record<string, unknown> | null;
  created_at: string;
}): WalletSpendingRecord {
  const metadata = row.metadata ?? {};
  const refundOf = typeof metadata.debit_key === 'string' ? metadata.debit_key : null;
  return {
    id: row.reference_id ?? row.created_at,
    model_id: null,
    model_display_name: '文本消费退款',
    charged_amount: Math.abs(toNumber(row.amount)),
    status: 'charged',
    finish_reason: null,
    reply_outcome: null,
    status_label: '已原路退回',
    created_at: row.created_at,
    main_delta: toNumber(row.main_delta),
    bonus_delta: toNumber(row.bonus_delta),
    ...(refundOf ? { refund_of: refundOf } : {}),
    source_label: '原路退款',
  };
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

/**
 * 读取回复结果
 * @param metadata 元数据
 * @returns 回复结果
 */
function readReplyOutcome(
  metadata: Record<string, unknown>
): WalletSpendingRecord['reply_outcome'] {
  const value = metadata.reply_outcome;
  return value === 'complete' || value === 'incomplete' || value === 'empty' ? value : null;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readOptionalNullableNumber(
  metadata: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) return undefined;
  const value = metadata[key];
  if (value === null) return null;
  return readOptionalNumber(value);
}

function readRewardInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('签到奖励返回无效');
  }
  return parsed;
}

/**
 * 解析正整数
 * @param value 值
 * @param fallback 默认值
 * @returns 正整数
 */
function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
