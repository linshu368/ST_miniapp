import { describe, expect, it } from 'vitest';
import { AlertEvaluationSchema } from '@miniapp/shared';

import { createSafeAlertCard } from '../../alerting/safe-card.js';

import {
  evaluatePaymentAlertRules,
  FEISHU_NOTIFY_RULE_IDS,
  P0_PAID_NOT_FULFILLED_RULE_ID,
  P0_PROVIDER_CREATE_FAILING_RULE_ID,
  P1_PROVIDER_QUERY_FAILING_RULE_ID,
  P1_REFUND_RULE_ID,
  P1_WEBHOOK_REJECTED_RULE_ID,
  type PaymentOperation,
  P1_PROVIDER_DEGRADED_RULE_ID,
  P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID,
} from './PaymentAlertRules.js';

const NOW = new Date('2026-11-03T08:00:00.000Z');

function op(
  minutesAgo: number,
  overrides: Partial<PaymentOperation> & Pick<PaymentOperation, 'event_kind' | 'outcome'>
): PaymentOperation {
  return {
    trigger: 'create_order',
    occurred_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    error_class: null,
    order_id: null,
    user_id: null,
    ...overrides,
  };
}

function evaluate(operations: PaymentOperation[]) {
  const evaluations = evaluatePaymentAlertRules({ operations }, NOW);
  return {
    evaluations,
    state: (ruleId: string) => evaluations.find((e) => e.rule_id === ruleId)?.state,
    get: (ruleId: string) => evaluations.find((e) => e.rule_id === ruleId)!,
  };
}

