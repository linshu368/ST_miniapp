import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainDb } from '../../lib/supabase.js';
import { LlmCallRepository } from './LlmCallRepository.js';

const rpc = vi.fn();
const db = {
  rpc: (name: string, args: Record<string, unknown>) => ({
    abortSignal: () => rpc(name, args),
  }),
} as unknown as DomainDb;

beforeEach(() => rpc.mockReset());

describe('LlmCallRepository (ops.llm_calls through experience RPCs)', () => {
  it('records metadata for a call located by turn and generation id', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await new LlmCallRepository(db).recordMetadata('turn', 'gen', { usage: 0.01 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('record_llm_call_metadata', {
      p_history_id: 'turn',
      p_generation_id: 'gen',
      p_metadata: { usage: 0.01 },
    });
  });

  it('raises when the call identity is unknown', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'LLM call identity not found' } });
    await expect(new LlmCallRepository(db).recordMetadata('turn', 'gen', {})).rejects.toThrow(
      '回写上游调用元数据失败'
    );
  });

  it('reads delivered OpenRouter metadata in batches of 50, keyed by turn', async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `turn-${index}`);
    rpc.mockImplementation(async (...call: unknown[]) => {
      const args = call[1] as { p_history_ids: string[] } | undefined;
      return {
        data: (args?.p_history_ids ?? []).map((id) => ({
          chat_history_id: id,
          usage: 0.1,
          latency: 5,
        })),
        error: null,
      };
    });
    const result = await new LlmCallRepository(db).readOpenRouterMetadataBatch([
      ...ids,
      'turn-0',
      '',
    ]);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(120);
    expect(result.get('turn-7')).toEqual({ usage: 0.1, latency: 5 });
  });

  it('maps metadata gaps to OpenRouter sync rows and refuses a quote frozen for another provider', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        {
          id: 'a',
          llm_billing_snapshot: { provider: 'openrouter' },
          delivery_provider: 'openrouter',
          generation_id: 'gen-a',
        },
        {
          id: 'b',
          llm_billing_snapshot: { provider: 'surplus' },
          delivery_provider: 'openrouter',
          generation_id: 'gen-b',
        },
        {
          id: 'c',
          llm_billing_snapshot: null,
          delivery_provider: 'openrouter',
          generation_id: 'gen-c',
        },
      ],
      error: null,
    });
    const rows = await new LlmCallRepository(db).listMetadataGaps({ since: 's', limit: 50 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('list_llm_call_metadata_gaps', {
      p_since: 's',
      p_limit: 50,
    });
    expect(rows.map((row) => [row.id, row.generationId, row.callProvider])).toEqual([
      ['a', 'gen-a', 'openrouter'],
      ['b', 'gen-b', null],
      ['c', 'gen-c', 'openrouter'],
    ]);
    expect(rows[0]).not.toHaveProperty('delivery_provider');
  });
});
