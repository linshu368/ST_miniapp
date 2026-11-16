import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservationEvent } from '../../platform/observability/events.js';
import { currentContext, newContext, withContext } from '../../platform/observability/context.js';

const mocks = vi.hoisted(() => ({ records: [] as ObservationEvent[], config: vi.fn() }));
vi.mock('../../platform/observability/runtime.js', async () => {
  const { createObserver } = await import('../../platform/observability/core.js');
  return {
    observation: createObserver([
      (event) => {
        mocks.records.push(event);
      },
    ]),
  };
});
vi.mock('../../platform/runtime-config.js', () => ({ getLlmProviderRuntimeConfig: vi.fn() }));
vi.mock('./config.js', () => ({ fetchFreeZoneConfig: mocks.config }));
vi.mock('./repository.js', () => ({
  loadFreeZoneMetrics: vi.fn(),
  loadFreeZoneStatesVersioned: vi.fn(),
  saveFreeZoneEvaluation: vi.fn(),
}));
vi.mock('./snapshot.js', () => ({ invalidateFreeZoneSnapshot: vi.fn() }));
vi.mock('./probe.js', () => ({ createSurplusProbe: () => vi.fn() }));
vi.mock('../../lib/background-observability.js', async () => {
  const { finishBackgroundOperation } = await import('../../platform/observability/jobs.js');
  const { observationOutcome } = await import('../../platform/observability/outcomes.js');
  return {
    observeBackgroundRun(input: { job: string; outcome: string; error?: unknown }) {
      finishBackgroundOperation(input.job, {
        outcome: observationOutcome(input.outcome),
        outcome_known: input.outcome !== 'error',
        err: input.error,
      });
    },
  };
});
import { fetchSurplusModelMarket } from './surplus-market.js';
import { runFreeZoneEvaluation } from './evaluation-job.js';

beforeEach(() => {
  mocks.records.length = 0;
  mocks.config.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('free-zone observation boundaries', () => {
  it('observes both market requests without consuming bodies or changing deadlines', async () => {
    const responses = [Response.json({ offers: [] }), Response.json({ providers: [] })];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(responses[0]!)
      .mockResolvedValueOnce(responses[1]!);
    vi.stubGlobal('fetch', fetchImpl);
    const result = await fetchSurplusModelMarket('test/model', {
      origin: 'https://market.invalid',
    });
    expect(result.book.offers).toEqual([]);
    expect(result.performance).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every((call) => call[1]?.signal instanceof AbortSignal)).toBe(true);
    const terminals = mocks.records.filter((event) => event.event === 'operation.terminal');
    expect(terminals).toHaveLength(2);
    expect(
      terminals.every(
        (event) => event.operation === 'free_zone.market' && event.upstream_status === 200
      )
    ).toBe(true);
    expect(JSON.stringify(mocks.records)).not.toContain('market.invalid');
  });

  it('preserves market timeout failures and never adds retries', async () => {
    const timeout = new DOMException('private-timeout', 'TimeoutError');
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    vi.stubGlobal('fetch', fetchImpl);
    await expect(
      fetchSurplusModelMarket('test/model', { origin: 'https://market.invalid' })
    ).rejects.toMatchObject({ cause: timeout });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const terminals = mocks.records.filter((event) => event.event === 'operation.terminal');
    expect(terminals.every((event) => event.outcome === 'timed_out')).toBe(true);
    expect(JSON.stringify(mocks.records)).not.toContain('private-timeout');
  });

  it('isolates overlapping runs from the caller and reports skips and failures once', async () => {
    const log = pino({ level: 'silent' });
    const caller = newContext('caller-request');
    let release!: (value: { candidates: never[] }) => void;
    mocks.config.mockImplementationOnce(() => {
      expect(currentContext()?.request_id).toBeUndefined();
      expect(currentContext()?.trace_id).not.toBe(caller.trace_id);
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await withContext(caller, async () => {
      const first = runFreeZoneEvaluation(log);
      await runFreeZoneEvaluation(log);
      release({ candidates: [] });
      await first;
    });
    mocks.config.mockRejectedValueOnce(new Error('private-config'));
    await runFreeZoneEvaluation(log);
    const terminals = mocks.records.filter((event) => event.event === 'operation.terminal');
    expect(terminals.map((event) => event.outcome)).toEqual(['skipped', 'skipped', 'failed']);
    expect(new Set(terminals.map((event) => event.trace_id)).size).toBe(3);
    expect(terminals.every((event) => !event.request_id && !event.parent_span_id)).toBe(true);
    expect(currentContext()).toBeUndefined();
  });
});
