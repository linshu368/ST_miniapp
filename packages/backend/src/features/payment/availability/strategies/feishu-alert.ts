import { randomUUID } from 'node:crypto';
import type { AlertEvaluation } from '@miniapp/shared';
import type { AlertPublisher } from '../../../alerting/publisher.js';
import type { PaymentAvailabilityObservation } from '../probe.js';
import type { PaymentAvailabilityStrategy } from '../strategy.js';

export const PAYMENT_AVAILABILITY_RULE = 'upstream-create-probe';

export function buildPaymentAvailabilityEvaluation(
  observation: PaymentAvailabilityObservation,
  environment: AlertEvaluation['environment']
): AlertEvaluation {
  const firing = observation.kind === 'unavailable';
  const uncertain = observation.errorClass === 'timeout' || observation.errorClass === 'network';
  return {
    schema_version: 1,
    evaluation_id: randomUUID(),
    producer_run_id: randomUUID(),
    domain: 'payment',
    service: 'payment_availability_probe',
    environment,
    rule_id: PAYMENT_AVAILABILITY_RULE,
    rule_version: '1',
    rule_group: PAYMENT_AVAILABILITY_RULE,
    fingerprint: `${environment}:payment:${PAYMENT_AVAILABILITY_RULE}:${observation.channel}`,
    state: firing ? 'firing' : 'healthy',
    severity: 'P1',
    location: { kind: 'dependency', component: 'ttzf' },
    confidence: uncertain ? 'suspected' : 'confirmed',
    observed_at: observation.observedAt,
    window_started_at: observation.startedAt,
    window_ended_at: observation.observedAt,
    title: firing ? '支付服务不可用：上游建单探测失败' : '支付上游建单探测已恢复',
    summary: `${environment} / TTZF / ${observation.channel}：${firing ? `本次 1 元建单探测失败（${observation.errorClass ?? 'response_invalid'}）` : '本次 1 元建单探测成功'}；耗时 ${observation.durationMs} ms。仅验证该渠道建单能力，不代表支付全链路。`,
    metrics: [{ name: 'duration_ms', value: observation.durationMs, unit: 'milliseconds' }],
    samples: [],
    recommended_action: firing
      ? '检查该环境商户配置、上游渠道状态及限流；不要重放探测建单或自动停用用户支付。'
      : '继续观察用户建单结果及上游限流。',
  };
}

export function createFeishuAlertStrategy(
  publisher: Pick<AlertPublisher, 'publish'>,
  environment: AlertEvaluation['environment']
): PaymentAvailabilityStrategy {
  return {
    id: 'feishu-alert',
    // Existing persistence bounds lock wait + transaction to 5s + 15s; no HTTP in this strategy.
    timeoutMs: 25_000,
    appliesTo: () => true,
    async handle(observation, signal) {
      signal.throwIfAborted();
      const result = await publisher.publish(
        buildPaymentAvailabilityEvaluation(observation, environment)
      );
      signal.throwIfAborted();
      if (result.kind === 'failed')
        throw new Error(`Payment probe alert rejected: ${result.reason}`);
      // Duplicate is also a successful durable outcome; acceptance never claims Feishu delivery.
    },
  };
}
