import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VipPlansSchema } from '@miniapp/shared';
import { observation } from '../../platform/observability/runtime.js';
import { createObserver } from '../../platform/observability/core.js';
import type { ObservationEvent } from '../../platform/observability/events.js';

import {
  formatSpendingStatus,
  mapLlmRefundSpendingRow,
  mapLlmSpendingRow,
  MiniappWalletRepository,
  toClaimedCheckin,
  toWalletBalance,
  type MiniappWalletRow,
} from './MiniappWalletRepository.js';
import {
  buildVipPlans,
  parseVipPurchaseEnabled,
} from '../../features/payment/domain/rechargeRules.js';

type LedgerFixtureRow = {
  id?: string;
  user_id: string;
  reference_type: string;
  reference_id: string;
  entry_type: string;
  amount: number | string;
  main_delta?: number | string;
  bonus_delta?: number | string;
  metadata: Record<string, unknown>;
  created_at: string;
};

const spendingDb = vi.hoisted(() => ({
  ledger: [] as LedgerFixtureRow[],
  charges: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  ledgerError: null as { code: string } | null,
  signals: [] as AbortSignal[],
}));

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    rpc: spendingDb.rpc,
    from: (table: string) => {
      let rows: LedgerFixtureRow[] =
        table === 'wallet_ledger'
          ? [...spendingDb.ledger]
          : table === 'usage_charges'
            ? ([...spendingDb.charges] as unknown as LedgerFixtureRow[])
            : [];
      const query = {
        select: () => query,
        eq: (column: keyof LedgerFixtureRow, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        // Only `quote->charge IS NOT NULL` is used; the selected alias is `charge`.
        not: (column: string) => {
          const key = column === 'quote->charge' ? 'charge' : column;
          rows = rows.filter((row) => (row as unknown as Record<string, unknown>)[key] != null);
          return query;
        },
        in: (column: keyof LedgerFixtureRow, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        contains: (column: keyof LedgerFixtureRow, expected: Record<string, unknown>) => {
          rows = rows.filter((row) => {
            const value = row[column];
            return (
              typeof value === 'object' &&
              value !== null &&
              Object.entries(expected).every(([key, item]) => value[key] === item)
            );
          });
          return query;
        },
        order: (_column: string, options: { ascending: boolean }) => {
          rows.sort((left, right) => {
            const delta = Date.parse(left.created_at) - Date.parse(right.created_at);
            return options.ascending ? delta : -delta;
          });
          return query;
        },
        abortSignal: (signal: AbortSignal) => {
          spendingDb.signals.push(signal);
          return query;
        },
        limit: async (count: number) => ({
          data: rows.slice(0, count),
          error: table === 'wallet_ledger' ? spendingDb.ledgerError : null,
        }),
      };
      return query;
    },
  }),
}));

