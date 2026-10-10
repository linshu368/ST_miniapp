import { setTimeout as sleep } from 'node:timers/promises';
import { getDomainDb } from '../../../lib/supabase.js';
import type { Logger } from '../../../lib/logger.js';
import { AlertPublisher } from '../../alerting/publisher.js';
import {
  evaluatePaymentAlertRules,
  type PaymentAlertSnapshot,
} from '../domain/PaymentAlertRules.js';

const MAX_ORDERS = 500;
const MAX_EVENTS = 1_000;
const QUERY_TIMEOUT_MS = 8_000;

type Row = {
  id: string;
  user_id: string;
  checkout_confirmed_at: string | null;
  status: 'pending' | 'completed' | 'expired' | 'failed';
  paid_at: string | null;
  fulfillment_applied: boolean;
  settled_by: string | null;
};
type EventRow = {
  event_kind: string;
  outcome: string;
  trigger: string;
  occurred_at: string;
  error_class: string | null;
  order_id: string | null;
  user_id: string | null;
};

/** Read-only, bounded monitor repository. It never reads gateway payloads or customer identifiers into evidence. */
export class PaymentAlertMonitorRepository {
  private readonly db = getDomainDb('billing');
  async snapshot(now: Date): Promise<PaymentAlertSnapshot> {
    const since = new Date(now.getTime() - 60 * 60_000).toISOString();
    const [ordersResult, eventsResult] = await withTimeout(
      Promise.all([
        this.db
          .from('payment_orders')
          .select('id,user_id,checkout_confirmed_at,status,paid_at,fulfillment_applied,settled_by')
          .gte('checkout_confirmed_at', since)
          .lte('checkout_confirmed_at', now.toISOString())
          .order('checkout_confirmed_at', { ascending: true })
          .limit(MAX_ORDERS),
        this.db
          .from('payment_operation_events')
          .select('event_kind,outcome,trigger,occurred_at,error_class,order_id,user_id')
          .gte('occurred_at', since)
          .lte('occurred_at', now.toISOString())
          .order('occurred_at', { ascending: true })
          .limit(MAX_EVENTS),
      ]),
      QUERY_TIMEOUT_MS
    );
    if (ordersResult.error)
      throw new Error(`payment alert order scan failed: ${ordersResult.error.message}`);
    if (eventsResult.error)
      throw new Error(`payment alert event scan failed: ${eventsResult.error.message}`);
    return {
      orders: ((ordersResult.data ?? []) as Row[]).map((row) => ({
        orderId: row.id,
        userId: row.user_id,
        checkoutConfirmedAt: row.checkout_confirmed_at,
        status: row.status,
        paidAt: row.paid_at,
        fulfillmentApplied: row.fulfillment_applied,
        settledBy: row.settled_by,
      })),
      operations: (eventsResult.data ?? []) as EventRow[],
      productionWebhookBaseline: false,
    };
  }
}

export class PaymentAlertMonitor {
  private healthyWindows = new Map<string, number>();
  constructor(
    private readonly repository: PaymentAlertMonitorRepository,
    private readonly publisher: AlertPublisher,
    private readonly log: Pick<Logger, 'biz' | 'sys'>
  ) {}
  async runOnce(now = new Date()): Promise<{ published: number }> {
    const snapshot = await retry(() => this.repository.snapshot(now), 2);
    const evaluations = evaluatePaymentAlertRules(snapshot, now)
      .filter((evaluation) => evaluation.severity === 'P0' || now.getUTCMinutes() % 5 === 0)
      .filter((evaluation) => {
        const count =
          evaluation.state === 'healthy'
            ? (this.healthyWindows.get(evaluation.rule_id) ?? 0) + 1
            : 0;
        this.healthyWindows.set(evaluation.rule_id, count);
        // Do not let one complete window recover an incident; query failures never reach this point.
        return evaluation.state === 'firing' || count >= 2;
      });
    let published = 0;
    for (const evaluation of evaluations) {
      const result = await this.publisher.publish(evaluation);
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
