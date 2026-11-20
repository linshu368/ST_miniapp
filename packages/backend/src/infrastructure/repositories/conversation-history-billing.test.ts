import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainDb } from '../../lib/supabase.js';
import {
  listRowsMissingProviderIdentity,
  listRowsPendingBilling,
  listStaleStreaming,
} from './conversation-history-billing.js';

const rpc = vi.fn();
const db = {
  rpc: (name: string, args: Record<string, unknown>) => ({
    abortSignal: () => rpc(name, args),
  }),
} as unknown as DomainDb;

function candidate(overrides: Record<string, unknown>) {
  return {
    id: 'turn',
    user_id: 'user',
    model: 'model',
    session_id: 'session',
    llm_finish_reason: 'stop',
    llm_charge_id: 'charge',
    assistant_reply: 'reply',
    status: 'success',
    llm_billing_snapshot: { provider: 'openrouter' },
    llm_billing_settled_at: null,
    delivery_provider: 'openrouter',
    generation_id: 'gen',
    ...overrides,
  };
}

beforeEach(() => rpc.mockReset());
afterEach(() => vi.useRealTimers());

describe('settlement candidates come from the delivered attempt (db reorg 6a-2b)', () => {
  it('scans stale rows without a 24-hour floor and seeks a bounded stable cursor', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const query = {
      select: (...args: unknown[]) => chain('select', args),
      eq: (...args: unknown[]) => chain('eq', args),
      gte: (...args: unknown[]) => chain('gte', args),
      lt: (...args: unknown[]) => chain('lt', args),
      order: (...args: unknown[]) => chain('order', args),
      limit: (...args: unknown[]) => chain('limit', args),
      or: (...args: unknown[]) => chain('or', args),
      abortSignal: async () => ({ data: [], error: null }),
    };
    function chain(name: string, args: unknown[]) {
      calls.push([name, args]);
      return query;
    }
    const client = { from: () => query } as unknown as DomainDb;
    const after = { createdAt: '2026-11-01T00:00:00Z', id: '11111111-1111-4111-8111-111111111111' };
    await listStaleStreaming(client, { limit: 200, after });
    expect(calls.some(([name]) => name === 'gte')).toBe(false);
    expect(calls).toContainEqual(['limit', [50]]);
    expect(calls).toContainEqual(['order', ['id', { ascending: true }]]);
    expect(calls).toContainEqual([
      'or',
      [`created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`],
    ]);
  });
  const input = { since: '2026-11-19T00:00:00Z', limit: 50 };

  it('passes each scan with its own budget and maps the delivered identity', async () => {
    rpc.mockResolvedValueOnce({ data: [candidate({})], error: null });
    const rows = await listRowsPendingBilling(db, { ...input, provider: 'openrouter' });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('list_chat_settlement_candidates', {
      p_scan: 'openrouter',
      p_since: input.since,
      p_limit: 50,
    });
    expect(rows).toEqual([
      expect.objectContaining({ id: 'turn', generationId: 'gen', callProvider: 'openrouter' }),
    ]);
    expect(rows[0]).not.toHaveProperty('delivery_provider');
    expect(rows[0]).not.toHaveProperty('generation_id');
  });

  it('refuses to bill under a provider the quote was not frozen for', async () => {
    rpc.mockResolvedValueOnce({
      data: [candidate({ llm_billing_snapshot: { provider: 'venice' } })],
      error: null,
    });
    const [row] = await listRowsPendingBilling(db, { ...input, provider: 'openrouter' });
    expect(row?.callProvider).toBeNull();
  });

  it('keeps snapshot-only Surplus recovery and never bills a Surplus loser as the winner', async () => {
    rpc.mockResolvedValueOnce({
      data: [
        candidate({
          id: 'winner',
          llm_billing_snapshot: { provider: 'surplus' },
          delivery_provider: 'surplus',
          generation_id: 'gen-s',
        }),
        candidate({
          id: 'no-delivery',
          llm_billing_snapshot: { provider: 'surplus' },
          delivery_provider: null,
          generation_id: null,
        }),
        candidate({
          id: 'fallback-won',
          llm_billing_snapshot: { provider: 'surplus' },
          delivery_provider: 'openrouter',
          generation_id: 'gen-o',
        }),
      ],
      error: null,
    });
    const rows = await listRowsPendingBilling(db, { ...input, provider: 'surplus' });
    expect(rows.map((row) => [row.id, row.generationId, row.callProvider])).toEqual([
      ['winner', 'gen-s', 'surplus'],
      ['no-delivery', null, 'surplus'],
      ['fallback-won', null, null],
    ]);
  });

  it('scans missing identities only after the streaming grace and trusts a valid snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
    rpc.mockResolvedValueOnce({
      data: [
        candidate({ id: 'quoted', delivery_provider: null, generation_id: null }),
        candidate({
          id: 'mismatch',
          llm_billing_snapshot: { provider: 'venice' },
          delivery_provider: 'openrouter',
          generation_id: null,
        }),
        candidate({
          id: 'unknown',
          llm_billing_snapshot: { provider: 'nope' },
          delivery_provider: null,
        }),
      ],
      error: null,
    });
    const rows = await listRowsMissingProviderIdentity(db, input);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('list_chat_settlement_candidates', {
      p_scan: 'missing_identity',
      p_since: input.since,
      p_limit: 50,
      p_identity_before: '2026-11-19T11:58:00.000Z',
    });
    expect(rows.map((row) => [row.id, row.generationId, row.callProvider])).toEqual([
      ['quoted', null, 'openrouter'],
      ['mismatch', null, null],
      ['unknown', null, null],
    ]);
  });

  it('surfaces RPC failures to the sync job', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(listRowsPendingBilling(db, { ...input, provider: 'venice' })).rejects.toThrow(
      '扫描待结算的对话失败（venice）'
    );
  });
});
