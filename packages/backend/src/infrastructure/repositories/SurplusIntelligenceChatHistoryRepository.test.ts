import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainDb } from '../../lib/supabase.js';

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  rpcAbort: vi.fn(),
  from: vi.fn(),
  query: {
    select: vi.fn(),
    eq: vi.fn(),
    not: vi.fn(),
    is: vi.fn(),
    neq: vi.fn(),
    lt: vi.fn(),
    in: vi.fn(),
    gte: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    abortSignal: vi.fn(),
    maybeSingle: vi.fn(),
  },
}));
vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({ rpc: state.rpc, from: state.from }),
}));

import { SurplusIntelligenceChatHistoryRepository } from './SurplusIntelligenceChatHistoryRepository.js';
import { listSurplusRowsPendingBilling } from './surplus-billing-recovery.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.rpc.mockReturnValue({ abortSignal: state.rpcAbort });
  state.rpcAbort.mockResolvedValue({ error: null, data: null });
  state.from.mockReturnValue(state.query);
  for (const mock of Object.values(state.query)) mock.mockReturnValue(state.query);
  state.query.maybeSingle.mockResolvedValue({ data: null, error: null });
});

describe('Surplus Intelligence billing recovery identity', () => {
  const db = { from: state.from } as unknown as DomainDb;
  const input = { since: '2026-11-09T00:00:00Z', limit: 50 };
  it('uses the new detail identity only when its attempt agrees with the delivery winner', async () => {
    state.query.abortSignal.mockResolvedValueOnce({
      error: null,
      data: [
        {
          id: 'turn-1',
          llm_billing_snapshot: { provider: 'surplus' },
          surplusintelligence_chat_history: {
            chat_history_id: 'turn-1',
            generation_id: 'gen-1',
            attempt_id: 'attempt-1',
          },
          chat_generation_requests: { chat_history_id: 'turn-1', delivery_attempt_id: 'attempt-1' },
        },
      ],
    });
    const rows = await listSurplusRowsPendingBilling(db, input);
    expect(rows[0]).toMatchObject({ id: 'turn-1', generationId: 'gen-1', callProvider: 'surplus' });
    expect(rows[0]).not.toHaveProperty('surplusintelligence_chat_history');
  });

  it('preserves snapshot-only historical recovery without inventing an identity', async () => {
    state.query.abortSignal.mockResolvedValueOnce({
      error: null,
      data: [
        {
          id: 'old-turn',
          llm_billing_snapshot: { provider: 'surplus' },
          surplusintelligence_chat_history: null,
          chat_generation_requests: null,
        },
      ],
    });
    const rows = await listSurplusRowsPendingBilling(db, input);
    expect(rows[0]).toMatchObject({ id: 'old-turn', generationId: null, callProvider: 'surplus' });
  });

  it('refuses to bill a Surplus loser as the winner when the delivery identity differs', async () => {
    state.query.abortSignal.mockResolvedValueOnce({
      error: null,
      data: [
        {
          id: 'turn-1',
          llm_billing_snapshot: { provider: 'surplus' },
          surplusintelligence_chat_history: {
            chat_history_id: 'turn-1',
            generation_id: 'gen-1',
            attempt_id: 'surplus-attempt',
          },
          chat_generation_requests: {
            chat_history_id: 'turn-1',
            delivery_attempt_id: 'openrouter-attempt',
          },
        },
      ],
    });
    const rows = await listSurplusRowsPendingBilling(db, input);
    expect(rows[0]?.callProvider).toBeNull();
  });

  it('accepts a singular array relationship but refuses multiple related identities', async () => {
    state.query.abortSignal.mockResolvedValueOnce({
      error: null,
      data: [
        {
          id: 'turn-1',
          llm_billing_snapshot: { provider: 'surplus' },
          surplusintelligence_chat_history: [
            { chat_history_id: 'turn-1', generation_id: 'gen-1', attempt_id: 'a' },
          ],
          chat_generation_requests: [{ chat_history_id: 'turn-1', delivery_attempt_id: 'a' }],
        },
        {
          id: 'turn-2',
          llm_billing_snapshot: { provider: 'surplus' },
          surplusintelligence_chat_history: [
            { chat_history_id: 'turn-2' },
            { chat_history_id: 'turn-2' },
          ],
          chat_generation_requests: null,
        },
      ],
    });
    const rows = await listSurplusRowsPendingBilling(db, input);
    expect(rows[0]).toMatchObject({ generationId: 'gen-1', callProvider: 'surplus' });
    expect(rows[1]?.callProvider).toBeNull();
  });

  it('refuses a detail that belongs to another parent even when its attempt ID matches', async () => {
    state.query.abortSignal.mockResolvedValueOnce({
      error: null,
      data: [
        {
          id: 'turn-1',
          llm_billing_snapshot: { provider: 'surplus' },
          surplusintelligence_chat_history: {
            chat_history_id: 'other-turn',
            generation_id: 'gen-1',
            attempt_id: 'a',
          },
          chat_generation_requests: { chat_history_id: 'turn-1', delivery_attempt_id: 'a' },
        },
      ],
    });
    expect((await listSurplusRowsPendingBilling(db, input))[0]?.callProvider).toBeNull();
  });
});

