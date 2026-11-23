import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryRow } from './ConversationHistoryRepository.js';

type FixtureRow = ConversationHistoryRow;

const state = vi.hoisted(() => ({
  rows: [] as FixtureRow[],
  cancelRpc: vi.fn(),
  select: vi.fn(),
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

const { ConversationHistoryRepository, toChatMessages } =
  await import('./ConversationHistoryRepository.js');
function row(overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    id: 'reply',
    user_id: 'user',
    model: 'model',
    user_input: 'original input',
    assistant_reply: null,
    character_id: 'character',
    status: 'streaming',
    deduction_rate: null,
    created_at: new Date().toISOString(),
    llm_finish_reason: null,
    llm_charge_id: 'charge',
    session_id: 'session',
    // The effective session view explicitly marks locally generated turns.
    is_inherited: false,
    turn_index: 1,
    revision: 1,
    ...overrides,
  };
}
beforeEach(() => {
  state.select.mockReset();
  state.rows = [row()];
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

  it('an admitted manual stop unlocks without waiting on wallet settlement', async () => {
    state.rows[0] = row({ llm_finish_reason: 'user_cancelled' });
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

  it('stale recovery claims the row as timed out, then closes it as interrupted', async () => {
    state.rows[0] = row({ created_at: new Date(Date.now() - 121_000).toISOString() });
    await new ConversationHistoryRepository().recoverStaleStreaming('session');
    expect(state.rows[0]?.status).toBe('stream_interrupted');
    expect(state.rows[0]?.llm_finish_reason).toBe('timeout');
  });

  it('request identity comes from the display projection and only on the assistant message', () => {
    const requestId = '11111111-2222-4333-8444-555555555555';
    const messages = toChatMessages(row({ display_request_id: requestId }));
    expect(messages[1]?.request_id).toBe(requestId);
    expect(messages[0]).not.toHaveProperty('request_id');
  });

  it('legacy stored prompts omit request identity instead of guessing it', () => {
    expect(toChatMessages(row())[1]).not.toHaveProperty('request_id');
  });
});
