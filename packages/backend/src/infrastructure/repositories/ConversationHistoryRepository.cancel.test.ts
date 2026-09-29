import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationHistoryRow } from './ConversationHistoryRepository.js';

const state = vi.hoisted(() => ({ rows: [] as ConversationHistoryRow[], release: vi.fn() }));
vi.mock('./MiniappCharacterFreeQuotaRepository.js', () => ({
  MiniappCharacterFreeQuotaRepository: class {
    finalizePending = state.release;
  },
}));
vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    from: () => {
      let update: Record<string, unknown> | undefined;
      const filters: Array<(row: ConversationHistoryRow) => boolean> = [];
      let single = false;
      const query = {
        update(value: Record<string, unknown>) {
          update = value;
          return query;
        },
        select() {
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
function row(overrides: Partial<ConversationHistoryRow> = {}): ConversationHistoryRow {
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
    llm_generation_id: null,
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
  state.rows = [row()];
  state.release.mockReset().mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('persisted cancellation/completion arbitration', () => {
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
    await new ConversationHistoryRepository().applyGenerationMetadata('reply', {
      llm_finish_reason: 'stop',
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
