import { describe, expect, it } from 'vitest';
import { VipPlansSchema } from '@miniapp/shared';

import {
  formatSpendingStatus,
  mapLlmRefundSpendingRow,
  mapLlmSpendingRow,
  toClaimedCheckin,
  toWalletBalance,
  type MiniappWalletRow,
} from './MiniappWalletRepository.js';
import {
  buildVipPlans,
  parseVipPurchaseEnabled,
} from '../../features/payment/domain/rechargeRules.js';

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

  it('does not invent a total when the stored split is inconsistent', () => {
    expect(() => toWalletBalance(wallet({ total_credits: 999 }))).toThrow('钱包余额不守恒');
  });
});

describe('toClaimedCheckin', () => {
  it('passes through a 60 and 120 reward split', () => {
    expect(
      toClaimedCheckin({
        claimed_at: '2026-09-22T00:00:00.000Z',
        next_claim_at: '2026-09-23T00:00:00.000Z',
        reward_credits: 120,
        base_reward_credits: 60,
        vip_reward_credits: 60,
      })
    ).toMatchObject({ reward_credits: 120, base_reward_credits: 60, vip_reward_credits: 60 });
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
      ['week', 1399, true],
      ['month', 2888, true],
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
