import type { SafeAlertCard } from '../../features/alerting/safe-card.js';
import type { FeishuDeliveryResult } from '../../features/alerting/feishu-alert-sink.js';
import { matchesLogRule, type LogAlertPolicy } from './alert-policy.js';
import type { AlertLog } from './log-channel.js';

interface Delivery {
  deliver(card: SafeAlertCard, timeoutMs: number): Promise<FeishuDeliveryResult>;
}
type Health = (event: 'delivery_failed' | 'capacity_exceeded', count: number) => void;
const TIMEOUT_MS = 2_500;
const MAX_IN_FLIGHT = 4;

/** Best-effort per-log notifications: no database, retry, backlog or replay. */
export function createLogAlerts(policy: LogAlertPolicy, sink: Delivery, health: Health) {
  const pending = new Set<Promise<void>>();
  let closed = false;
  let dropped = 0;
  let failures = 0;
  const report: Health = (event, count) => {
    try {
      health(event, count);
    } catch {
      /* isolated */
    }
  };

  async function deliver(card: SafeAlertCard): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Also bound shutdown if a future adapter ignores its AbortSignal deadline.
      const deadline = new Promise<FeishuDeliveryResult>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'retryable', errorClass: 'timeout' }), TIMEOUT_MS);
      });
      const result = await Promise.race([sink.deliver(card, TIMEOUT_MS), deadline]);
      if (result.kind !== 'succeeded') report('delivery_failed', ++failures);
    } catch {
      report('delivery_failed', ++failures);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    accept(event: AlertLog): void {
      if (!policy.enabled || closed || event.event.startsWith('observability.')) return;
      const rule = policy.rules.find((candidate) => matchesLogRule(candidate, event));
      if (!rule) return;
      if (pending.size >= MAX_IN_FLIGHT) {
        // Log the first drop and powers of two, so a failure storm cannot create a second storm.
        dropped++;
        if ((dropped & (dropped - 1)) === 0) report('capacity_exceeded', dropped);
        return;
      }
      const card: SafeAlertCard = {
        title: `Backend ${rule.id}`,
        summary: `event=${event.event}\noperation=${event.operation}\noutcome=${event.outcome ?? 'unknown'}\nerror_code=${event.error_code ?? '-'}\npublic_error_code=${event.public_error_code ?? '-'}\nevent_id=${event.event_id}\nSearch event_id in Railway logs.`,
        severity: rule.severity,
        transition: 'firing',
        incident_fingerprint: rule.id,
        notification_key: event.event_id,
        metrics: [],
        samples: [],
      };
      const work = deliver(card);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    },
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...pending]);
    },
    health: () => ({ in_flight: pending.size, dropped, failures }),
  };
}
