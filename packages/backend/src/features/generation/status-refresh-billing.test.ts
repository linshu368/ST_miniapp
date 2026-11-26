import { beforeEach, describe, expect, it, vi } from 'vitest';

const charge = vi.fn();
const findByUserId = vi.fn();

vi.mock('../../infrastructure/repositories/StatusRefreshChargeRepository.js', () => ({
  StatusRefreshChargeRepository: class {
    charge = charge;
  },
}));
vi.mock('../../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    findByUserId = findByUserId;
  },
}));

import type { RequestLogger } from '../../platform/observability/logger.js';
import {
  hasRefreshCredits,
  refreshBillable,
  settleStatusRefresh,
  type RefreshParts,
} from './status-refresh-billing.js';

const log = () => {
  const channel = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return { biz: channel(), sys: channel() } as unknown as RequestLogger & {
    biz: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
    sys: Record<'info' | 'warn' | 'error', ReturnType<typeof vi.fn>>;
  };
};

const parts = (over: Partial<RefreshParts>): RefreshParts => ({
  status: 'ok',
  statusJoined: false,
  memory: 'no_progress',
  memoryJoined: false,
  ...over,
});

describe('refreshBillable：任一处有更新就收费，撞上的自动更新不算', () => {
  it.each([
    [parts({ status: 'ok' }), true, 'status_recorded'],
    [parts({ status: 'partial' }), true, 'status_recorded'],
    [parts({ status: 'failed', memory: 'recorded' }), true, 'memory_recorded'],
    [parts({ status: null, memory: 'recorded' }), true, 'memory_recorded'],
    [parts({ status: 'skipped', memory: 'recorded' }), true, 'memory_recorded'],
    [parts({ status: 'ok', statusJoined: true, memory: 'recorded' }), true, 'memory_recorded'],
    [parts({ status: 'ok', statusJoined: true }), false, 'joined'],
    [parts({ status: null, memory: 'recorded', memoryJoined: true }), false, 'joined'],
    [parts({ status: null, memory: 'no_progress' }), false, 'nothing_new'],
    [parts({ status: 'skipped', memory: 'skipped' }), false, 'nothing_new'],
    [parts({ status: 'failed', memory: 'failed' }), false, 'nothing_new'],
  ] as const)('%o → %s', (input, billable, reason) => {
    expect(refreshBillable(input)).toEqual({ billable, reason });
  });
});

describe('hasRefreshCredits：通用 + 专项 ≥ 6', () => {
  beforeEach(() => {
    findByUserId.mockReset();
  });

  it('专项够也算够', async () => {
    findByUserId.mockResolvedValue({ main_credits: 0, bonus_credits: 6 });
    expect(await hasRefreshCredits('u', 's', log())).toBe(true);
  });

  it('不够记一笔 info 并返回 false；没有钱包当 0', async () => {
    const l = log();
    findByUserId.mockResolvedValue(null);
    expect(await hasRefreshCredits('u', 's', l)).toBe(false);
    expect(l.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'status_bar.refresh.insufficient', availableCount: 0 }),
      expect.any(String)
    );
  });
});

describe('settleStatusRefresh：从不抛错', () => {
  beforeEach(() => {
    charge.mockReset();
  });

  it('没有新内容不调扣费', async () => {
    const l = log();
    await settleStatusRefresh({
      userId: 'u',
      sessionId: 's',
      parts: parts({ status: 'failed', memory: 'no_progress' }),
      log: l,
    });
    expect(charge).not.toHaveBeenCalled();
    expect(l.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not_billable', creditCount: 0 }),
      expect.any(String)
    );
  });

  it('有更新：扣 6，每次新 charge id', async () => {
    charge.mockResolvedValue({ status: 'charged', mainCredits: 0, bonusCredits: 6 });
    const l = log();
    await settleStatusRefresh({ userId: 'u', sessionId: 's', parts: parts({}), log: l });
    await settleStatusRefresh({ userId: 'u', sessionId: 's', parts: parts({}), log: l });
    expect(charge).toHaveBeenCalledTimes(2);
    const [first, second] = charge.mock.calls.map(
      ([input]) => input as { chargeId: string; amount: number }
    );
    expect(first!.amount).toBe(6);
    expect(first!.chargeId).not.toBe(second!.chargeId);
    expect(l.biz.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'charged', outcome: 'succeeded', bonusCount: 6 }),
      expect.any(String)
    );
  });

  it('扣费时余额不足只记 warn', async () => {
    charge.mockResolvedValue({ status: 'insufficient', mainCredits: 0, bonusCredits: 0 });
    const l = log();
    await settleStatusRefresh({ userId: 'u', sessionId: 's', parts: parts({}), log: l });
    expect(l.biz.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'insufficient', outcome: 'rejected' }),
      expect.any(String)
    );
  });

  it('扣费出错只记 error，不抛', async () => {
    charge.mockRejectedValue(new Error('timeout'));
    const l = log();
    await expect(
      settleStatusRefresh({ userId: 'u', sessionId: 's', parts: parts({}), log: l })
    ).resolves.toBeUndefined();
    expect(l.sys.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', outcome: 'failed' }),
      expect.any(String)
    );
  });
});
