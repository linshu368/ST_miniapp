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

beforeEach(() => {
  vi.clearAllMocks();
  state.rpc.mockReturnValue({ abortSignal: state.rpcAbort });
  state.rpcAbort.mockResolvedValue({ error: null, data: null });
  state.from.mockReturnValue(state.query);
  for (const mock of Object.values(state.query)) mock.mockReturnValue(state.query);
  state.query.maybeSingle.mockResolvedValue({ data: null, error: null });
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
    state.rpcAbort.mockResolvedValueOnce({
      data: [{ attempt_id: null, request_parameters: { stream: true, model: 'm' } }],
      error: null,
    });
    await new SurplusIntelligenceChatHistoryRepository().prepare({
      historyId: 'turn-1',
      requestParameters: { model: 'm', stream: true },
    });
    expect(state.rpc).toHaveBeenCalledTimes(2);
    expect(state.rpc).toHaveBeenNthCalledWith(2, 'read_surplus_call', {
      p_history_id: 'turn-1',
      p_with_metadata: false,
    });
  });

  it('rejects a different durable request or attempt without overwriting it', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: '57014' } });
    state.rpcAbort.mockResolvedValueOnce({
      data: [{ attempt_id: 'different', request_parameters: { model: 'm' } }],
      error: null,
    });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().prepare({
        historyId: 'turn-1',
        attemptId: 'attempt-1',
        requestParameters: { model: 'm' },
      })
    ).rejects.toThrow('冲突');
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      'prepare_surplusintelligence_call',
      'read_surplus_call',
    ]);
  });

  it('does not retry a confirmed database conflict', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: 'PT409' } });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().prepare({
        historyId: 'turn-1',
        requestParameters: { model: 'm' },
      })
    ).rejects.toThrow('冲突');
    expect(state.rpc).toHaveBeenCalledOnce();
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
    state.rpcAbort.mockResolvedValueOnce({ data: [{ generation_id: 'gen-1' }], error: null });
    await new SurplusIntelligenceChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1');
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      'record_surplusintelligence_call',
      'read_surplus_call',
    ]);
  });

  it('rejects a mismatched generation identity and preserves the existing call', async () => {
    state.rpcAbort.mockResolvedValueOnce({ error: { code: '57014' } });
    state.rpcAbort.mockResolvedValueOnce({ data: [{ generation_id: 'gen-other' }], error: null });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1')
    ).rejects.toThrow('冲突');
    expect(
      state.rpc.mock.calls.filter(([name]) => name === 'record_surplusintelligence_call')
    ).toHaveLength(1);
  });

  it('bounds uncertain writes to two attempts rather than retrying indefinitely', async () => {
    state.rpcAbort.mockResolvedValue({ error: { code: '57014' } });
    await expect(
      new SurplusIntelligenceChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1')
    ).rejects.toThrow('未确认');
    const names = state.rpc.mock.calls.map(([name]) => name);
    expect(names.filter((name) => name === 'record_surplusintelligence_call')).toHaveLength(2);
    expect(names.filter((name) => name === 'read_surplus_call')).toHaveLength(2);
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

  it('scans only due recovery facts through one RPC, capped at fifty, without loading capture JSON', async () => {
    state.rpcAbort.mockResolvedValueOnce({ data: [], error: null });
    await new SurplusIntelligenceChatHistoryRepository().listRecoveryCandidates({
      since: '2026-11-09T00:00:00Z',
      now: '2026-11-10T00:00:00Z',
      limit: 999,
    });
    // The due / pending / attempts < 6 filters live in the RPC (covered by the migration test).
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('list_surplus_request_record_candidates', {
      p_since: '2026-11-09T00:00:00Z',
      p_limit: 50,
      p_now: '2026-11-10T00:00:00Z',
    });
    expect(state.from).not.toHaveBeenCalled();
  });

  it('loads the response capture only for an explicit metadata read', async () => {
    state.rpcAbort.mockResolvedValueOnce({
      data: [{ attempt_id: 'a', response_metadata: { body: { x: 1 } } }],
      error: null,
    });
    expect(await new SurplusIntelligenceChatHistoryRepository().readMetadata('turn-1')).toEqual({
      body: { x: 1 },
    });
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith('read_surplus_call', {
      p_history_id: 'turn-1',
      p_with_metadata: true,
    });
    state.rpcAbort.mockResolvedValueOnce({ data: [], error: null });
    expect(await new SurplusIntelligenceChatHistoryRepository().readMetadata('turn-2')).toBeNull();
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
