// 状态面板「立即更新」的扣费。存储见 migration 20261126_status_refresh_charge.sql：
// billing.charge_status_refresh 在同一事务里记 usage_charges 一行并经 apply_wallet_debit 扣钱（专项优先），
// charge id 幂等；余额不足（含被聊天预留占住）不抛错，返回 insufficient。5 秒超时。

import { getDomainDb } from '../../lib/supabase.js';

const TIMEOUT_MS = 5_000;

export type StatusRefreshChargeStatus = 'charged' | 'already_charged' | 'insufficient';

export interface StatusRefreshChargeResult {
  status: StatusRefreshChargeStatus;
  mainCredits: number;
  bonusCredits: number;
}

const STATUSES = new Set<string>(['charged', 'already_charged', 'insufficient']);

const num = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
};

export class StatusRefreshChargeRepository {
  private readonly db = getDomainDb('billing');

  async charge(input: {
    chargeId: string;
    userId: string;
    sessionId: string;
    amount: number;
  }): Promise<StatusRefreshChargeResult> {
    const { data, error } = await this.db
      .rpc('charge_status_refresh', {
        p_charge_id: input.chargeId,
        p_user_id: input.userId,
        p_session_id: input.sessionId,
        p_amount: input.amount,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw new Error(`状态更新扣费失败：${error.message}`, { cause: error });
    const result = (data ?? {}) as { status?: unknown; split?: Record<string, unknown> | null };
    if (typeof result.status !== 'string' || !STATUSES.has(result.status))
      throw new Error('状态更新扣费失败：返回结果不完整');
    return {
      status: result.status as StatusRefreshChargeStatus,
      mainCredits: num(result.split?.main_credits),
      bonusCredits: num(result.split?.bonus_credits),
    };
  }
}
