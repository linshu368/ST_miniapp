import * as Sentry from '@sentry/node';

import { config } from '../config.js';
import { finishBackgroundOperation } from './jobs.js';
import { observationOutcome } from './outcomes.js';
import { startLogAlerts } from './alert-runtime.js';
import {
  observeBackgroundJob,
  startEngineeringTelemetry,
  type BackgroundJobOutcome,
} from '../../lib/engineering-observability.js';

export function observeBackgroundRun(input: {
  job: string;
  outcome: BackgroundJobOutcome;
  startedAt: number;
  error?: unknown;
}): void {
  const durationMs = performance.now() - input.startedAt;
  finishBackgroundOperation(input.job, {
    outcome: observationOutcome(input.outcome),
    outcome_known: input.outcome !== 'error',
    err: input.error,
  });
  try {
    observeBackgroundJob({ job: input.job, outcome: input.outcome, durationMs });
  } catch {
    // Telemetry must never change job completion.
  }
  try {
    Sentry.metrics.distribution('background.job.duration', durationMs, {
      unit: 'millisecond',
      attributes: { job: input.job, outcome: input.outcome },
    });
    Sentry.metrics.count('background.job.runs', 1, {
      attributes: { job: input.job, outcome: input.outcome },
    });
    if (input.error !== undefined) {
      Sentry.withScope((scope) => {
        scope.setTags({ job: input.job, outcome: input.outcome });
        scope.setFingerprint(['background-job', input.job]);
        Sentry.captureException(input.error);
      });
    }
  } catch {
    // Sentry SDK failures are non-critical.
  }
}

export function startStandaloneObservability(): () => Promise<void> {
  const stopLogAlerts = startLogAlerts();
  const stopEngineering = startEngineeringTelemetry(config.engineeringTelemetry);
  return async () => {
    await Promise.allSettled([stopEngineering(), stopLogAlerts(), Sentry.flush(2_500)]);
  };
}
