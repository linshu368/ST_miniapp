import { createLogger } from '../../lib/logger.js';
import {
  observeGenerationAttempt,
  observeGenerationPrepare,
  observeGenerationTerminal,
  type GenerationOutcome,
} from '../../lib/engineering-observability.js';
import { FirstTokenDeadlineError } from './first-token-fallback.js';
import { executeGeneration } from './generation-runtime.js';
import type {
  GenerationHooks,
  GenerationLogger,
  GenerationRequest,
  GenerationResult,
  GenerationService,
} from './types.js';
export { prepareGeneration } from './generation-prepare.js';
export { GENERATION_TIMEOUT_MS } from './generation-runtime.js';

export async function execute(
  request: GenerationRequest,
  hooks?: GenerationHooks,
  log: GenerationLogger = createLogger('generation')
): Promise<GenerationResult> {
  const observation = {
    startedAt: performance.now(),
    prepared: false,
    directDispatched: false,
    directDispatchedAt: 0,
    headersMs: undefined as number | undefined,
    firstTokenMs: undefined as number | undefined,
    signalOutcome: undefined as 'timeout' | 'cancelled' | undefined,
    provider: request.model.provider,
    model: request.model.providerModelId,
  };
  let outcome: GenerationOutcome = 'error';
  try {
    const result = await executeGeneration(request, hooks, log, observation);
    const reason = result.finishReason;
    outcome =
      reason === 'user_cancelled'
        ? 'user_cancelled'
        : observation.signalOutcome === 'timeout'
          ? 'timeout'
          : result.denial === 'vip_required'
            ? 'vip_required'
            : reason === 'content_filter' || reason === 'refusal'
              ? 'filtered'
              : reason === 'length'
                ? 'length'
                : reason === 'timeout' || reason === 'first_token_timeout'
                  ? 'timeout'
                  : reason === 'cancelled'
                    ? 'cancelled'
                    : (observation.signalOutcome ?? result.status);
    return result;
  } catch (err) {
    if (
      err instanceof FirstTokenDeadlineError ||
      request.signal?.reason instanceof FirstTokenDeadlineError ||
      request.signal?.reason?.name === 'TimeoutError'
    )
      outcome = 'timeout';
    else if (request.signal?.aborted) outcome = 'cancelled';
    throw err;
  } finally {
    if (!observation.prepared)
      observeGenerationPrepare({
        ...observation,
        durationMs: performance.now() - observation.startedAt,
        outcome: outcome === 'error' ? 'error' : 'rejected',
      });
    if (observation.directDispatched)
      observeGenerationAttempt({
        ...observation,
        role: 'primary',
        phase: 'generation',
        dispatched: true,
        outcome:
          outcome === 'success'
            ? 'completed'
            : outcome === 'timeout' ||
                outcome === 'filtered' ||
                outcome === 'length' ||
                outcome === 'user_cancelled'
              ? outcome
              : outcome === 'cancelled'
                ? 'cancelled'
                : outcome === 'upstream_error'
                  ? 'upstream_error'
                  : 'stream_interrupted',
        durationMs: performance.now() - observation.directDispatchedAt,
        headersMs: observation.headersMs,
        firstTokenMs: observation.firstTokenMs,
      });
    observeGenerationTerminal({
      ...observation,
      stream: request.stream,
      durationMs: performance.now() - observation.startedAt,
      outcome,
    });
  }
}

export const generationService: GenerationService = { execute };
