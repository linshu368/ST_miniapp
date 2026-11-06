import type { Logger } from '../../lib/logger.js';

type MonitorResult = { outcome: 'ok' | 'skipped' | 'probe_failed' };
type BalanceMonitor = { runOnce(): Promise<MonitorResult> };

/** Provider failures are isolated so payment monitoring and alert delivery can still complete. */
export async function runProviderBalanceMonitorRound(input: {
  venice: BalanceMonitor;
  surplus: BalanceMonitor;
  log: Pick<Logger, 'sys'>;
}): Promise<'success' | 'partial'> {
  let outcome: 'success' | 'partial' = 'success';
  const monitors = [
    { provider: 'venice', monitor: input.venice },
    { provider: 'surplus', monitor: input.surplus },
  ] as const;

  const results = await Promise.allSettled(monitors.map(({ monitor }) => monitor.runOnce()));
  for (const [index, result] of results.entries()) {
    const provider = monitors[index]!.provider;
    if (result.status === 'rejected') {
      outcome = 'partial';
      input.log.sys.error(
        { event: `${provider}.balance_monitor.failed`, err: result.reason },
        `${provider} 余额监控本轮失败；不发布 healthy`
      );
      continue;
    }
    if (result.value.outcome === 'probe_failed') outcome = 'partial';
  }
  return outcome;
}
