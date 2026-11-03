import { setTimeout as sleep } from 'node:timers/promises';
import { getDomainDb } from '../../../lib/supabase.js';
import type { Logger } from '../../../lib/logger.js';
import { AlertPublisher } from '../../alerting/publisher.js';
import {
  evaluatePaymentAlertRules,
  FEISHU_NOTIFY_RULE_IDS,
  recoveryPassesFor,
  type PaymentAlertSnapshot,
  type PaymentOperation,
} from '../domain/PaymentAlertRules.js';

const MAX_EVENTS = 2_000;
const QUERY_TIMEOUT_MS = 8_000;

/** Read-only, bounded monitor repository. It reads payment operation facts only, never gateway payloads. */
export class PaymentAlertMonitorRepository {
  private readonly db = getDomainDb('billing');
  async snapshot(now: Date): Promise<PaymentAlertSnapshot> {
    const since = new Date(now.getTime() - 60 * 60_000).toISOString();
    // 取最新的 N 条再翻成升序：事件超过上限时丢的是最早的，而不是最新的。
    const { data, error } = await withTimeout(
      Promise.resolve(
        this.db
          .from('payment_operation_events')
          .select('event_kind,outcome,trigger,occurred_at,error_class,duration_ms,order_id,user_id')
          .gte('occurred_at', since)
          .lte('occurred_at', now.toISOString())
          .order('occurred_at', { ascending: false })
          .limit(MAX_EVENTS)
      ),
      QUERY_TIMEOUT_MS
    );
    if (error) throw new Error(`payment alert event scan failed: ${error.message}`);
    return { operations: ((data ?? []) as PaymentOperation[]).reverse() };
  }
}

export class PaymentAlertMonitor {
  private healthyWindows = new Map<string, number>();
  constructor(
    private readonly repository: Pick<PaymentAlertMonitorRepository, 'snapshot'>,
    private readonly publisher: Pick<AlertPublisher, 'publish'>,
    private readonly log: Pick<Logger, 'biz' | 'sys'>
  ) {}
  async runOnce(now = new Date()): Promise<{ published: number }> {
    const snapshot = await retry(() => this.repository.snapshot(now), 2);
    const evaluations = evaluatePaymentAlertRules(snapshot, now)
      .filter(
        (evaluation) =>
          evaluation.severity === 'P0' ||
          FEISHU_NOTIFY_RULE_IDS.has(evaluation.rule_id) ||
          now.getUTCMinutes() % 5 === 0
      )
      .filter((evaluation) => {
        const count =
          evaluation.state === 'healthy'
            ? (this.healthyWindows.get(evaluation.rule_id) ?? 0) + 1
            : 0;
        this.healthyWindows.set(evaluation.rule_id, count);
        // Do not let one complete window recover an incident; query failures never reach this point.
        return evaluation.state === 'firing' || count >= recoveryPassesFor(evaluation.rule_id);
      });
    let published = 0;
    for (const evaluation of evaluations) {
      const result = await this.publisher.publish(evaluation, {
        notify: FEISHU_NOTIFY_RULE_IDS.has(evaluation.rule_id),
      });
      if (result.kind === 'accepted') published++;
    }
    this.log.biz.info(
      { event: 'payment.alert_monitor.heartbeat', scannedRules: evaluations.length, published },
      '支付告警监控轮次完成'
    );
    return { published };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error('payment alert query timed out');
    }),
  ]);
}

async function retry<T>(work: () => Promise<T>, attempts: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await work();
    } catch (err) {
      last = err;
      if (i + 1 < attempts) await sleep(100 * (i + 1));
    }
  }
  throw last;
}
