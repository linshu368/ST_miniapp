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
  charge_status?: 'charged' | 'already_charged';
  refund_status?: 'refunded' | 'already_refunded';
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

  async deduct(userId: string, amount: number): Promise<MiniappWalletRow> {
    const { data, error } = await this.db.rpc('deduct_wallet_credits', {
      p_user_id: userId,
      p_amount: amount,
    });

    if (error) {
      throw new Error(`扣除 MiniApp 钱包余额失败：${error.message}`);
    }

    return data as MiniappWalletRow;
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
      wallet: result.wallet,
      alreadyCharged: result.charge_status === 'already_charged',
    };
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
    return result.wallet ?? null;
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
