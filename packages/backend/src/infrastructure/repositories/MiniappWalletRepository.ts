import type { DailyCheckinStatus } from './wallet-model.js';
import { toClaimedCheckin } from '../../features/vip/claimed-checkin.js';
import { getDomainDb } from '../../lib/supabase.js';
import { type VipCheckinBonusConfig, type WalletSpendingRecord } from '@miniapp/shared';
import type {
  NumericValue,
  MiniappWalletRow,
  RawMiniappWalletRow,
  WalletRpcResult,
  MediaSettlementStatus,
  LlmUsageChargeRow,
  ChargeLlmUsageResult,
  ChargeLlmUsageInput,
} from './wallet-model.js';
import {
  normalizeWallet,
  toNumber,
  mapLlmSpendingRow,
  mapLlmRefundSpendingRow,
} from './wallet-mapping.js';
import { getDailyCheckinStatus } from './wallet-checkin.js';
import { observation } from '../../platform/observability/runtime.js';

export type {
  MiniappWalletRow,
  MediaSettlementStatus,
  LlmUsageChargeRow,
  ArchivedLlmUsageCharge,
  ChargeLlmUsageResult,
  ChargeLlmUsageInput,
} from './wallet-model.js';

export {
  toWalletBalance,
  mapLlmSpendingRow,
  mapLlmRefundSpendingRow,
  formatSpendingStatus,
} from './wallet-mapping.js';

export { toClaimedCheckin } from '../../features/vip/claimed-checkin.js';

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
      throw new Error(`创建 MiniApp 钱包失败：${error.message}`, { cause: error });
    }

    return normalizeWallet(data as RawMiniappWalletRow);
  }

  /**
   * 查询 MiniApp 钱包
   * @param userId 用户 ID
   * @returns MiniApp 钱包
   */
  /** Read-only precheck: an absent wallet is zero balance, not a reason to insert a row. */
  async findByUserId(userId: string): Promise<MiniappWalletRow | null> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .abortSignal(AbortSignal.timeout(5_000))
      .maybeSingle();

    if (error) throw new Error(`查询 MiniApp 钱包失败：${error.message}`, { cause: error });
    return data ? normalizeWallet(data as RawMiniappWalletRow) : null;
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
    return observation.observe(
      'wallet.balance.precheck',
      async () => {
        const wallet = await this.getOrCreate(userId);
        return wallet.main_credits < requiredAmount
          ? {
              ok: false as const,
              creditsRequired: requiredAmount,
              creditsAvailable: wallet.main_credits,
              wallet,
            }
          : { ok: true as const, wallet };
      },
      (result) => ({ outcome: result.ok ? 'succeeded' : 'rejected', outcome_known: true })
    );
  }

  /**
   * 扣费 LLM 用量
   * @param input 扣费 LLM 用量输入
   * @returns 扣费 LLM 用量结果
   */
  async chargeLlmUsage(input: ChargeLlmUsageInput): Promise<ChargeLlmUsageResult> {
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

    if (error) throw new Error(`记录 LLM 用量扣费失败：${error.message}`, { cause: error });
    const result = data as WalletRpcResult | null;
    if (result?.charge_status === 'already_archived') {
      const archived = result.archived_charge;
      if (
        !archived ||
        archived.user_id !== input.userId ||
        (archived.charge_key !== input.chargeId &&
          !(input.generationId && archived.generation_id === input.generationId)) ||
        !['failed', 'free', 'charged', 'partial', 'reconciled', 'historical'].includes(
          archived.status
        ) ||
        archived.charged_amount === null ||
        !Number.isFinite(Number(archived.charged_amount)) ||
        Number(archived.charged_amount) < 0
      ) {
        throw new Error('记录 LLM 用量扣费失败：归档结果不完整');
      }
      return { kind: 'archived', archivedCharge: archived, alreadyCharged: true };
    }
    if (!result?.wallet || !result.charge) {
      throw new Error('记录 LLM 用量扣费失败：返回结果不完整');
    }
    return {
      kind: 'detailed',
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
    if (error) throw new Error(`对账 LLM 用量扣费失败：${error.message}`, { cause: error });
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
    if (error) throw new Error(`查询 LLM 用量扣费失败：${error.message}`, { cause: error });
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

    if (error) throw new Error(`记录语音扣费失败：${error.message}`, { cause: error });
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

    if (error) throw new Error(`语音生成结算失败：${error.message}`, { cause: error });
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
    if (error) throw new Error(`查询消费明细失败：${error.message}`, { cause: error });
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
    if (voiceError)
      throw new Error(`查询语音消费明细失败：${voiceError.message}`, { cause: voiceError });

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
      // 角色配图与影像广场使用各自的结算命名空间，都需进入图片消费明细。
      .in('reference_type', ['image_generation', 'image_plaza_generation'])
      .order('created_at', { ascending: false })
      .limit(100);
    if (imageError)
      throw new Error(`查询图片消费明细失败：${imageError.message}`, { cause: imageError });

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
    if (refundError)
      throw new Error(`查询文本退款明细失败：${refundError.message}`, { cause: refundError });

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
    input: {
      createdAt: string;
      vipCredits?: VipCheckinBonusConfig;
    }
  ): Promise<DailyCheckinStatus> {
    return getDailyCheckinStatus(this.db, this.appCoreDb, this.featuresDb, userId, input);
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
    if (error) throw new Error(`退回 LLM 扣费失败：${error.message}`, { cause: error });
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
      throw new Error(`领取签到奖励失败：${error.message}`, { cause: error });
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

export type { DailyCheckinStatus } from './wallet-model.js';
