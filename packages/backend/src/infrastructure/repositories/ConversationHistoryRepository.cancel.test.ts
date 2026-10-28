import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryRow } from './ConversationHistoryRepository.js';

type FixtureRow = ConversationHistoryRow & {
  openrouter_chat_history?: { llm_generation_id: string };
  venice_chat_history?: { llm_generation_id: string };
};

const state = vi.hoisted(() => ({
  rows: [] as FixtureRow[],
  release: vi.fn(),
  cancelRpc: vi.fn(),
  select: vi.fn(),
}));
vi.mock('./MiniappCharacterFreeQuotaRepository.js', () => ({
  MiniappCharacterFreeQuotaRepository: class {
    finalizePending = state.release;
  },
}));
vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: () => state.cancelRpc(name, args),
    }),
    from: () => {
      let update: Record<string, unknown> | undefined;
      const filters: Array<(row: ConversationHistoryRow) => boolean> = [];
      let single = false;
      const query = {
        update(value: Record<string, unknown>) {
          update = value;
          return query;
        },
        select(columns = '') {
          state.select(columns);
          for (const table of ['openrouter_chat_history', 'venice_chat_history'] as const) {
            if (columns.includes(table + '!inner'))
              filters.push((row) => !!(row as FixtureRow)[table]);
          }
          return query;
        },
        neq(key: keyof ConversationHistoryRow, value: unknown) {
          filters.push((row) => row[key] !== value);
          return query;
        },
        or() {
          return query;
        },
        eq(key: keyof ConversationHistoryRow, value: unknown) {
          filters.push((row) => row[key] === value);
          return query;
        },
        is(key: keyof ConversationHistoryRow, value: unknown) {
          filters.push((row) => row[key] === value);
          return query;
        },
        not(key: string, _operator: string, _value: null) {
          filters.push((row) => {
            const [a, b] = key.split('.');
            const value = b
              ? (row as unknown as Record<string, Record<string, unknown>>)[a!]?.[b]
              : (row as unknown as Record<string, unknown>)[a!];
            return value != null;
          });
          return query;
        },
        gte(key: 'created_at', value: string) {
          filters.push((row) => row[key] >= value);
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        lt(key: 'created_at', value: string) {
          filters.push((row) => row[key] < value);
          return query;
        },
        abortSignal() {
          return query;
        },
        single() {
          single = true;
          return query;
        },
        maybeSingle() {
          single = true;
          return query;
        },
        then(
          resolve: (result: {
            data: ConversationHistoryRow | ConversationHistoryRow[] | null;
            error: null;
          }) => unknown
        ) {
          const matching = state.rows.filter((row) => filters.every((filter) => filter(row)));
          if (update) matching.forEach((row) => Object.assign(row, update));
          return Promise.resolve(
            resolve({
              data: single
                ? matching[0]
                  ? { ...matching[0] }
                  : null
                : matching.map((row) => ({ ...row })),
              error: null,
            })
          );
        },
      };
      return query;
    },
  }),
}));

const { ConversationHistoryRepository, toChatMessages, extractOpeningMessage } =
  await import('./ConversationHistoryRepository.js');
function row(overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    id: 'reply',
    user_id: 'user',
    model: 'model',
    user_input: 'original input',
    assistant_reply: null,
    history: [],
    character_id: 'character',
    status: 'streaming',
    upstream_status: null,
    deduction_rate: null,
    created_at: new Date().toISOString(),
    llm_finish_reason: null,
    llm_charge_id: 'charge',
    llm_billing_snapshot: null,
    llm_billing_settled_at: null,
    session_id: 'session',
    turn_index: 1,
    revision: 1,
    ...overrides,
  };
}
beforeEach(() => {
  state.select.mockReset();
  state.rows = [row()];
  state.release.mockReset().mockResolvedValue(null);
  state.cancelRpc
    .mockReset()
    .mockImplementation(async (_name: string, args: Record<string, unknown>) => {
      const matching = state.rows.filter(
        (row) =>
          row.session_id === args.p_session_id &&
          row.id === args.p_history_id &&
          row.status === 'streaming' &&
          row.llm_finish_reason === null
      );
      matching.forEach((row) => {
        row.llm_finish_reason =
          args.p_reason === 'user_stop'
            ? 'user_cancelled'
            : args.p_reason === 'first_token_timeout'
              ? 'timeout'
              : 'cancelled';
      });
      return { data: matching.length > 0, error: null };
    });
});

describe('bounded cancellation state reads', () => {
  it.each([null, 'user_cancelled', 'timeout'])(
    'reads authoritative state without fetching prompt/reply for %s',
    async (finishReason) => {
      state.rows = [row({ llm_finish_reason: finishReason })];
      expect(await new ConversationHistoryRepository().requireTurnState('reply')).toMatchObject({
        status: 'streaming',
        llm_finish_reason: finishReason,
      });
      expect(state.select).toHaveBeenCalledExactlyOnceWith('status,llm_finish_reason');
    }
  );
});
afterEach(() => vi.useRealTimers());

