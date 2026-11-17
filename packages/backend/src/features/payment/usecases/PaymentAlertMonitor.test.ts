import { describe, expect, it, vi } from 'vitest';
import { PaymentAlertMonitor } from './PaymentAlertMonitor.js';
import {
  EARLY_WARNING_RECOVERY_PASSES,
  P1_PROVIDER_DEGRADED_RULE_ID,
  type PaymentOperation,
} from '../domain/PaymentAlertRules.js';

const T0 = Date.parse('2026-11-03T08:00:00.000Z');

function slowProbes(at: number): PaymentOperation[] {
  return [1, 2, 3].map((n) => ({
    event_kind: 'fast_reconcile',
    outcome: 'succeeded',
    trigger: 'fast_reconcile',
    occurred_at: new Date(at - n * 1000).toISOString(),
    error_class: 'slow',
    duration_ms: 4000,
    order_id: null,
    user_id: null,
  }));
}

function setup() {
  let operations: PaymentOperation[] = [];
  const published: Array<{ rule: string; state: string; notify?: boolean }> = [];
  const monitor = new PaymentAlertMonitor(
    { snapshot: vi.fn(async () => ({ operations })) },
    {
      publish: vi.fn(async (evaluation: never, options?: { notify?: boolean }) => {
        const e = evaluation as { rule_id: string; state: string };
        published.push({ rule: e.rule_id, state: e.state, notify: options?.notify });
        return { kind: 'accepted' } as never;
      }),
    },
    { biz: { info: vi.fn() }, sys: { warn: vi.fn(), error: vi.fn() } } as never
  );
  return {
    monitor,
    published,
    setOperations: (next: PaymentOperation[]) => (operations = next),
  };
}

const forRule = (published: Array<{ rule: string; state: string }>, state: string) =>
  published.filter((p) => p.rule === P1_PROVIDER_DEGRADED_RULE_ID && p.state === state);

describe('PaymentAlertMonitor recovery debounce', () => {
  it('keeps an early warning firing until enough consecutive healthy passes', async () => {
    const { monitor, published, setOperations } = setup();
    setOperations(slowProbes(T0));
    await monitor.runOnce(new Date(T0));
    expect(forRule(published, 'firing')).toHaveLength(1);
    expect(published[0]?.notify).toBe(true);

    setOperations([]);
    for (let i = 1; i < EARLY_WARNING_RECOVERY_PASSES; i += 1) {
      await monitor.runOnce(new Date(T0 + 15 * 60_000 + i * 60_000));
    }
    expect(forRule(published, 'healthy')).toHaveLength(0);

    await monitor.runOnce(new Date(T0 + 30 * 60_000));
    expect(forRule(published, 'healthy')).toHaveLength(1);
  });

  it('restarts the healthy count when the warning fires again', async () => {
    const { monitor, published, setOperations } = setup();
    setOperations([]);
    for (let i = 0; i < EARLY_WARNING_RECOVERY_PASSES - 1; i += 1) {
      await monitor.runOnce(new Date(T0 + i * 60_000));
    }
    const refire = T0 + 20 * 60_000;
    setOperations(slowProbes(refire));
    await monitor.runOnce(new Date(refire));
    setOperations([]);
    await monitor.runOnce(new Date(refire + 20 * 60_000));
    expect(forRule(published, 'healthy')).toHaveLength(0);
  });
});
