import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_MARK_KEYS, UserMarksRepository } from './UserMarksRepository.js';
import { GrowthPromptRepository } from './GrowthPromptRepository.js';
import { MiniappVipRepository } from './MiniappVipRepository.js';

// 一张假表：按 user_id + mark_key 过滤；rpc 记下调用参数。
const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  membership: null as Record<string, unknown> | null,
}));

function marksQuery() {
  const filters: { user?: string; keys?: string[] } = {};
  const query = {
    select: () => query,
    eq: (_column: string, value: string) => {
      filters.user = value;
      return query;
    },
    in: (_column: string, keys: string[]) => {
      filters.keys = keys;
      return query;
    },
    abortSignal: async () => ({
      data: state.rows.filter(
        (row) => row.user_id === filters.user && filters.keys?.includes(String(row.mark_key))
      ),
      error: null,
    }),
  };
  return query;
}

function membershipQuery() {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: state.membership, error: null }),
  };
  return query;
}

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    from: (table: string) => (table === 'user_marks' ? marksQuery() : membershipQuery()),
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      return { abortSignal: async () => ({ data: null, error: null }) };
    },
  }),
}));

function mark(userId: string, key: string, fields: Record<string, unknown>) {
  return { user_id: userId, mark_key: key, last_action: null, last_action_at: null, ...fields };
}

describe('UserMarksRepository consumers', () => {
  beforeEach(() => {
    state.rows = [];
    state.rpcCalls = [];
    state.membership = null;
  });

  it('maps growth prompt marks to prompt states and skips other users and keys', async () => {
    state.rows = [
      mark('u1', 'growth_prompt.community', { count: '2', first_at: 't0', last_at: 't2' }),
      mark('u1', 'vip_entry.seen', { count: 1, first_at: 't0', last_at: 't0' }),
      mark('u2', 'growth_prompt.vip', { count: 1, first_at: 't0', last_at: 't1' }),
    ];
    const states = await new GrowthPromptRepository().readStates('u1');
    expect([...states.entries()]).toEqual([['community', { shown_count: 2, last_shown_at: 't2' }]]);
  });

  it('reads the VIP entry first-seen time and records views through touch_user_mark', async () => {
    state.rows = [mark('u1', 'vip_entry.seen', { count: 3, first_at: 'first', last_at: 'latest' })];
    const repository = new MiniappVipRepository();
    expect((await repository.readSnapshot('u1')).entry_seen_at).toBe('first');
    expect((await repository.readSnapshot('u2')).entry_seen_at).toBeNull();

    await repository.markEntryViewed('u2', '2026-11-17T00:00:00.000Z');
    expect(state.rpcCalls).toEqual([
      {
        name: 'touch_user_mark',
        args: { p_user_id: 'u2', p_mark_key: 'vip_entry.seen', p_at: '2026-11-17T00:00:00.000Z' },
      },
    ]);
  });

  it('lets the database clock stamp a touch when no time is given', async () => {
    await new UserMarksRepository().touch('u1', USER_MARK_KEYS.charactersLatestSeen);
    expect(state.rpcCalls[0]?.args).toEqual({
      p_user_id: 'u1',
      p_mark_key: 'characters_latest.seen',
      p_at: null,
    });
  });
});