function wallet(overrides: Partial<MiniappWalletRow> = {}): MiniappWalletRow {
  return {
    user_id: '00000000-0000-4000-8000-000000000001',
    main_credits: 80,
    bonus_credits: 40,
    total_credits: 120,
    first_paid_at: null,
    last_paid_at: null,
    total_paid_amount: '0.00',
    created_at: '2026-09-22T00:00:00.000Z',
    updated_at: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('media wallet precheck observation', () => {
  it.each([5, 80])(
    'keeps the wallet result and one actual terminal for main balance %s',
    async (main) => {
      const events: ObservationEvent[] = [];
      const observer = createObserver([
        (event) => {
          events.push(event);
        },
      ]);
      const spy = vi.spyOn(observation, 'observe').mockImplementation(observer.observe);
      try {
        const repo = new MiniappWalletRepository();
        const entity = wallet({ main_credits: main });
        const read = vi.spyOn(repo, 'getOrCreate').mockResolvedValueOnce(entity);
        const result = await repo.precheckMainCredits(entity.user_id, 30);
        expect(result.ok).toBe(main >= 30);
        expect(result.wallet).toBe(entity);
        expect(read).toHaveBeenCalledOnce();
        expect(events.filter((event) => event.event === 'operation.terminal')).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
          operation: 'wallet.balance.precheck',
          outcome: main >= 30 ? 'succeeded' : 'rejected',
          outcome_known: true,
        });
        expect(events.at(-1)).not.toHaveProperty('wallet');
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('does not change the original error or retry when the wallet query fails', async () => {
    const events: ObservationEvent[] = [];
    const observer = createObserver([
      (event) => {
        events.push(event);
      },
    ]);
    const spy = vi.spyOn(observation, 'observe').mockImplementation(observer.observe);
    try {
      const repo = new MiniappWalletRepository();
      const err = Object.assign(new Error('private-wallet'), { code: 'ECONNRESET' });
      const read = vi.spyOn(repo, 'getOrCreate').mockRejectedValueOnce(err);
      await expect(repo.precheckMainCredits('user', 30)).rejects.toBe(err);
      expect(read).toHaveBeenCalledOnce();
      expect(events.at(-1)).toMatchObject({
        outcome: 'failed',
        outcome_known: false,
        err: { code: 'ECONNRESET' },
      });
      expect(JSON.stringify(events)).not.toContain('private');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('formatSpendingStatus', () => {
  it('shows the three settlement paths directly', () => {
    expect(formatSpendingStatus('pending', { reply_outcome: 'incomplete' })).toBe('待结算');
    expect(formatSpendingStatus('charged', { reply_outcome: 'complete' })).toBe('已扣费');
    expect(formatSpendingStatus('failed', { reply_outcome: 'incomplete' })).toBe('截断未扣除');
    expect(formatSpendingStatus('failed', { reply_outcome: 'empty' })).toBe('生成失败，未扣除');
  });

  it('maps legacy technical metadata to experience-based labels', () => {
    expect(formatSpendingStatus('failed', { finish_reason: 'content_filter' })).toBe('截断未扣除');
    expect(formatSpendingStatus('failed', { chat_status: 'upstream_error' })).toBe(
      '生成失败，未扣除'
    );
  });
});

describe('toWalletBalance', () => {
  it('exposes credits as the conserved total', () => {
    expect(toWalletBalance(wallet())).toMatchObject({
      main_credits: 80,
      bonus_credits: 40,
      total_credits: 120,
      credits: 120,
    });
  });

  it('preserves legacy one-decimal balances from NUMERIC(14,1)', () => {
    expect(
      toWalletBalance(
        wallet({ main_credits: 1786, bonus_credits: 13719.6, total_credits: 15505.6 })
      )
    ).toMatchObject({
      main_credits: 1786,
      bonus_credits: 13719.6,
      total_credits: 15505.6,
      credits: 15505.6,
    });
  });

  it('does not invent a total when the stored split is inconsistent', () => {
    expect(() => toWalletBalance(wallet({ total_credits: 999 }))).toThrow('钱包余额不守恒');
  });
});

describe('toClaimedCheckin', () => {
  it('passes through a VIP absolute reward split', () => {
    expect(
      toClaimedCheckin({
        claimed_at: '2026-09-22T00:00:00.000Z',
        next_claim_at: '2026-09-23T00:00:00.000Z',
        reward_credits: 150,
        base_reward_credits: 0,
        vip_reward_credits: 150,
      })
    ).toMatchObject({ reward_credits: 150, base_reward_credits: 0, vip_reward_credits: 150 });
  });

  it('refuses a split that does not add up to the granted total', () => {
    expect(() =>
      toClaimedCheckin({
        claimed_at: '2026-09-22T00:00:00.000Z',
        next_claim_at: '2026-09-23T00:00:00.000Z',
        reward_credits: 60,
        base_reward_credits: 60,
        vip_reward_credits: 60,
      })
    ).toThrow('签到奖励拆分与总额不一致');
  });
});

describe('VIP purchase catalog', () => {
  it('rejects every non-true switch value', () => {
    expect(parseVipPurchaseEnabled(true)).toBe(true);
    expect(parseVipPurchaseEnabled(false)).toBe(false);
    expect(parseVipPurchaseEnabled(null)).toBe(false);
    expect(parseVipPurchaseEnabled('true')).toBe(false);
  });

  it('returns only the month plan and marks it unavailable while purchase is closed', () => {
    const closed = buildVipPlans(false);
    const open = buildVipPlans(true);
    expect(VipPlansSchema.parse(closed).map((plan) => plan.available)).toEqual([false]);
    expect(
      VipPlansSchema.parse(open).map((plan) => [plan.id, plan.price_cents, plan.available])
    ).toEqual([['month', 200, true]]);
  });
});

describe('LLM spending snapshot', () => {
  it('keeps old rows valid when price fields are absent and still labels partial', () => {
    const legacy = mapLlmSpendingRow({
      charge_key: 'old',
      model_id: 'm',
      model_display_name: '旧模型',
      charged_amount: 10,
      status: 'partial',
      metadata: { finish_reason: 'stop' },
      created_at: '2026-09-01T00:00:00.000Z',
    });
    expect(legacy.status).toBe('partial');
    expect(legacy.status_label).toBe('余额不足，部分扣费');
    expect(legacy.main_delta).toBeUndefined();
    expect(legacy.original_amount).toBeUndefined();
  });

  it('returns the wallet split and price snapshot for a new debit', () => {
    const row = mapLlmSpendingRow({
      charge_key: 'new',
      model_id: 'premium',
      model_display_name: '旗舰',
      charged_amount: 48,
      status: 'charged',
      metadata: {
        finish_reason: 'stop',
        reply_outcome: 'complete',
        main_delta: -20,
        bonus_delta: -28,
        original_credits: 50,
        discount_rate: 0.95,
      },
      created_at: '2026-09-22T00:00:00.000Z',
    });
    expect(row).toMatchObject({
      charged_amount: 48,
      main_delta: -20,
      bonus_delta: -28,
      original_amount: 50,
      discount_rate: 0.95,
      status_label: '已扣费',
    });
  });

  it('maps an original-path refund without dropping the debit reference', () => {
    const row = mapLlmRefundSpendingRow({
      reference_id: 'llm-refund:charge-1',
      amount: 48,
      main_delta: 20,
      bonus_delta: 28,
      metadata: { debit_key: 'charge-1', reason: 'llm_usage' },
      created_at: '2026-09-22T00:01:00.000Z',
    });
    expect(row).toMatchObject({
      refund_of: 'charge-1',
      source_label: '原路退款',
      main_delta: 20,
      bonus_delta: 28,
      status_label: '已原路退回',
    });
  });
});

describe('listSpending image ledger coverage', () => {
  beforeEach(() => {
    spendingDb.ledger = [];
    spendingDb.charges = [];
    spendingDb.ledgerError = null;
    spendingDb.signals = [];
  });

  it('includes both image debit types, excludes other users and types, and sorts with voice', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const otherUserId = '00000000-0000-4000-8000-000000000002';
    const entry = (
      reference_id: string,
      reference_type: string,
      amount: number | string,
      minute: string,
      user_id = userId
    ): LedgerFixtureRow => ({
      user_id,
      reference_id,
      reference_type,
      entry_type: reference_type,
      amount,
      metadata: {},
      created_at: `2026-10-23T12:${minute}:00.000Z`,
    });
    spendingDb.ledger = [
      entry('character-image', 'image_generation', '-10.0', '01'),
      entry('other-plaza', 'image_plaza_generation', -999, '07', otherUserId),
      entry('plaza-attempt', 'image_plaza_generation', '-25.5', '03'),
      entry('recharge', 'payment_order', 100, '06'),
      entry('voice', 'voice_usage', -5, '02'),
      entry('other-character-image', 'image_generation', -888, '05', otherUserId),
      entry('share-reward', 'image_plaza_share_reward', 3, '04'),
    ];

    const records = await new MiniappWalletRepository().listSpending(userId);

    expect(
      records.map(({ id, charged_amount, created_at }) => ({ id, charged_amount, created_at }))
    ).toEqual([
      {
        id: 'plaza-attempt',
        charged_amount: 25.5,
        created_at: '2026-10-23T12:03:00.000Z',
      },
      {
        id: 'voice',
        charged_amount: 5,
        created_at: '2026-10-23T12:02:00.000Z',
      },
      {
        id: 'character-image',
        charged_amount: 10,
        created_at: '2026-10-23T12:01:00.000Z',
      },
    ]);
    expect(records.filter((record) => record.model_display_name === '图片消费')).toHaveLength(2);
    expect(
      records.every((record) => record.status === 'charged' && record.charged_amount > 0)
    ).toBe(true);
  });

  it('lists text charges from usage_charges, only rows that were actually charged', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const charge = (id: string, minute: string, extra: Record<string, unknown> = {}) => ({
      id,
      user_id: userId,
      kind: 'chat_text',
      status: 'charged',
      charged_credits: '12.0',
      generation_id: null,
      created_at: `2026-11-21T01:${minute}:00.000Z`,
      charge: {
        model_id: 'model-a',
        model_display_name: '模型 A',
        metadata: { finish_reason: 'stop', original_credits: 15, discount_rate: null },
        charged_at: `2026-11-21T09:${minute}:30+08:00`,
      },
      ...extra,
    });
    spendingDb.charges = [
      charge('charged', '02'),
      charge('free', '03', { status: 'free', charged_credits: '0.0' }),
      // A quote that never reached the charge step has no quote.charge.
      charge('quoted-only', '04', { status: 'quoted', charge: null }),
      charge('other-user', '05', { user_id: '00000000-0000-4000-8000-000000000002' }),
    ];

    const records = await new MiniappWalletRepository().listSpending(userId);

    expect(
      records.map(({ id, status, charged_amount }) => ({ id, status, charged_amount }))
    ).toEqual([
      { id: 'free', status: 'free', charged_amount: 0 },
      { id: 'charged', status: 'charged', charged_amount: 12 },
    ]);
    expect(records[1]).toMatchObject({
      model_id: 'model-a',
      model_display_name: '模型 A',
      finish_reason: 'stop',
      original_amount: 15,
      discount_rate: null,
      // The consumption record shows the charge time, not the turn start.
      created_at: '2026-11-21T09:02:30+08:00',
    });
  });

  it('returns no spending when no matching ledger entries exist', async () => {
    expect(await new MiniappWalletRepository().listSpending('no-ledger-user')).toEqual([]);
  });

  it('includes separate video reserve/refund rows with exact split, ownership and stable keys', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const debit: LedgerFixtureRow = {
      id: 'reserve-ledger',
      user_id: userId,
      reference_type: 'media_plaza_video_reserve',
      reference_id: 'same-attempt',
      entry_type: 'media_plaza_video_reserve',
      amount: '-40.5',
      main_delta: '-10.0',
      bonus_delta: '-30.5',
      metadata: {},
      created_at: '2026-11-18T14:00:00Z',
    };
    spendingDb.ledger = [
      debit,
      {
        ...debit,
        id: 'refund-ledger',
        reference_type: 'media_plaza_video_refund',
        entry_type: 'media_plaza_video_refund',
        amount: '40.5',
        main_delta: '10.0',
        bonus_delta: '30.5',
        created_at: '2026-11-18T14:01:00Z',
      },
      { ...debit, user_id: 'another-user', reference_id: 'private' },
      { ...debit, reference_type: 'image_plaza_share_reward', reference_id: 'reward' },
    ];
    const records = await new MiniappWalletRepository().listSpending(userId);
    expect(records).toEqual([
      expect.objectContaining({
        id: 'video-refund:same-attempt',
        charged_amount: 40.5,
        model_display_name: '视频退款',
        main_delta: 10,
        bonus_delta: 30.5,
        source_label: '原路退款',
        refund_of: 'video:same-attempt',
        status_label: '已原路退回',
      }),
      expect.objectContaining({
        id: 'video:same-attempt',
        charged_amount: 40.5,
        model_display_name: '视频消费',
        main_delta: -10,
        bonus_delta: -30.5,
        status_label: '已预扣',
      }),
    ]);
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
    expect(spendingDb.signals).toHaveLength(3);
  });

  it('rejects ledger read failures instead of returning partial spending', async () => {
    spendingDb.ledgerError = { code: '57014' };
    await expect(new MiniappWalletRepository().listSpending('user')).rejects.toThrow(
      '查询媒体消费明细失败'
    );
  });
});

describe('chargeLlmUsage archived result', () => {
  const input = {
    chargeId: 'charge-1',
    generationId: 'gen-1',
    userId: 'user-1',
    modelId: null,
    modelOpenRouterId: 'test/model',
    modelDisplayName: 'Test',
    catalogVersion: 1,
    pricingConfigVersion: 1,
    usageCostUsd: null,
    exchangeRate: 1,
    modelMarkup: 1,
    calculatedAmount: 50,
    fallbackUsed: false,
  };
  const archived = {
    charge_key: 'charge-1',
    generation_id: 'gen-1',
    user_id: 'user-1',
    status: 'failed',
    charged_amount: 0,
  };

  it('accepts permanent zero-charge proof without manufacturing a wallet or charge detail', async () => {
    spendingDb.rpc.mockResolvedValueOnce({
      data: { charge_status: 'already_archived', archived_charge: archived },
      error: null,
    });
    const result = await new MiniappWalletRepository().chargeLlmUsage(input);
    expect(result).toEqual({ kind: 'archived', archivedCharge: archived, alreadyCharged: true });
    expect(result).not.toHaveProperty('charge');
    expect(result).not.toHaveProperty('wallet');
  });

  it.each([
    null,
    { charge_status: 'already_charged', charge: null, wallet: null },
    { charge_status: 'already_archived', archived_charge: { ...archived, status: 'pending' } },
    {
      charge_status: 'already_archived',
      archived_charge: { ...archived, user_id: 'another-user' },
    },
    {
      charge_status: 'already_archived',
      archived_charge: { ...archived, charged_amount: 'invalid' },
    },
    {
      charge_status: 'already_archived',
      archived_charge: { ...archived, charge_key: 'other', generation_id: 'other' },
    },
  ])('rejects incomplete or mismatched proof %j', async (data) => {
    spendingDb.rpc.mockResolvedValueOnce({ data, error: null });
    await expect(new MiniappWalletRepository().chargeLlmUsage(input)).rejects.toThrow(
      '记录 LLM 用量扣费失败'
    );
  });
});
