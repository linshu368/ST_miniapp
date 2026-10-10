import { describe, expect, it } from 'vitest';
import { ALERT_SCHEMA_VERSION, AlertEvaluationSchema } from '../api/alerting.js';

const evaluation = {
  schema_version: ALERT_SCHEMA_VERSION,
  evaluation_id: 'e26b3b9b-4d2e-4e4d-8d11-0f2a9bd42b01',
  producer_run_id: '6e426dde-ff9d-4ed1-b4d0-84b1797ca821',
  domain: 'payment',
  service: 'backend',
  environment: 'production',
  rule_id: 'p0-01',
  rule_version: 'v1',
  rule_group: 'payment-checkout-failure',
  fingerprint: 'production:payment:payment-checkout-failure:all',
  state: 'firing',
  severity: 'P0',
  location: { kind: 'dependency', component: 'payment_gateway' },
  confidence: 'suspected',
  observed_at: '2026-10-10T09:00:00.000Z',
  window_started_at: '2026-10-10T08:55:00.000Z',
  window_ended_at: '2026-10-10T09:00:00.000Z',
  title: '支付收银台疑似异常',
  summary: '多个独立用户在窗口内未完成付款。',
  metrics: [{ name: 'affected_users', value: 3, unit: 'count' }],
  samples: [{ kind: 'payment_attempt', reference: 'attempt:7f3a', summary: '已脱敏样本' }],
  recommended_action: '检查支付网关与最近配置变更。',
};

describe('AlertEvaluationSchema', () => {
  it('accepts a bounded, channel-independent evaluation', () => {
    expect(AlertEvaluationSchema.parse(evaluation)).toEqual(evaluation);
  });

  it('rejects arbitrary evidence and an invalid alert window', () => {
    expect(
      AlertEvaluationSchema.safeParse({
        ...evaluation,
        samples: [{ ...evaluation.samples[0], raw_error: 'provider response' }],
      }).success
    ).toBe(false);
    expect(
      AlertEvaluationSchema.safeParse({
        ...evaluation,
        window_started_at: '2026-10-10T09:01:00.000Z',
      }).success
    ).toBe(false);
  });

  it('rejects duplicate metric names and unbounded samples', () => {
    expect(
      AlertEvaluationSchema.safeParse({
        ...evaluation,
        metrics: [evaluation.metrics[0], evaluation.metrics[0]],
      }).success
    ).toBe(false);
    expect(
      AlertEvaluationSchema.safeParse({
        ...evaluation,
        samples: Array.from({ length: 11 }, () => evaluation.samples[0]),
      }).success
    ).toBe(false);
  });
});
