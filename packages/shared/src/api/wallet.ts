// MiniApp 钱包领域的前后端共享契约
import { z } from 'zod';

export const FreeQuotaExhaustedDialogConfigSchema = z.object({
  title: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(200),
});

export type FreeQuotaExhaustedDialogConfig = z.infer<typeof FreeQuotaExhaustedDialogConfigSchema>;

export const DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG: FreeQuotaExhaustedDialogConfig = {
  title: '该卡的免费额度已用光',
  description: '你们已经一起完成了 50 轮免费对话。故事还可以继续，后续聊天将按实际使用量消耗星尘。',
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
