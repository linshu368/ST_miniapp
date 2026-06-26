import { getSupabaseClient } from '../../lib/supabase.js';

export interface WishRole {
  id: string;
  user_id: number;
  db_user_id: string | null;
  wish_text: string;
  extra_text: string | null;
  total_paid_amount_at_submit: string | number;
  reward_credits: number;
  status: 'awaiting_extra' | 'completed';
  created_at: string;
  closed_at: string | null;
}

interface CreateWishRoleResult {
  wish?: WishRole;
  wallet_ledger_id?: string;
}

export class MiniappWishRoleRepository {
  private readonly db = getSupabaseClient().schema('miniapp');

  async createWish(input: {
    dbUserId: string;
    telegramUserId: number;
    wishText: string;
    rewardCredits: number;
  }): Promise<WishRole> {
    const { data, error } = await this.db.rpc('create_wish_role', {
      p_db_user_id: input.dbUserId,
      p_telegram_user_id: input.telegramUserId,
      p_wish_text: input.wishText,
      p_reward_credits: input.rewardCredits,
    });

    if (error) {
      throw new Error(`创建角色许愿失败：${error.message}`);
    }

    const result = data as CreateWishRoleResult;
    if (!result.wish) {
      throw new Error('创建角色许愿失败：返回结果缺少 wish');
    }

    return result.wish;
  }

  async completeWish(input: {
    dbUserId: string;
    telegramUserId: number;
    wishId: string;
    extraText?: string;
  }): Promise<WishRole | null> {
    const { data, error } = await this.db.rpc('complete_wish_role', {
      p_db_user_id: input.dbUserId,
      p_telegram_user_id: input.telegramUserId,
      p_wish_id: input.wishId,
      p_extra_text: input.extraText ?? null,
    });

    if (error) {
      throw new Error(`完成角色许愿失败：${error.message}`);
    }

    return (data as WishRole | null) ?? null;
  }
}
