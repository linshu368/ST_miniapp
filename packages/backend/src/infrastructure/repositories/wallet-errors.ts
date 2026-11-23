import { ConversationRepositoryError, type PostgrestLikeError } from './conversation-errors.js';

export type WalletBalanceReason = 'MAIN_CREDITS_INSUFFICIENT' | 'TOTAL_CREDITS_INSUFFICIENT';

/** Match only database-owned constants; an arbitrary P0001 remains a real fault. */
export function walletBalanceReason(error: PostgrestLikeError): WalletBalanceReason | null {
  if (error.code !== 'P0001') return null;
  return error.message === 'MAIN_CREDITS_INSUFFICIENT' ||
    error.message === 'TOTAL_CREDITS_INSUFFICIENT'
    ? error.message
    : null;
}

/** The RPC commits a permanent zero-charge failure before returning this refusal. */
export function throwReturnedWalletRejection(data: unknown): void {
  if (
    !data ||
    typeof data !== 'object' ||
    !('charge_status' in data) ||
    data.charge_status !== 'insufficient_balance'
  )
    return;
  const reason =
    'error_code' in data && typeof data.error_code === 'string'
      ? walletBalanceReason({ code: 'P0001', message: data.error_code })
      : null;
  if (!reason) throw new Error('钱包返回了未知拒绝结果');
  throw new WalletInsufficientBalanceError(reason, { code: 'P0001' });
}

export class WalletInsufficientBalanceError extends ConversationRepositoryError {
  readonly balance?: { creditsRequired: number; creditsAvailable: number };
  constructor(
    readonly reason: WalletBalanceReason,
    cause: unknown
  ) {
    super('insufficient_balance', '星尘余额不足', { cause });
    this.name = 'WalletInsufficientBalanceError';
    this.balance = readBalance(cause);
  }
}

function readBalance(error: unknown): WalletInsufficientBalanceError['balance'] {
  if (
    !error ||
    typeof error !== 'object' ||
    !('details' in error) ||
    typeof error.details !== 'string'
  )
    return;
  try {
    const value: unknown = JSON.parse(error.details);
    if (
      !value ||
      typeof value !== 'object' ||
      !('credits_required' in value) ||
      !('credits_available' in value)
    )
      return;
    const required = value.credits_required;
    const available = value.credits_available;
    if (
      typeof required === 'number' &&
      Number.isFinite(required) &&
      required > 0 &&
      typeof available === 'number' &&
      Number.isFinite(available) &&
      available >= 0
    )
      return { creditsRequired: required, creditsAvailable: available };
  } catch {
    /* Malformed details must never fabricate a wallet balance. */
  }
}
