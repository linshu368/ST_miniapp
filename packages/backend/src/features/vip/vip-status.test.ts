import { describe, expect, it, vi } from 'vitest';

import type { SettlementLogger } from '../payment/usecases/PaymentSettlement.js';
import {
  closedVipStatus,
  mapVipStatus,
  VipStatusService,
  type VipStatusReader,
} from './vip-status.js';

const NOW = '2026-09-22T00:00:00.000Z';
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

function log(): SettlementLogger {
  const sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { biz: sink, sys: sink } as unknown as SettlementLogger;
}

describe('mapVipStatus', () => {
  it('treats a missing membership as inactive with the entry badge still visible', () => {
    expect(
      mapVipStatus(
        { valid_from: null, valid_until: null, last_plan_id: null, entry_seen_at: null },
        NOW
      )
    ).toEqual({
      active: false,
      valid_from: null,
      valid_until: null,
      remaining_days: 0,
      last_plan_id: null,
      entry_badge_visible: true,
    });
  });

  it('keeps an active membership and rounds remaining time up to a day', () => {
    expect(
      mapVipStatus(
        {
          valid_from: '2026-09-15T00:00:00.000Z',
          valid_until: '2026-09-29T00:00:00.001Z',
          last_plan_id: 'month',
          entry_seen_at: null,
        },
        NOW
      )
    ).toMatchObject({
      active: true,
      remaining_days: 8,
      last_plan_id: 'month',
      entry_badge_visible: true,
    });
  });

  it('counts an exact number of days without adding an extra day', () => {
    expect(
      mapVipStatus(
        {
          valid_from: '2026-09-15T00:00:00.000Z',
          valid_until: '2026-09-29T00:00:00.000Z',
          last_plan_id: 'week',
          entry_seen_at: '2026-09-01T00:00:00.000Z',
        },
        NOW
      ).remaining_days
    ).toBe(7);
  });

  it('treats valid_until equal to now as expired and hides a viewed badge', () => {
    expect(
      mapVipStatus(
        {
          valid_from: '2026-09-15T00:00:00.000Z',
          valid_until: NOW,
          last_plan_id: 'week',
          entry_seen_at: '2026-09-20T00:00:00.000Z',
        },
        NOW
      )
    ).toMatchObject({
      active: false,
      remaining_days: 0,
      last_plan_id: 'week',
      entry_badge_visible: false,
    });
  });

  it('keeps the last plan on an already expired membership', () => {
    expect(
      mapVipStatus(
        {
          valid_from: '2026-08-01T00:00:00.000Z',
          valid_until: '2026-08-08T00:00:00.000Z',
          last_plan_id: 'month',
          entry_seen_at: null,
        },
        NOW
      )
    ).toMatchObject({ active: false, remaining_days: 0, last_plan_id: 'month' });
  });
});

describe('VipStatusService', () => {
  it('reads and writes only the requested user', async () => {
    const reader: VipStatusReader = {
      readSnapshot: vi.fn(async (userId: string) => ({
        valid_from: null,
        valid_until: null,
        last_plan_id: null,
        entry_seen_at: userId === USER ? null : 'seen',
      })),
      markEntryViewed: vi.fn(async () => undefined),
    };
    const service = new VipStatusService(reader, () => new Date(NOW));
    await service.getStatus(USER);
    await service.markEntryViewed(USER);
    expect(reader.readSnapshot).toHaveBeenCalledWith(USER);
    expect(reader.markEntryViewed).toHaveBeenCalledWith(USER, NOW);
    expect(reader.readSnapshot).not.toHaveBeenCalledWith(OTHER);
  });

  it('fails closed when the repository throws', async () => {
    const reader: VipStatusReader = {
      readSnapshot: vi.fn(async () => {
        throw new Error('db down');
      }),
      markEntryViewed: vi.fn(async () => undefined),
    };
    const service = new VipStatusService(reader, () => new Date(NOW));
    await expect(service.getStatus(USER, log())).resolves.toEqual(closedVipStatus());
  });

  it('does not report entry viewed when the write fails', async () => {
    const reader: VipStatusReader = {
      readSnapshot: vi.fn(async () => ({
        valid_from: null,
        valid_until: null,
        last_plan_id: null,
        entry_seen_at: null,
      })),
      markEntryViewed: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const service = new VipStatusService(reader, () => new Date(NOW));
    await expect(service.markEntryViewed(USER, log())).rejects.toThrow('db down');
    expect(reader.readSnapshot).not.toHaveBeenCalled();
  });
});
