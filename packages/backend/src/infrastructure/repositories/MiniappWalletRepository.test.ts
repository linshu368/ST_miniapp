import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VipPlansSchema } from '@miniapp/shared';

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
  user_id: string;
  reference_type: string;
  reference_id: string;
  entry_type: string;
  amount: number | string;
  metadata: Record<string, unknown>;
  created_at: string;
};

const spendingDb = vi.hoisted(() => ({ ledger: [] as LedgerFixtureRow[] }));

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    from: (table: string) => {
      let rows: LedgerFixtureRow[] = table === 'wallet_ledger' ? [...spendingDb.ledger] : [];
      const query = {
        select: () => query,
        eq: (column: keyof LedgerFixtureRow, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
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
        limit: async (count: number) => ({ data: rows.slice(0, count), error: null }),
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

  it('returns both canonical plans and marks them unavailable while purchase is closed', () => {
    const closed = buildVipPlans(false);
    const open = buildVipPlans(true);
    expect(VipPlansSchema.parse(closed).map((plan) => plan.available)).toEqual([false, false]);
    expect(
      VipPlansSchema.parse(open).map((plan) => [plan.id, plan.price_cents, plan.available])
    ).toEqual([
      ['week', 100, true],
      ['month', 200, true],
    ]);
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

  it('returns no spending when no matching ledger entries exist', async () => {
    expect(await new MiniappWalletRepository().listSpending('no-ledger-user')).toEqual([]);
  });
});
