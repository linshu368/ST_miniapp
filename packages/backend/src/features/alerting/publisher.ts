import { AlertEvaluationSchema, type AlertEvaluation } from '@miniapp/shared';
import type { Logger } from '../../lib/logger.js';
import { createSafeAlertCard, type SafeAlertCard } from './safe-card.js';
import type { AlertPersistence } from './repository.js';

export type AlertPublishResult =
  | { kind: 'accepted'; notification_key?: string }
  | { kind: 'duplicate' }
  | { kind: 'failed'; reason: 'invalid_evaluation' | 'unsafe_card' | 'persistence_failed' };

/** Public domain-neutral entry point. Acceptance means DB state/outbox persisted, never delivery. */
export class AlertPublisher {
  constructor(
    private readonly persistence: AlertPersistence,
    private readonly log: Pick<Logger, 'biz' | 'sys'>
  ) {}

  async publish(input: unknown, options?: { notify?: boolean }): Promise<AlertPublishResult> {
    const parsed = AlertEvaluationSchema.safeParse(input);
    if (!parsed.success) return { kind: 'failed', reason: 'invalid_evaluation' };
    const evaluation = parsed.data;
    let cards: Record<'firing' | 'escalated' | 'recovered', SafeAlertCard>;
    try {
      cards = {
        firing: createSafeAlertCard(
          evaluation,
          'firing',
          `${evaluation.fingerprint}:firing:${evaluation.evaluation_id}`
        ),
        escalated: createSafeAlertCard(
          evaluation,
          'escalated',
          `${evaluation.fingerprint}:escalated:${evaluation.evaluation_id}`
        ),
        recovered: createSafeAlertCard(
          evaluation,
          'recovered',
          `${evaluation.fingerprint}:recovered:${evaluation.evaluation_id}`
        ),
      };
    } catch (err) {
      this.log.sys.warn(
        { event: 'alert.publish.unsafe_card', err, fingerprint: evaluation.fingerprint },
        '告警卡片被安全策略拒绝'
      );
      return { kind: 'failed', reason: 'unsafe_card' };
    }
    try {
      const result = await this.persistence.persist({
        evaluation,
        cards,
        notify: options?.notify,
      });
      this.log.biz.info(
        { event: 'alert.publish', result: result.kind, fingerprint: evaluation.fingerprint },
        '告警评估已处理'
      );
      return result.kind === 'accepted'
        ? {
            kind: 'accepted',
            ...(result.notificationKey ? { notification_key: result.notificationKey } : {}),
          }
        : { kind: 'duplicate' };
    } catch (err) {
      this.log.sys.error(
        { event: 'alert.publish.failed', err, fingerprint: evaluation.fingerprint },
        '告警评估持久化失败'
      );
      return { kind: 'failed', reason: 'persistence_failed' };
    }
  }
}
