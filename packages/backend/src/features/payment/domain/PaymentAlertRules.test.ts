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
      ...[4, 3, 2].map((m) =>
        op(m, { event_kind: 'fast_reconcile', outcome: 'failed', error_class: 'timeout' })
      ),
      ...[4, 3, 2].map((m) =>
        op(m, { event_kind: 'webhook', outcome: 'failed', error_class: 'signature_invalid' })
      ),
    ]).evaluations;
    expect(firingAll.every((e) => e.state === 'firing')).toBe(true);
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

  it('notifies Feishu only for payment blocking, unfulfilled payments, and refunds', () => {
    expect([...FEISHU_NOTIFY_RULE_IDS].sort()).toEqual(
      [P0_PAID_NOT_FULFILLED_RULE_ID, P0_PROVIDER_CREATE_FAILING_RULE_ID, P1_REFUND_RULE_ID].sort()
    );
  });
});