describe('SurplusIntelligenceChatHistoryRepository', () => {
  it('freezes only the actual request parameters through an atomic parent-scoped RPC', async () => {
    const parameters = { model: 'model-1', stream: true, stream_options: { include_usage: true } };
    await new SurplusIntelligenceChatHistoryRepository().prepare({
      historyId: 'turn-1',
      attemptId: 'attempt-1',
      requestParameters: parameters,
    });
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('prepare_surplusintelligence_call', {
      p_history_id: 'turn-1',
      p_attempt_id: 'attempt-1',
      p_request_parameters: parameters,
    });
    expect(state.rpcAbort.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('reads back an uncertain committed preparation without resending it', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: '57014' } });
    state.query.maybeSingle.mockResolvedValueOnce({
      data: { attempt_id: null, request_parameters: { stream: true, model: 'm' } },
      error: null,
    });
    await new SurplusIntelligenceChatHistoryRepository().prepare({
      historyId: 'turn-1',
      requestParameters: { model: 'm', stream: true },
    });
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.query.select).toHaveBeenCalledWith('attempt_id,request_parameters');
  });

  it('rejects a different durable request or attempt without overwriting it', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: '57014' } });
    state.query.maybeSingle.mockResolvedValueOnce({
      data: { attempt_id: 'different', request_parameters: { model: 'm' } },
      error: null,
    });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().prepare({
        historyId: 'turn-1',
        attemptId: 'attempt-1',
        requestParameters: { model: 'm' },
      })
    ).rejects.toThrow('冲突');
    expect(state.rpc).toHaveBeenCalledOnce();
  });

  it('does not retry a confirmed database conflict', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: 'PT409' } });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().prepare({
        historyId: 'turn-1',
        requestParameters: { model: 'm' },
      })
    ).rejects.toThrow('冲突');
    expect(state.from).not.toHaveBeenCalled();
  });

  it('fails closed if the inference body contains messages or exceeds the UTF-8 budget', async () => {
    const repository = new SurplusIntelligenceChatHistoryRepository();
    await expect(
      repository.prepare({
        historyId: 'turn-1',
        requestParameters: { model: 'm', messages: [] },
      })
    ).rejects.toThrow('禁止');
    await expect(
      repository.prepare({
        historyId: 'turn-1',
        requestParameters: { model: '字'.repeat(6000) },
      })
    ).rejects.toThrow('容量');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('confirms an uncertain committed generation ID without repeating its write', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: '57014' } });
    state.query.maybeSingle.mockResolvedValueOnce({
      data: { generation_id: 'gen-1' },
      error: null,
    });
    await new SurplusIntelligenceChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1');
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.query.select).toHaveBeenCalledWith('generation_id');
  });

  it('rejects a mismatched generation identity and preserves the existing call', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: '57014' } });
    state.query.maybeSingle.mockResolvedValueOnce({
      data: { generation_id: 'gen-other' },
      error: null,
    });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1')
    ).rejects.toThrow('冲突');
    expect(state.rpc).toHaveBeenCalledOnce();
  });

  it('bounds uncertain writes to two attempts rather than retrying indefinitely', async () => {
    state.rpcAbort.mockResolvedValue({ error: { code: '57014' } });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1')
    ).rejects.toThrow('未确认');
    expect(state.rpc).toHaveBeenCalledTimes(2);
    expect(state.query.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('preserves zero and original metadata structure for the atomic database merge', async () => {
    const patch = {
      generation_id: 'gen-1',
      request_id: 'req-1',
      buyer_cost_micro: '0',
      usage_usd: '0',
      prompt_tokens: 0,
      response_metadata: { stream: { usage: { prompt_tokens: 0 } } },
    };
    await new SurplusIntelligenceChatHistoryRepository().saveObservation('turn-1', patch);
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('record_surplusintelligence_call', {
      p_history_id: 'turn-1',
      p_patch: patch,
    });
    expect(state.from).not.toHaveBeenCalled();
  });

  it('validates call IDs and response byte size before reaching the database', async () => {
    const repository = new SurplusIntelligenceChatHistoryRepository();
    await expect(
      repository.saveObservation('turn-1', { request_id: '../not-a-request' })
    ).rejects.toThrow('身份');
    await expect(
      repository.saveObservation('turn-1', {
        response_metadata: { model: '字'.repeat(44000) },
      })
    ).rejects.toThrow('容量');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('scans only due scalar recovery facts, capped at fifty, without loading capture JSON', async () => {
    state.query.abortSignal.mockResolvedValueOnce({ data: [], error: null });
    await new SurplusIntelligenceChatHistoryRepository().listRecoveryCandidates({
      since: '2026-11-09T00:00:00Z',
      now: '2026-11-10T00:00:00Z',
      limit: 999,
    });
    expect(state.query.select).toHaveBeenCalledWith(
      expect.not.stringContaining('response_metadata')
    );
    expect(state.query.lt).toHaveBeenCalledWith('request_record_attempts', 6);
    expect(state.query.eq).toHaveBeenCalledWith('request_record_status', 'pending');
    expect(state.query.limit).toHaveBeenCalledWith(50);
    expect(state.query.or).toHaveBeenCalledWith(
      'request_record_next_retry_at.is.null,request_record_next_retry_at.lte.2026-11-10T00:00:00Z'
    );
  });

  it('uses the database claim result so replicas do not fetch the same record concurrently', async () => {
    state.rpcAbort.mockResolvedValueOnce({ data: false, error: null });
    expect(
      await new SurplusIntelligenceChatHistoryRepository().claimRequestRecord(
        'turn-1',
        '2026-11-10T00:00:00Z'
      )
    ).toBe(false);
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('claim_surplusintelligence_request_record', {
      p_history_id: 'turn-1',
      p_now: '2026-11-10T00:00:00Z',
    });
  });
});
