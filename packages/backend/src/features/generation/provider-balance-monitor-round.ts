import type { Logger } from '../../lib/logger.js';

type MonitorResult = { outcome: 'ok' | 'skipped' | 'probe_failed' };
type BalanceMonitor = { runOnce(): Promise<MonitorResult> };

/** Provider failures are isolated so payment monitoring and alert delivery can still complete. */
export async function runProviderBalanceMonitorRound(input: {
  venice: BalanceMonitor;
  surplus: BalanceMonitor;
  packy?: BalanceMonitor;
  onexmodel?: BalanceMonitor;
  log: Pick<Logger, 'sys'>;
}): Promise<'success' | 'partial'> {
  let outcome: 'success' | 'partial' = 'success';
  const monitors = [
    { provider: 'venice', monitor: input.venice },
    { provider: 'surplus', monitor: input.surplus },
    ...(input.packy ? [{ provider: 'packy', monitor: input.packy }] : []),
    ...(input.onexmodel ? [{ provider: 'onexmodel', monitor: input.onexmodel }] : []),
  ];

  const results: PromiseSettledResult<MonitorResult>[] = [];
  for (let offset = 0; offset < monitors.length; offset += 2) {
    results.push(
      ...(await Promise.allSettled(
        monitors.slice(offset, offset + 2).map(({ monitor }) => monitor.runOnce())
      ))
    );
  }
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
    input.log.sys.info(
      { event: `${provider}.balance_monitor.completed`, provider, outcome: result.value.outcome },
      '供应商余额监控结果'
    );
  }
  return outcome;
}
