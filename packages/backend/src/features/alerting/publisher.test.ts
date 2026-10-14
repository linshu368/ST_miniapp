import { describe, expect, it, vi } from 'vitest';
import type { AlertEvaluation } from '@miniapp/shared';
import { AlertPublisher } from './publisher.js';
import type { AlertPersistence, PersistResult } from './repository.js';
import { isNewer, transitionFor, type IncidentRow } from './semantics.js';

function evaluation(overrides: Partial<AlertEvaluation> = {}): AlertEvaluation {
  return {
    schema_version: 1,
    evaluation_id: '11111111-1111-4111-8111-111111111111',
    producer_run_id: '22222222-2222-4222-8222-222222222222',
    domain: 'logs',
    service: 'api',
    environment: 'test',
    rule_id: 'error-rate',
    rule_version: '1',
    rule_group: 'availability',
    fingerprint: 'test:logs:availability:all',
    state: 'firing',
    severity: 'P1',
    location: { kind: 'application', component: 'api' },
    confidence: 'confirmed',
    observed_at: '2026-10-10T00:01:00.000Z',
    window_started_at: '2026-10-10T00:00:00.000Z',
    window_ended_at: '2026-10-10T00:01:00.000Z',
    title: 'API error rate elevated',
    summary: 'The rate exceeded the threshold.',
    metrics: [{ name: 'error_rate', value: 0.2, unit: 'ratio' }],
    samples: [{ kind: 'request-class', reference: 'gateway-5xx' }],
    ...overrides,
  };
}

function logger() {
  return { biz: { info: vi.fn() }, sys: { warn: vi.fn(), error: vi.fn() } } as never;
}

describe('AlertPublisher', () => {
  it('only describes a persisted evaluation as accepted, never as delivered', async () => {
    const persist = vi
      .fn<AlertPersistence['persist']>()
      .mockResolvedValue({ kind: 'accepted', notificationKey: 'key' });
    const result = await new AlertPublisher({ persist } as AlertPersistence, logger()).publish(
      evaluation()
    );
    expect(result).toEqual({ kind: 'accepted', notification_key: 'key' });
    expect(JSON.stringify(result)).not.toContain('delivered');
  });

  it('rejects malformed producer input before persistence', async () => {
    const persist = vi.fn<AlertPersistence['persist']>();
    const result = await new AlertPublisher({ persist } as AlertPersistence, logger()).publish({
      state: 'firing',
    });
    expect(result).toEqual({ kind: 'failed', reason: 'invalid_evaluation' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects sensitive sample fields before persistence', async () => {
    const persist = vi.fn<AlertPersistence['persist']>();
    const result = await new AlertPublisher({ persist } as AlertPersistence, logger()).publish(
      evaluation({
        samples: [{ kind: 'order-reference', reference: '12345678901234567890123456789012' }],
      })
    );
    expect(result).toEqual({ kind: 'failed', reason: 'unsafe_card' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('is reusable by a future log producer and preserves duplicate outcomes', async () => {
    const result: PersistResult = { kind: 'duplicate' };
    const persist = vi.fn<AlertPersistence['persist']>().mockResolvedValue(result);
    const publisher = new AlertPublisher({ persist } as AlertPersistence, logger());
    await expect(publisher.publish(evaluation())).resolves.toEqual({ kind: 'duplicate' });
    expect(persist.mock.calls[0]?.[0].evaluation.domain).toBe('logs');
  });

  it('returns failed when atomic persistence fails', async () => {
    const persist = vi
      .fn<AlertPersistence['persist']>()
      .mockRejectedValue(new Error('database unavailable'));
    await expect(
      new AlertPublisher({ persist } as AlertPersistence, logger()).publish(evaluation())
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'persistence_failed',
    });
  });

  it('rejects replays and out-of-order evaluations, while allowing P1 to P0 escalation', () => {
    const row: IncidentRow = {
      id: 1n,
      state: 'open',
      severity: 'P1',
      latest_evaluation_id: 'old',
      last_window_ended_at: new Date('2026-10-10T00:01:00.000Z'),
      last_observed_at: new Date('2026-10-10T00:01:00.000Z'),
    };
    expect(isNewer(row, evaluation({ window_ended_at: '2026-10-10T00:00:00.000Z' }))).toBe(false);
    expect(isNewer(row, evaluation({ observed_at: '2026-10-10T00:00:30.000Z' }))).toBe(false);
    const escalation = evaluation({
      severity: 'P0',
      observed_at: '2026-10-10T00:02:00.000Z',
      window_ended_at: '2026-10-10T00:02:00.000Z',
    });
    expect(transitionFor(row, escalation)).toBe('escalated');
  });

  it('emits recovery only from an open incident and reopens a recovered incident as firing', () => {
    const open: IncidentRow = {
      id: 1n,
      state: 'open',
      severity: 'P1',
      latest_evaluation_id: 'old',
      last_window_ended_at: new Date(),
      last_observed_at: new Date(),
    };
    expect(transitionFor(open, evaluation({ state: 'healthy' }))).toBe('recovered');
    expect(transitionFor({ ...open, state: 'recovered' }, evaluation())).toBe('firing');
  });

  it('allows concurrent publishers to share a persistence boundary without promising delivery', async () => {
    let seen = false;
    const persist: AlertPersistence = {
      persist: async () => {
        if (seen) return { kind: 'duplicate' };
        seen = true;
        return { kind: 'accepted', notificationKey: 'one' };
      },
    };
    const publisher = new AlertPublisher(persist, logger());
    const outcomes = await Promise.all([
      publisher.publish(evaluation()),
      publisher.publish(evaluation()),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['accepted', 'duplicate']);
  });
});
