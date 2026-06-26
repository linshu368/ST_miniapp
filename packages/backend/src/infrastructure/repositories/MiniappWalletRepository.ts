import { getSupabaseClient } from '../../lib/supabase.js';
import type { GetWalletBalanceData } from '@miniapp/shared';

interface MiniappWalletRow {
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

interface WalletRpcResult {
  wallet?: MiniappWalletRow;
  checkin?: DailyCheckinRpcData;
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

    return data as MiniappWalletRow;
  }

  private async findByUserId(userId: string): Promise<MiniappWalletRow | null> {
    const { data, error } = await this.db
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询 MiniApp 钱包失败：${error.message}`);
    return (data as MiniappWalletRow | null) ?? null;
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

    const rewardCredits = parsePositiveInteger(configRow?.value ?? configRow?.text_value, 10);

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
      wallet: result.wallet,
      checkin: result.checkin,
    };
  }
}

export function toWalletBalance(row: MiniappWalletRow): GetWalletBalanceData {
  const credits = row.total_credits ?? row.main_credits + row.bonus_credits;
  return {
    credits,
    main_credits: row.main_credits,
    bonus_credits: row.bonus_credits,
    total_credits: credits,
    first_paid_at: row.first_paid_at,
    last_paid_at: row.last_paid_at,
    total_paid_amount: String(row.total_paid_amount ?? '0.00'),
  };
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
