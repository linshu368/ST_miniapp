import type { PaymentGateway } from '../../../infrastructure/payment/PaymentGateway.js';
import type { AdvisoryLeaseResult } from '../../../lib/postgres-advisory-lease.js';
import {
  paymentProbeGuard,
  probePaymentAvailability,
  type PaymentProbeResult,
  type PaymentProbeSettings,
} from './probe.js';
import {
  executePaymentStrategies,
  validatePaymentStrategies,
  type PaymentAvailabilityStrategy,
  type StrategyOutcome,
} from './strategy.js';

export interface PaymentProbeRoundResult {
  outcome: 'success' | 'partial' | 'error' | 'skipped';
  probe?: PaymentProbeResult;
  reason?: 'overlap';
  strategies: StrategyOutcome[];
}

/** Lock scope includes strategies, so overlapping replicas cannot race first-incident publication. */
export async function runPaymentProbeRound(input: {
  settings: PaymentProbeSettings;
  gateway: Pick<PaymentGateway, 'createPayment'>;
  strategies: readonly PaymentAvailabilityStrategy[];
  signal: AbortSignal;
  withLease: (
    work: () => Promise<PaymentProbeRoundResult>
  ) => Promise<AdvisoryLeaseResult<PaymentProbeRoundResult>>;
}): Promise<PaymentProbeRoundResult> {
  const guarded = paymentProbeGuard(input.settings);
  if (guarded)
    return {
      outcome: guarded.kind === 'skipped' ? 'skipped' : 'error',
      probe: guarded,
      strategies: [],
    };
  validatePaymentStrategies(input.strategies);
  const lease = await input.withLease(async () => {
    const probe = await probePaymentAvailability(input);
    if (probe.kind === 'skipped' || probe.kind === 'configuration_error') {
      return { outcome: probe.kind === 'skipped' ? 'skipped' : 'error', probe, strategies: [] };
    }
    const strategies = await executePaymentStrategies(input.strategies, probe, input.signal);
    const failed = strategies.some((result) => !['succeeded', 'skipped'].includes(result.outcome));
    return {
      outcome: failed || probe.kind === 'unavailable' ? 'partial' : 'success',
      probe,
      strategies,
    };
  });
  return lease.acquired ? lease.value : { outcome: 'skipped', reason: 'overlap', strategies: [] };
}
