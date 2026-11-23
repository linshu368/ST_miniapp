import type { DomainDb } from '../../lib/supabase.js';
import type { WalletBalanceReason } from './wallet-errors.js';

/** A known refusal is a permanent zero-charge failure, never a future collection attempt. */
export async function failChatChargeForBalance(
  db: DomainDb,
  chargeId: string,
  reason: WalletBalanceReason
): Promise<void> {
  const { error } = await db
    .rpc('fail_chat_charge_for_balance', { p_charge_id: chargeId, p_error_code: reason })
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error('保存余额不足账单失败状态失败', { cause: error });
}
