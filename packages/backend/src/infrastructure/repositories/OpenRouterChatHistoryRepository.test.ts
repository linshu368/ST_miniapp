import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  from: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  identity: {
    eq: vi.fn(),
    is: vi.fn(),
    select: vi.fn(),
    abortSignal: vi.fn(),
    maybeSingle: vi.fn(),
  },
  candidate: {
    select: vi.fn(),
    in: vi.fn(),
    not: vi.fn(),
    gte: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    abortSignal: vi.fn(),
  },
  parent: { select: vi.fn(), in: vi.fn(), abortSignal: vi.fn() },
}));

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({ from: state.from }),
}));

import { OpenRouterChatHistoryRepository } from './OpenRouterChatHistoryRepository.js';
import { buildGenerationMetadata } from '../../features/generation/openrouter-metadata.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(state.candidate)) mock.mockReturnValue(state.candidate);
  state.candidate.abortSignal.mockResolvedValue({
    data: [{ chat_history_id: 'turn-1', llm_generation_id: 'gen-1' }],
    error: null,
  });
  state.parent.select.mockReturnValue(state.parent);
  state.parent.in.mockReturnValue(state.parent);
  state.parent.abortSignal.mockResolvedValue({
    data: [{ id: 'turn-1', status: 'success', llm_billing_settled_at: '2026-10-28T00:00:00Z' }],
    error: null,
  });
  for (const mock of Object.values(state.identity)) mock.mockReturnValue(state.identity);
  state.identity.maybeSingle.mockResolvedValue({
    data: { llm_generation_id: 'gen-1' },
    error: null,
  });
  state.update.mockReturnValue(state.identity);
  state.upsert.mockReturnValue({ abortSignal: vi.fn().mockResolvedValue({ error: null }) });
  state.from.mockImplementation((name: string) =>
    name === 'openrouter_chat_history'
      ? { ...state.candidate, upsert: state.upsert, update: state.update }
      : state.parent
  );
});

describe('OpenRouterChatHistoryRepository', () => {
  it('keeps the generation ID placeholder and does not invent provider metadata', async () => {
    await new OpenRouterChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1');
    expect(state.upsert).toHaveBeenCalledWith(
      {
        chat_history_id: 'turn-1',
      },
      { onConflict: 'chat_history_id', ignoreDuplicates: true }
    );
  });

  it('writes original field names while preserving the two explicitly retained aliases', async () => {
    const metadata = buildGenerationMetadata({
      usage: 0.01,
      usage_cache: 0,
      finish_reason: 'stop',
    });
    await new OpenRouterChatHistoryRepository().upsert({
      chat_history_id: 'turn-1',
      llm_generation_id: 'gen-1',
      ...metadata,
    });
    const payload = state.upsert.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      usage: 0.01,
      usage_cache: 0,
      finish_reason: 'stop',
    });
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ llm_generation_id: 'gen-1' })
    );
    expect(
      Object.keys(payload)
        .filter((key) => key.startsWith('llm_'))
        .sort()
    ).toEqual(['llm_generation_data']);
  });

  it('scans original columns without requiring optional usage_cache and joins billing facts by parent ID', async () => {
    const rows = await new OpenRouterChatHistoryRepository().listRowsMissingGenerationData({
      since: '2026-10-16T00:00:00Z',
      limit: 50,
    });
    expect(state.candidate.or).toHaveBeenCalledWith(
      'llm_generation_data.is.null,usage.is.null,latency.is.null,generation_time.is.null,finish_reason.is.null'
    );
    expect(state.candidate.gte).toHaveBeenCalledWith('created_at', '2026-10-16T00:00:00Z');
    expect(state.candidate.limit).toHaveBeenCalledWith(50);
    expect(state.parent.in).toHaveBeenCalledWith('id', ['turn-1']);
    expect(state.parent.select).toHaveBeenCalledWith(
      expect.stringContaining('llm_billing_settled_at')
    );
    expect(rows).toEqual([
      {
        id: 'turn-1',
        status: 'success',
        llm_billing_settled_at: '2026-10-28T00:00:00Z',
        generationId: 'gen-1',
        callProvider: 'openrouter',
      },
    ]);
  });

  it('batch-loads generation data in chunks instead of one read per history row', async () => {
    const ids = Array.from({ length: 52 }, (_, index) => `turn-${index + 1}`);
    state.candidate.abortSignal
      .mockResolvedValueOnce({
        data: [
          {
            chat_history_id: 'turn-1',
            usage: 0,
            finish_reason: null,
            llm_generation_data: { usage: 0 },
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ chat_history_id: 'turn-52', usage: 1, finish_reason: 'stop' }],
        error: null,
      });

    const result = await new OpenRouterChatHistoryRepository().readGenerationDataBatch(ids);

    expect(state.candidate.in).toHaveBeenNthCalledWith(1, 'chat_history_id', ids.slice(0, 50));
    expect(state.candidate.in).toHaveBeenNthCalledWith(2, 'chat_history_id', ids.slice(50));
    expect(result.get('turn-1')).toMatchObject({ usage: 0, finish_reason: null });
    expect(result.get('turn-52')).toMatchObject({ usage: 1, finish_reason: 'stop' });
  });

  it('updates a known generation with one identity-guarded write', async () => {
    await new OpenRouterChatHistoryRepository().updateKnownGenerationMetadata({
      chat_history_id: 'turn-1',
      llm_generation_id: 'gen-1',
      usage: 0,
      finish_reason: null,
    });

    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ usage: 0, updated_at: expect.any(String) })
    );
    expect(state.identity.eq).toHaveBeenCalledWith('chat_history_id', 'turn-1');
    expect(state.identity.eq).toHaveBeenCalledWith('llm_generation_id', 'gen-1');
    expect(state.upsert).not.toHaveBeenCalled();
  });
});

it('reads back an uncertain committed identity without repeating the write', async () => {
  state.from.mockReturnValue({
    ...state.candidate,
    update: state.update,
    upsert: state.upsert,
    select: () => state.identity,
  });
  state.identity.maybeSingle
    .mockResolvedValueOnce({ data: null, error: { message: 'timeout' } })
    .mockResolvedValueOnce({ data: { llm_generation_id: 'gen-1' }, error: null });
  await new OpenRouterChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1');
  expect(state.update).toHaveBeenCalledOnce();
});

it('rejects a conflicting durable identity and never overwrites it', async () => {
  state.from.mockReturnValue({
    ...state.candidate,
    update: state.update,
    upsert: state.upsert,
    select: () => state.identity,
  });
  state.identity.maybeSingle
    .mockResolvedValueOnce({ data: null, error: null })
    .mockResolvedValueOnce({ data: { llm_generation_id: 'another-call' }, error: null });
  await expect(
    new OpenRouterChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1')
  ).rejects.toThrow('冲突');
  expect(state.identity.is).toHaveBeenCalledWith('llm_generation_id', null);
  expect(state.update).toHaveBeenCalledOnce();
});

it('keeps zero values and omits late unknown/null metadata instead of erasing facts', async () => {
  await new OpenRouterChatHistoryRepository().upsert({
    chat_history_id: 'turn-1',
    usage: 0,
    usage_cache: 0,
    latency: null,
    model: null,
  });
  const payload = state.upsert.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(payload).toMatchObject({ usage: 0, usage_cache: 0 });
  expect(payload).not.toHaveProperty('latency');
  expect(payload).not.toHaveProperty('model');
});
