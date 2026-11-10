import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type {
  SurplusObservationPatch,
  SurplusRecoveryCandidate,
} from '../../infrastructure/repositories/SurplusIntelligenceChatHistoryRepository.js';

vi.mock('../../platform/runtime-config.js', () => ({
  getLlmProviderRuntimeConfig: () => ({ baseUrl: 'https://surplus.example/v1', apiKey: '' }),
}));
vi.mock('../../lib/supabase.js', () => ({ getDomainDb: vi.fn() }));

import { recoverSurplusRequestMetadata } from './surplus-request-recovery.js';
import { SurplusResponseCapture } from './surplus-response-capture.js';

const candidate = (index = 1): SurplusRecoveryCandidate => ({
  chat_history_id: `turn-${index}`,
  request_id: `request-${index}`,
  generation_id: `gen-${index}`,
  call_status: 'completed',
  request_record_attempts: 0,
  request_record_next_retry_at: null,
});
const now = Date.parse('2026-11-10T10:00:00Z');
const log = { error: vi.fn() } as unknown as FastifyBaseLogger;

function repository() {
  const capture = new SurplusResponseCapture();
  capture.headers(new Headers({ 'x-si-request-id': 'request-1' }));
  capture.observe({ id: 'gen-1', model: 'm', usage: { prompt_tokens: 0, buyer_cost_micro: '10' } });
  return {
    listRecoveryCandidates: vi.fn(async () => [candidate()]),
    claimRequestRecord: vi.fn(async () => true),
    readMetadata: vi.fn(async () => capture.snapshot() as Record<string, unknown>),
    saveObservation: vi.fn(
      async (_historyId: string, _patch: SurplusObservationPatch) => undefined
    ),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('Surplus request metadata recovery', () => {
  it('skips all database/provider work without a Surplus key', async () => {
    const store = repository();
    const fetchImpl = vi.fn();
    const result = await recoverSurplusRequestMetadata({ log, repository: store, fetchImpl });
    expect(result.scanned).toBe(0);
    expect(store.listRecoveryCandidates).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves inline sources while adding a same-identity request record and original cost', async () => {
    const store = repository();
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: {
          id: 'request-1',
          generation_id: 'gen-1',
          model: 'm',
          usage: { prompt_tokens: 0, completion_tokens: 2, buyer_cost_micro: '23' },
        },
      })
    );
    const result = await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl,
      apiKey: 'fixture-key',
      now,
    });
    expect(result).toMatchObject({ scanned: 1, claimed: 1, completed: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://surplus.example/v1/requests/request-1',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal), redirect: 'error' })
    );
    const patch = store.saveObservation.mock.calls[0]?.[1];
    expect(patch).toMatchObject({
      request_record_status: 'complete',
      prompt_tokens: 0,
      completion_tokens: 2,
      buyer_cost_micro: '23',
    });
    expect(patch?.response_metadata).toMatchObject({
      headers: { 'x-si-request-id': 'request-1' },
      stream: { id: 'gen-1', usage: { buyer_cost_micro: '10' } },
      request_record: { data: { id: 'request-1', usage: { buyer_cost_micro: '23' } } },
    });
    expect(patch).not.toHaveProperty('generation_id');
  });

  it.each([401, 403, 404])(
    'marks HTTP %s terminal without retrying or elevating permissions',
    async (status) => {
      const store = repository();
      const fetchImpl = vi.fn(async () => new Response('private raw error', { status }));
      const result = await recoverSurplusRequestMetadata({
        log,
        repository: store,
        fetchImpl,
        apiKey: 'fixture-key',
        now,
      });
      expect(result.unavailable).toBe(1);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const patch = store.saveObservation.mock.calls[0]?.[1];
      expect(patch?.request_record_status).toBe(status === 404 ? 'not_found' : 'forbidden');
      expect(JSON.stringify(patch)).not.toContain('private raw error');
    }
  );

  it('defers a transient failure using the database retry claim instead of a hot retry loop', async () => {
    const store = repository();
    const fetchImpl = vi.fn(async () => new Response('private raw error', { status: 503 }));
    const result = await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl,
      apiKey: 'fixture-key',
      now,
    });
    expect(result.deferred).toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(store.claimRequestRecord).toHaveBeenCalledWith('turn-1', new Date(now).toISOString());
    expect(store.saveObservation.mock.calls[0]?.[1].request_record_status).toBe('pending');
  });

  it('stops retrying after the sixth claim', async () => {
    const store = repository();
    store.listRecoveryCandidates.mockResolvedValue([
      { ...candidate(), request_record_attempts: 5 },
    ]);
    const result = await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl: vi.fn(async () => new Response(null, { status: 500 })),
      apiKey: 'fixture-key',
      now,
    });
    expect(result.unavailable).toBe(1);
    expect(store.saveObservation.mock.calls[0]?.[1].request_record_status).toBe('unavailable');
  });

  it('does not request or load a capture when another replica owns the claim', async () => {
    const store = repository();
    store.claimRequestRecord.mockResolvedValue(false);
    const fetchImpl = vi.fn();
    await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl,
      apiKey: 'fixture-key',
      now,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.readMetadata).not.toHaveBeenCalled();
  });

  it('caps fetches to nine and scans scalar candidates over the twenty-four-hour window', async () => {
    const store = repository();
    store.listRecoveryCandidates.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => candidate(i + 1))
    );
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl,
      apiKey: 'fixture-key',
      now,
      requestBudget: 100,
    });
    expect(result.claimed).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(store.readMetadata).toHaveBeenCalledTimes(9);
    expect(store.listRecoveryCandidates).toHaveBeenCalledWith({
      since: '2026-11-09T10:00:00.000Z',
      now: '2026-11-10T10:00:00.000Z',
      limit: 50,
    });
  });

  it('rejects mismatched detail identities without replacing the live completion ID or observations', async () => {
    const store = repository();
    const fetchImpl = vi.fn(async () =>
      Response.json({
        id: 'some-other-request',
        generation_id: 'gen-other',
        usage: { buyer_cost_micro: '100' },
      })
    );
    const result = await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl,
      apiKey: 'fixture-key',
      now,
    });
    expect(result.completed).toBe(0);
    const patch = store.saveObservation.mock.calls[0]?.[1];
    expect(patch?.buyer_cost_micro).toBe('10');
    expect(JSON.stringify(patch)).not.toContain('some-other-request');
  });

  it('does not mark an unidentifiable detail authoritative just because the HTTP request succeeded', async () => {
    const store = repository();
    const fetchImpl = vi.fn(async () => Response.json({ model: 'm', buyer_cost_micro: '99' }));
    const result = await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl,
      apiKey: 'fixture-key',
      now,
    });
    expect(result.completed).toBe(0);
    expect(store.saveObservation.mock.calls[0]?.[1]).toMatchObject({
      request_record_status: 'pending',
      buyer_cost_micro: '10',
    });
  });

  it('does not retain an oversized raw detail body and keeps subsequent rows independent', async () => {
    const store = repository();
    store.listRecoveryCandidates.mockResolvedValue([candidate(), candidate(2)]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('sensitive'.repeat(20000)))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await recoverSurplusRequestMetadata({
      log,
      repository: store,
      fetchImpl,
      apiKey: 'fixture-key',
      now,
    });
    expect(result).toMatchObject({ deferred: 1, unavailable: 1, failed: 0 });
    expect(JSON.stringify(store.saveObservation.mock.calls)).not.toContain('sensitive');
  });
});
