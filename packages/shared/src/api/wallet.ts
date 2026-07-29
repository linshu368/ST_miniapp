// MiniApp 钱包领域的前后端共享契约
import { z } from 'zod';

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
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
});

export type FreeQuotaExhaustedDialogConfig = z.infer<typeof FreeQuotaExhaustedDialogConfigSchema>;

export const DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG: FreeQuotaExhaustedDialogConfig = {
  title: '▎ 和「{characterName}」的 40 轮免费时光结束了',
  description:
    '▎\n▎ 这是这张卡的免费额度，其他角色都不受影响。\n▎ 往后每轮消耗星尘，故事还在继续。',
};

// ==== GET /api/wallet/balance ====
export interface GetWalletBalanceData {
  credits: number;
  main_credits: number;
  bonus_credits: number;
  total_credits: number;
  first_paid_at: string | null;
  last_paid_at: string | null;
  total_paid_amount: string;
}

// ==== GET /api/wallet/spending ====
export interface WalletSpendingRecord {
  id: string;
  model_id: string | null;
  model_display_name: string;
  charged_amount: number;
  status: 'pending' | 'failed' | 'free' | 'charged' | 'partial' | 'reconciled' | 'historical';
  created_at: string;
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
  };
}