describe('payment alert rules v3', () => {
  it('is healthy with no traffic', () => {
    const { evaluations } = evaluate([]);
    expect(evaluations.every((e) => e.state === 'healthy')).toBe(true);
  });

  it('emits schema-valid, confirmed evaluations with stable fingerprints', () => {
    const { evaluations } = evaluate([]);
    for (const evaluation of evaluations) {
      expect(AlertEvaluationSchema.safeParse(evaluation).success).toBe(true);
      expect(evaluation.confidence).toBe('confirmed');
      // 指纹只含环境与规则，不含版本、时间、级别或用户，事故才能跨轮次合并。
      expect(evaluation.fingerprint).toBe(
        `${evaluation.environment}:payment:${evaluation.rule_id}:all`
      );
    }
  });

  it('produces cards the delivery safety policy accepts, firing or healthy', () => {
    const firingAll = evaluate([
      ...[5, 3, 1].map((m) =>
        op(m, { event_kind: 'gateway_create', outcome: 'failed', error_class: 'timeout' })
      ),
      op(2, {
        event_kind: 'settlement',
        outcome: 'failed',
        error_class: 'settlement_failed',
        order_id: 'MA_00000000-0000-0000-0000-000000000001_1793689726000_0001',
      }),
      op(2, { event_kind: 'webhook', outcome: 'failed', error_class: 'refund', order_id: 'MA_1' }),
      ...Array.from({ length: 14 }, () => 4).map((m) =>
        op(m, { event_kind: 'fast_reconcile', outcome: 'failed', error_class: 'timeout' })
      ),
      ...[4, 3, 2].map((m) =>
        op(m, { event_kind: 'webhook', outcome: 'failed', error_class: 'signature_invalid' })
      ),
      ...[4, 3, 2].map((m) =>
        op(m, { event_kind: 'fast_reconcile', outcome: 'succeeded', error_class: 'slow' })
      ),
      ...['PF1', 'PF2', 'PF3'].map((id) =>
        op(6, {
          event_kind: 'fast_reconcile',
          outcome: 'unpaid',
          error_class: 'provider_failed',
          order_id: id,
        })
      ),
    ]).evaluations;
    expect(firingAll.filter((e) => e.state !== 'firing').map((e) => e.rule_id)).toEqual([]);
    for (const evaluation of [...firingAll, ...evaluate([]).evaluations]) {
      expect(() => createSafeAlertCard(evaluation, 'firing', 'key')).not.toThrow();
    }
  });

  describe('provider create failing', () => {
    const failed = (minutesAgo: number, errorClass: string) =>
      op(minutesAgo, { event_kind: 'gateway_create', outcome: 'failed', error_class: errorClass });
    const succeeded = (minutesAgo: number) =>
      op(minutesAgo, { event_kind: 'gateway_create', outcome: 'succeeded' });

    it('fires when the last three creates failed and names the provider error classes', () => {
      const { get } = evaluate([
        succeeded(9),
        failed(5, 'method_maintenance'),
        failed(3, 'method_maintenance'),
        failed(1, 'provider_unavailable'),
      ]);
      const evaluation = get(P0_PROVIDER_CREATE_FAILING_RULE_ID);
      expect(evaluation.state).toBe('firing');
      expect(evaluation.summary).toContain('渠道维护×2');
      expect(evaluation.summary).toContain('平台不可用×1');
    });

    it('stays healthy once a create succeeds again', () => {
      const { state } = evaluate([
        failed(6, 'timeout'),
        failed(5, 'timeout'),
        failed(4, 'timeout'),
        succeeded(1),
      ]);
      expect(state(P0_PROVIDER_CREATE_FAILING_RULE_ID)).toBe('healthy');
    });

    it('ignores failures older than ten minutes', () => {
      const { state } = evaluate([
        failed(15, 'network'),
        failed(13, 'network'),
        failed(11, 'network'),
      ]);
      expect(state(P0_PROVIDER_CREATE_FAILING_RULE_ID)).toBe('healthy');
    });
  });

  describe('paid but not fulfilled', () => {
    it('fires for a settlement failure that no later settlement resolved', () => {
      const { get } = evaluate([
        op(2, {
          event_kind: 'settlement',
          outcome: 'failed',
          error_class: 'settlement_failed',
          order_id: 'MA_1',
        }),
      ]);
      expect(get(P0_PAID_NOT_FULFILLED_RULE_ID).state).toBe('firing');
      expect(get(P0_PAID_NOT_FULFILLED_RULE_ID).summary).toContain('MA_1');
    });

    it('recovers when the same order settles afterwards', () => {
      const { state } = evaluate([
        op(3, {
          event_kind: 'settlement',
          outcome: 'failed',
          error_class: 'settlement_failed',
          order_id: 'MA_1',
        }),
        op(1, { event_kind: 'settlement', outcome: 'succeeded', order_id: 'MA_1' }),
      ]);
      expect(state(P0_PAID_NOT_FULFILLED_RULE_ID)).toBe('healthy');
    });

    it('treats a reconciliation currency mismatch as paid-not-fulfilled', () => {
      const { state } = evaluate([
        op(1, {
          event_kind: 'fast_reconcile',
          outcome: 'failed',
          error_class: 'currency_mismatch',
          order_id: 'MA_2',
        }),
      ]);
      expect(state(P0_PAID_NOT_FULFILLED_RULE_ID)).toBe('firing');
    });
  });

  it('flags refunds and chargebacks for manual follow-up', () => {
    const { state } = evaluate([
      op(30, { event_kind: 'webhook', outcome: 'failed', error_class: 'refund', order_id: 'MA_3' }),
    ]);
    expect(state(P1_REFUND_RULE_ID)).toBe('firing');
  });

  describe('provider query failing', () => {
    it('fires when most queries fail', () => {
      const { state } = evaluate([
        op(5, { event_kind: 'fast_reconcile', outcome: 'failed', error_class: 'timeout' }),
        op(4, { event_kind: 'fast_reconcile', outcome: 'failed', error_class: 'timeout' }),
        op(3, { event_kind: 'payment_query', outcome: 'failed', error_class: 'network' }),
      ]);
      expect(state(P1_PROVIDER_QUERY_FAILING_RULE_ID)).toBe('firing');
    });

    it('does not count per-order anomalies or skipped queries as interface failures', () => {
      const { state } = evaluate([
        op(5, {
          event_kind: 'fast_reconcile',
          outcome: 'failed',
          error_class: 'provider_not_found',
        }),
        op(4, {
          event_kind: 'fast_reconcile',
          outcome: 'failed',
          error_class: 'provider_ref_mismatch',
        }),
        op(3, {
          event_kind: 'payment_query',
          outcome: 'skipped',
          error_class: 'missing_provider_ref',
        }),
        op(2, { event_kind: 'payment_query', outcome: 'failed', error_class: 'timeout' }),
      ]);
      expect(state(P1_PROVIDER_QUERY_FAILING_RULE_ID)).toBe('healthy');
    });
  });

  it('flags repeated webhook signature failures but not foreign-environment skips', () => {
    const rejected = (minutesAgo: number) =>
      op(minutesAgo, {
        event_kind: 'webhook',
        outcome: 'failed',
        error_class: 'signature_invalid',
      });
    const skipped = (minutesAgo: number) =>
      op(minutesAgo, {
        event_kind: 'webhook',
        outcome: 'skipped',
        error_class: 'foreign_environment',
      });

    expect(
      evaluate([rejected(3), rejected(2), rejected(1)]).state(P1_WEBHOOK_REJECTED_RULE_ID)
    ).toBe('firing');
    expect(evaluate([skipped(3), skipped(2), skipped(1)]).state(P1_WEBHOOK_REJECTED_RULE_ID)).toBe(
      'healthy'
    );
  });

  describe('provider degraded (early warning)', () => {
    const create = (minutesAgo: number, outcome: 'failed' | 'succeeded', durationMs = 800) =>
      op(minutesAgo, {
        event_kind: 'gateway_create',
        outcome,
        error_class: outcome === 'failed' ? 'timeout' : null,
        duration_ms: durationMs,
      });
    const slowProbe = (minutesAgo: number) =>
      op(minutesAgo, {
        event_kind: 'fast_reconcile',
        outcome: 'succeeded',
        error_class: 'slow',
        trigger: 'fast_reconcile',
        duration_ms: 4200,
      });

    it('fires on intermittent create failures before three in a row', () => {
      const { state, get } = evaluate([
        create(6, 'failed'),
        create(5, 'succeeded'),
        create(3, 'failed'),
        create(1, 'succeeded'),
      ]);
      expect(state(P0_PROVIDER_CREATE_FAILING_RULE_ID)).toBe('healthy');
      expect(state(P1_PROVIDER_DEGRADED_RULE_ID)).toBe('firing');
      expect(get(P1_PROVIDER_DEGRADED_RULE_ID).summary).toContain('超时×2');
    });

    it('fires when several calls are slow even though nothing has failed', () => {
      const { state } = evaluate([
        create(5, 'succeeded', 3600),
        create(3, 'succeeded', 5200),
        slowProbe(2),
      ]);
      expect(state(P1_PROVIDER_DEGRADED_RULE_ID)).toBe('firing');
    });

    it('stays quiet for a single failure or a couple of slow calls', () => {
      expect(
        evaluate([create(5, 'failed'), create(4, 'succeeded'), create(3, 'succeeded')]).state(
          P1_PROVIDER_DEGRADED_RULE_ID
        )
      ).toBe('healthy');
      expect(
        evaluate([slowProbe(4), create(3, 'succeeded', 3500)]).state(P1_PROVIDER_DEGRADED_RULE_ID)
      ).toBe('healthy');
    });

    it('leaves the warning to the P0 rule once creates fail three times in a row', () => {
      const { state } = evaluate([create(4, 'failed'), create(3, 'failed'), create(2, 'failed')]);
      expect(state(P0_PROVIDER_CREATE_FAILING_RULE_ID)).toBe('firing');
      expect(state(P1_PROVIDER_DEGRADED_RULE_ID)).toBe('healthy');
    });

    it('does not count slow lookups as query failures', () => {
      const { state } = evaluate([slowProbe(4), slowProbe(3), slowProbe(2)]);
      expect(state(P1_PROVIDER_QUERY_FAILING_RULE_ID)).toBe('healthy');
    });
  });

  describe('provider pay failure rate (early warning)', () => {
    const failed = (minutesAgo: number, id: string) =>
      op(minutesAgo, {
        event_kind: 'fast_reconcile',
        outcome: 'unpaid',
        error_class: 'provider_failed',
        order_id: id,
        trigger: 'fast_reconcile',
      });
    const paid = (minutesAgo: number, id: string) =>
      op(minutesAgo, { event_kind: 'settlement', outcome: 'succeeded', order_id: id });

    it('fires when most terminal payments in 30 minutes failed', () => {
      const { state, get } = evaluate([
        failed(25, 'A'),
        failed(20, 'B'),
        failed(10, 'C'),
        paid(8, 'D'),
      ]);
      expect(state(P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID)).toBe('firing');
      expect(get(P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID).summary).toContain('75%');
    });

    it('stays quiet when failures are a minority or too few', () => {
      expect(
        evaluate([failed(5, 'A'), failed(4, 'B'), paid(3, 'C'), paid(2, 'D'), paid(1, 'E')]).state(
          P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID
        )
      ).toBe('healthy');
      expect(
        evaluate([failed(5, 'A'), failed(4, 'B')]).state(P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID)
      ).toBe('healthy');
    });

    it('counts each order once and ignores expired or cancelled orders', () => {
      const dup = [failed(5, 'A'), failed(4, 'A'), failed(3, 'A')];
      const abandoned = ['provider_expired', 'provider_cancelled'].flatMap((cls) =>
        ['X', 'Y', 'Z'].map((id) =>
          op(3, { event_kind: 'fast_reconcile', outcome: 'unpaid', error_class: cls, order_id: id })
        )
      );
      expect(evaluate([...dup, ...abandoned]).state(P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID)).toBe(
        'healthy'
      );
    });

    it('ignores failures older than 30 minutes', () => {
      expect(
        evaluate([failed(40, 'A'), failed(35, 'B'), failed(31, 'C')]).state(
          P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID
        )
      ).toBe('healthy');
    });
  });

  it('notifies Feishu for payment blocking, unfulfilled payments, refunds, and provider early warnings', () => {
    expect([...FEISHU_NOTIFY_RULE_IDS].sort()).toEqual(
      [
        P0_PAID_NOT_FULFILLED_RULE_ID,
        P0_PROVIDER_CREATE_FAILING_RULE_ID,
        P1_REFUND_RULE_ID,
        P1_PROVIDER_QUERY_FAILING_RULE_ID,
        P1_PROVIDER_DEGRADED_RULE_ID,
        P1_PROVIDER_PAY_FAILURE_RATE_RULE_ID,
      ].sort()
    );
  });
});