describe('persisted cancellation/completion arbitration', () => {
  it.each([
    ['user_stop', 'user_cancelled'],
    ['first_token_timeout', 'timeout'],
  ] as const)(
    'persists %s separately from legacy cancellation and cannot overwrite its winner',
    async (reason, finishReason) => {
      vi.useFakeTimers();
      const repository = new ConversationHistoryRepository();
      const pending = repository.cancelTurn('session', 'reply', reason);
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await pending).toMatchObject({ status: 'streaming', llm_finish_reason: finishReason });
      const repeated = repository.cancelTurn(
        'session',
        'reply',
        reason === 'user_stop' ? 'first_token_timeout' : 'user_stop'
      );
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await repeated).toMatchObject({ llm_finish_reason: finishReason });
    }
  );

  it('an admitted manual stop unlocks after quota completion without waiting on wallet settlement', async () => {
    state.rows[0] = row({
      llm_finish_reason: 'user_cancelled',
      llm_billing_snapshot: { charge_id: 'charge', billing_mode: 'fixed_tier' } as NonNullable<
        ConversationHistoryRow['llm_billing_snapshot']
      >,
    });
    const repository = new ConversationHistoryRepository();
    expect(
      await repository.finalizeTurn({
        historyId: 'reply',
        content: 'partial',
        status: 'stream_interrupted',
        finishReason: 'user_cancelled',
      })
    ).toMatchObject({
      status: 'stream_interrupted',
      llm_finish_reason: 'user_cancelled',
      llm_billing_settled_at: null,
    });
    expect(await repository.cancelTurn('session', 'reply', 'user_stop')).toMatchObject({
      status: 'stream_interrupted',
    });
    expect(state.cancelRpc).toHaveBeenCalledWith('cancel_chat_generation', {
      p_session_id: 'session',
      p_history_id: 'reply',
      p_reason: 'user_stop',
    });
  });

  it('a rejected unverified timeout stays pending instead of claiming a free cancellation locally', async () => {
    vi.useFakeTimers();
    state.cancelRpc.mockResolvedValueOnce({ data: false, error: null });
    const pending = new ConversationHistoryRepository().cancelTurn(
      'session',
      'reply',
      'first_token_timeout'
    );
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await pending).toMatchObject({ status: 'streaming', llm_finish_reason: null });
    expect(state.cancelRpc).toHaveBeenCalledWith('cancel_chat_generation', {
      p_session_id: 'session',
      p_history_id: 'reply',
      p_reason: 'first_token_timeout',
    });
  });

  it('pre-admission manual cancellation closes free and stale recovery preserves the manual cause', async () => {
    state.rows[0] = row({
      llm_finish_reason: 'user_cancelled',
      created_at: new Date(Date.now() - 121_000).toISOString(),
    });
    await new ConversationHistoryRepository().recoverStaleStreaming('session');
    expect(state.rows[0]).toMatchObject({
      status: 'stream_interrupted',
      llm_finish_reason: 'user_cancelled',
    });
  });

  it('cancel marker wins against success but remains busy until execution cleanup acknowledges', async () => {
    const repository = new ConversationHistoryRepository();
    const cancellation = repository.cancelTurn('session', 'reply');
    await Promise.resolve();
    const lostSuccess = await repository.finalizeTurn({
      historyId: 'reply',
      content: 'late reply',
      status: 'success',
      finishReason: 'stop',
    });
    expect(lostSuccess.status).toBe('streaming');
    expect(lostSuccess.llm_finish_reason).toBe('cancelled');
    await repository.finalizeTurn({
      historyId: 'reply',
      content: 'partial reply',
      status: 'stream_interrupted',
      finishReason: 'stop',
    });
    const terminal = await cancellation;
    expect(terminal).toMatchObject({
      status: 'stream_interrupted',
      llm_finish_reason: 'cancelled',
      assistant_reply: 'partial reply',
    });
    expect(
      (
        await repository.finalizeTurn({
          historyId: 'reply',
          content: 'late reply',
          status: 'success',
          finishReason: 'stop',
        })
      ).assistant_reply
    ).toBe('partial reply');
  });

  it('dead worker yields bounded pending; repeated cancellation keeps the same marker', async () => {
    vi.useFakeTimers();
    const repository = new ConversationHistoryRepository();
    const pending = repository.cancelTurn('session', 'reply');
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await pending).toMatchObject({ status: 'streaming', llm_finish_reason: 'cancelled' });
    const repeated = repository.cancelTurn('session', 'reply');
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await repeated).toMatchObject({ status: 'streaming', llm_finish_reason: 'cancelled' });
  });

  it('upstream stats cannot overwrite a persisted cancellation reason', async () => {
    state.rows[0] = row({ status: 'stream_interrupted', llm_finish_reason: 'cancelled' });
    await new ConversationHistoryRepository().recordBillingOutcome({
      historyId: 'reply',
      finishReason: 'stop',
    });
    expect(state.rows[0]?.llm_finish_reason).toBe('cancelled');
  });

  it('completion wins: late or repeated cancellation never reverses a complete reply', async () => {
    const repository = new ConversationHistoryRepository();
    await repository.finalizeTurn({
      historyId: 'reply',
      content: 'complete',
      status: 'success',
      finishReason: 'stop',
    });
    expect(await repository.cancelTurn('session', 'reply')).toMatchObject({
      status: 'success',
      llm_finish_reason: 'stop',
    });
    expect(await repository.cancelTurn('session', 'reply')).toMatchObject({ status: 'success' });
  });

  it('wrong session or reply ID cannot cancel another turn', async () => {
    const repository = new ConversationHistoryRepository();
    expect(await repository.cancelTurn('other-session', 'reply')).toBeNull();
    expect(await repository.cancelTurn('session', 'other-reply')).toBeNull();
    expect(state.rows[0]?.status).toBe('streaming');
    expect(state.rows[0]?.llm_finish_reason).toBeNull();
  });

  it('stale recovery releases persisted free-quota identity before unlocking', async () => {
    state.rows[0] = row({ created_at: new Date(Date.now() - 121_000).toISOString() });
    state.release.mockImplementation(async () => {
      expect(state.rows[0]?.status).toBe('streaming');
      expect(state.rows[0]?.llm_finish_reason).toBe('timeout');
    });
    await new ConversationHistoryRepository().recoverStaleStreaming('session');
    expect(state.release).toHaveBeenCalledWith('charge', false);
    expect(state.rows[0]?.status).toBe('stream_interrupted');
  });

  it('failed quota release keeps stale turn busy for safe retry', async () => {
    state.rows[0] = row({
      created_at: new Date(Date.now() - 121_000).toISOString(),
      llm_finish_reason: 'cancelled',
    });
    state.release.mockRejectedValue(new Error('quota DB unavailable'));
    await expect(
      new ConversationHistoryRepository().recoverStaleStreaming('session')
    ).rejects.toThrow('quota DB unavailable');
    expect(state.rows[0]?.status).toBe('streaming');
    expect(state.rows[0]?.llm_finish_reason).toBe('cancelled');
  });
  it('prompt snapshot keeps request identity and opening without mutating upstream prompt', async () => {
    const repository = new ConversationHistoryRepository();
    const requestId = '11111111-2222-4333-8444-555555555555';
    await repository.setPendingRequestId('reply', requestId);
    expect(toChatMessages(state.rows[0]!)[1]?.request_id).toBe(requestId);
    const prompt = [
      { role: 'system', content: 'rules' },
      { role: 'assistant', content: 'opening greeting' },
      { role: 'user', content: 'input' },
    ];
    await repository.setPromptHistory('reply', prompt, requestId);
    expect(toChatMessages(state.rows[0]!)[1]?.request_id).toBe(requestId);
    expect(extractOpeningMessage(state.rows[0]?.history)).toBe('opening greeting');
    expect(prompt[0]).not.toHaveProperty('request_id');
    expect(toChatMessages(state.rows[0]!)[0]).not.toHaveProperty('request_id');
  });

  it('legacy stored prompts omit request identity instead of guessing it', () => {
    expect(toChatMessages(row())[1]).not.toHaveProperty('request_id');
  });
});

