// MiniApp 钱包领域的前后端共享契约

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
