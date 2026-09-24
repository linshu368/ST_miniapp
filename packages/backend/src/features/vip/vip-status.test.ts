import { describe, expect, it, vi } from 'vitest';

import type { SettlementLogger } from '../payment/usecases/PaymentSettlement.js';
import {
  closedVipStatus,
  mapVipStatus,
  readVipBenefits,
  VipStatusService,
  type VipStatusReader,
} from './vip-status.js';
import { readVipStrategy, interpretVipStrategy } from '../../platform/vip-strategy.js';
import { fetchRuntimeConfigEntryStrict } from '../../platform/runtime-config.js';

vi.mock('../../platform/vip-strategy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/vip-strategy.js')>()),
  readVipStrategy: vi.fn(),
}));
vi.mock('../../platform/runtime-config.js', () => ({
  fetchRuntimeConfigEntryStrict: vi.fn(),
}));

describe('published VIP benefits', () => {
  it('previews 95% and the VIP signup reward even without membership', async () => {
    vi.mocked(readVipStrategy).mockResolvedValue(interpretVipStrategy(new Map()));
    vi.mocked(fetchRuntimeConfigEntryStrict).mockResolvedValue({
      value: 60,
      textValue: null,
      version: 1,
    });
    expect(await readVipBenefits()).toEqual({
      text_discount_rate: 0.95,
      checkin_base_credits: 60,
      checkin_vip_credits: 60,
    });
  });

  it('uses the published fixed bonus instead of assuming a doubled reward', async () => {
    const strategy = interpretVipStrategy(new Map());
    vi.mocked(readVipStrategy).mockResolvedValue({
      ...strategy,
      checkin: { mode: 'fixed', fixed_credits: 20 },
    });
    vi.mocked(fetchRuntimeConfigEntryStrict).mockResolvedValue({
      value: null,
      textValue: '80',
      version: 2,
    });
    expect(await readVipBenefits()).toMatchObject({
      checkin_base_credits: 80,
      checkin_vip_credits: 20,
    });
  });

  it('does not invent benefit amounts when the configuration cannot be read', async () => {
    vi.mocked(fetchRuntimeConfigEntryStrict).mockRejectedValue(new Error('unavailable'));
    const logger = log();
    expect(await readVipBenefits(logger)).toBeUndefined();
    expect(logger.sys.error).toHaveBeenCalled();
  });
});

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
