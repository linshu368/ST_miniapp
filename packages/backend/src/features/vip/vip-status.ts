import {
  isVipActiveAt,
  isVipPlanId,
  remainingVipDisplayDays,
  type VipStatus,
} from '@miniapp/shared';

import type { SettlementLogger } from '../payment/usecases/PaymentSettlement.js';
import {
  MiniappVipRepository,
  type VipStatusSnapshot,
} from '../../infrastructure/repositories/MiniappVipRepository.js';

export interface VipStatusReader {
  readSnapshot(userId: string): Promise<VipStatusSnapshot>;
  markEntryViewed(userId: string, seenAt: string): Promise<void>;
}

/** 读失败时不把用户当成 VIP，也不展示依赖这份读取的角标。 */
export function closedVipStatus(): VipStatus {
  return {
    active: false,
    valid_from: null,
    valid_until: null,
    remaining_days: 0,
    last_plan_id: null,
    entry_badge_visible: false,
  };
}

export function mapVipStatus(snapshot: VipStatusSnapshot, now: string): VipStatus {
  const validUntil = snapshot.valid_until;
  const lastPlanId = snapshot.last_plan_id;
  if (lastPlanId !== null && !isVipPlanId(lastPlanId)) {
    throw new Error('invalid vip plan id');
  }
  return {
    active: isVipActiveAt(validUntil, now),
    valid_from: snapshot.valid_from,
    valid_until: validUntil,
    remaining_days: remainingVipDisplayDays(validUntil, now),
    last_plan_id: lastPlanId,
    entry_badge_visible: snapshot.entry_seen_at === null,
  };
}

export class VipStatusService {
  constructor(
    private readonly memberships: VipStatusReader = new MiniappVipRepository(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async getStatus(userId: string, log?: SettlementLogger): Promise<VipStatus> {
    const started = Date.now();
    try {
      const snapshot = await this.memberships.readSnapshot(userId);
      const status = mapVipStatus(snapshot, this.now().toISOString());
      log?.biz.info(
        {
          event: 'vip.status.read',
          userId,
          active: status.active,
          remainingDays: status.remaining_days,
          validUntil: status.valid_until,
          durationMs: Date.now() - started,
        },
        '读取 VIP 状态'
      );
      return status;
    } catch (err) {
      log?.sys.error(
        { err, event: 'vip.status.read_failed', userId, durationMs: Date.now() - started },
        '读取 VIP 状态失败'
      );
      return closedVipStatus();
    }
  }

  async markEntryViewed(userId: string, log?: SettlementLogger): Promise<VipStatus> {
    const started = Date.now();
    const seenAt = this.now().toISOString();
    await this.memberships.markEntryViewed(userId, seenAt);
    log?.biz.info(
      { event: 'vip.entry.viewed', userId, durationMs: Date.now() - started },
      '标记 VIP 入口已查看'
    );
    return this.getStatus(userId, log);
  }
}

export function isClosedVipStatus(status: VipStatus): boolean {
  return (
    status.active === false &&
    status.remaining_days === 0 &&
    status.last_plan_id === null &&
    status.entry_badge_visible === false
  );
}
