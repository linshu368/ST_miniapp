import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  from: vi.fn(),
  upsert: vi.fn(),
  candidate: {
    select: vi.fn(),
    not: vi.fn(),
    gte: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  },
  parent: { select: vi.fn(), in: vi.fn() },
}));

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({ from: state.from }),
}));

import { OpenRouterChatHistoryRepository } from './OpenRouterChatHistoryRepository.js';
import { buildGenerationMetadata } from '../../features/generation/openrouter-metadata.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(state.candidate)) mock.mockReturnValue(state.candidate);
  state.candidate.limit.mockResolvedValue({
    data: [{ chat_history_id: 'turn-1', llm_generation_id: 'gen-1' }],
    error: null,
  });
  state.parent.select.mockReturnValue(state.parent);
  state.parent.in.mockResolvedValue({ data: [{ id: 'turn-1', status: 'success' }], error: null });
  state.upsert.mockResolvedValue({ error: null });
  state.from.mockImplementation((name: string) =>
    name === 'openrouter_chat_history' ? { ...state.candidate, upsert: state.upsert } : state.parent
  );
});

describe('OpenRouterChatHistoryRepository', () => {
  it('keeps the generation ID placeholder and does not invent provider metadata', async () => {
    await new OpenRouterChatHistoryRepository().ensureGenerationId('turn-1', 'gen-1');
    expect(state.upsert).toHaveBeenCalledWith(
      {
        chat_history_id: 'turn-1',
        llm_generation_id: 'gen-1',
        updated_at: expect.any(String),
      },
      { onConflict: 'chat_history_id' }
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
    const payload = state.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      usage: 0.01,
      usage_cache: 0,
      finish_reason: 'stop',
      llm_generation_id: 'gen-1',
    });
    expect(
      Object.keys(payload)
        .filter((key) => key.startsWith('llm_'))
        .sort()
    ).toEqual(['llm_generation_data', 'llm_generation_id']);
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
    expect(rows).toEqual([{ id: 'turn-1', status: 'success', llm_generation_id: 'gen-1' }]);
  });
});
