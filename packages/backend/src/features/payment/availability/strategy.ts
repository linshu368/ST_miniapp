import type { PaymentAvailabilityObservation } from './probe.js';

export interface PaymentAvailabilityStrategy {
  id: string;
  timeoutMs: number;
  appliesTo(observation: PaymentAvailabilityObservation): boolean;
  /** External I/O must honor signal or have a shorter native timeout; no detached side effects. */
  handle(observation: PaymentAvailabilityObservation, signal: AbortSignal): Promise<void>;
}

export type StrategyOutcome = {
  id: string;
  outcome: 'succeeded' | 'skipped' | 'failed' | 'timed_out' | 'cancelled';
};

const MAX_STRATEGIES = 8;
const CONCURRENCY = 2;

export function validatePaymentStrategies(
  strategies: readonly PaymentAvailabilityStrategy[]
): void {
  if (strategies.length === 0 || strategies.length > MAX_STRATEGIES) {
    throw new Error('Payment probe requires between one and eight strategies');
  }
  const ids = new Set<string>();
  for (const strategy of strategies) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(strategy.id) || ids.has(strategy.id)) {
      throw new Error('Payment probe strategy IDs must be valid and unique');
    }
    if (
      !Number.isInteger(strategy.timeoutMs) ||
      strategy.timeoutMs < 1 ||
      strategy.timeoutMs > 25_000
    ) {
      throw new Error('Payment probe strategy timeout must be between 1 and 25000 milliseconds');
    }
    ids.add(strategy.id);
  }
}

export async function executePaymentStrategies(
  strategies: readonly PaymentAvailabilityStrategy[],
  observation: PaymentAvailabilityObservation,
  signal: AbortSignal
): Promise<StrategyOutcome[]> {
  validatePaymentStrategies(strategies);
  const results: StrategyOutcome[] = new Array(strategies.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < strategies.length) {
      const index = next++;
      results[index] = await executeOne(strategies[index]!, observation, signal);
    }
  }
  await Promise.allSettled(
    Array.from({ length: Math.min(CONCURRENCY, strategies.length) }, worker)
  );
  return results;
}

async function executeOne(
  strategy: PaymentAvailabilityStrategy,
  observation: PaymentAvailabilityObservation,
  parent: AbortSignal
): Promise<StrategyOutcome> {
  if (parent.aborted) return { id: strategy.id, outcome: 'cancelled' };
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parent.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), strategy.timeoutMs);
  const signal = controller.signal;
  let onAbort: () => void = () => undefined;
  try {
    if (!strategy.appliesTo(observation)) return { id: strategy.id, outcome: 'skipped' };
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Payment probe strategy cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    // Race bounds the executor; the same abort is sent to the actual strategy, including late rejects.
    await Promise.race([
      Promise.resolve().then(() => strategy.handle(observation, signal)),
      aborted,
    ]);
    signal.throwIfAborted();
    return { id: strategy.id, outcome: 'succeeded' };
  } catch {
    return {
      id: strategy.id,
      outcome: parent.aborted ? 'cancelled' : signal.aborted ? 'timed_out' : 'failed',
    };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', onParentAbort);
    signal.removeEventListener('abort', onAbort);
  }
}