describe('billing recovery candidate selection', () => {
  it('selects unsettled OpenRouter and Venice rows independently of provider metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    const snapshot = { provider: 'openrouter' } as ConversationHistoryRow['llm_billing_snapshot'];
    state.rows = [
      row({
        id: 'openrouter',
        openrouter_chat_history: { llm_generation_id: 'gen-1' },
        llm_billing_snapshot: snapshot,
      }),
      row({
        id: 'venice',
        venice_chat_history: { llm_generation_id: 'gen-2' },
        llm_billing_snapshot: {
          ...snapshot,
          provider: 'venice',
        } as ConversationHistoryRow['llm_billing_snapshot'],
      }),
      row({
        id: 'settled',
        openrouter_chat_history: { llm_generation_id: 'gen-3' },
        llm_billing_snapshot: snapshot,
        llm_billing_settled_at: new Date().toISOString(),
      }),
      row({ id: 'no-id', llm_billing_snapshot: snapshot }),
      row({ id: 'no-snapshot', openrouter_chat_history: { llm_generation_id: 'gen-4' } }),
      row({
        id: 'expired',
        created_at: '2020-01-01T00:00:00Z',
        openrouter_chat_history: { llm_generation_id: 'gen-5' },
        llm_billing_snapshot: snapshot,
      }),
    ];
    state.rows = state.rows.map((item) => ({ ...item, status: 'success' }));
    const rows = (
      await Promise.all(
        (['openrouter', 'venice'] as const).map((provider) =>
          new ConversationHistoryRepository().listRowsPendingBilling({
            since: '2026-10-16T00:00:00Z',
            limit: 50,
            provider,
          })
        )
      )
    ).flat();
    expect(rows.map((item) => item.id)).toEqual(['openrouter', 'venice']);
    expect(state.select).toHaveBeenCalledWith(expect.stringContaining('llm_billing_settled_at'));
  });
});
