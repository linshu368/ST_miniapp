import { describe, expect, it } from 'vitest';
import type { DomainDb } from '../../lib/supabase.js';
import { ConversationRepositoryError } from './conversation-errors.js';
import {
  ConversationHistoryRepository,
  assembleConversationContext,
  toChatMessages,
  toOpeningMessage,
  type ConversationHistoryRow,
} from './ConversationHistoryRepository.js';

interface RpcResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

function repository(handler: (name: string, args: Record<string, unknown>) => RpcResult) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let tableReads = 0;
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const request = Promise.resolve(handler(name, args));
      return Object.assign(request, { abortSignal: () => request });
    },
    from() {
      tableReads += 1;
      throw new Error('start must not write chat_history from the application');
    },
  };
  return {
    calls,
    tableReads: () => tableReads,
    history: new ConversationHistoryRepository(db as unknown as DomainDb),
  };
}

describe('reply like persistence boundary', () => {
  const input = { userId: 'owner', sessionId: 'session', messageId: 'reply', liked: true };

  it('passes ownership and explicit state through one RPC without reading or writing history', async () => {
    const data = { session_id: 'session', message_id: 'reply', liked: true };
    const { history, calls, tableReads } = repository(() => ({ data, error: null }));
    expect(await history.setMessageLike(input)).toEqual(data);
    expect(calls).toEqual([
      {
        name: 'set_chat_message_like',
        args: {
          p_user_id: 'owner',
          p_session_id: 'session',
          p_message_id: 'reply',
          p_liked: true,
        },
      },
    ]);
    expect(tableReads()).toBe(0);
  });

  it('maps a stale or incomplete target to a domain conflict', async () => {
    const { history } = repository(() => ({
      data: null,
      error: { code: 'P0423', message: 'reply no longer current' },
    }));
    await expect(history.setMessageLike(input)).rejects.toMatchObject({
      code: 'reply_like_not_allowed',
    });
  });

  it.each([
    null,
    { session_id: 'other', message_id: 'reply', liked: true },
    { session_id: 'session', message_id: 'new-revision', liked: true },
    { session_id: 'session', message_id: 'reply', liked: false },
  ])('rejects mismatched RPC results instead of updating the wrong reply', async (data) => {
    const { history } = repository(() => ({ data, error: null }));
    await expect(history.setMessageLike(input)).rejects.toThrow('更新回复点赞结果字段不完整');
  });
});

const started = {
  turn_index: 2,
  history_id: '00000000-0000-4000-8000-0000000000b1',
  revision: 1,
  context_window_start_turn: 1,
  postprocess_version: 4,
  choice_rules_mode: 'full',
  status_rules_mode: 'concise',
  memory_rules_mode: 'off',
  user_content: 'stored-user',
};

describe('postprocess turn binding', () => {
  it('calls the current-version send and regeneration RPCs with window args', async () => {
    const send = repository(() => ({ data: started, error: null }));
    const turn = await send.history.startTurn({
      sessionId: 'session',
      userContent: 'raw-user',
      model: 'model-a',
      maxContextTurns: 75,
      retainContextTurns: 50,
    });
    expect(send.calls.map((call) => call.name)).toEqual([
      'start_chat_history_turn_with_current_postprocess',
    ]);
    expect(send.calls[0]?.args).toMatchObject({
      p_user_content: 'raw-user',
      p_max_context_turns: 75,
      p_retain_context_turns: 50,
    });
    expect(turn).toMatchObject({
      userContent: 'raw-user',
      postprocessVersion: 4,
      slotModes: { choice: 'full', status: 'concise', memory: 'off' },
    });
    expect(send.tableReads()).toBe(0);

    const regenerate = repository(() => ({ data: started, error: null }));
    const next = await regenerate.history.startRegeneration({
      sessionId: 'session',
      model: 'model-a',
    });
    expect(regenerate.calls[0]).toMatchObject({
      name: 'start_chat_history_regeneration_with_current_postprocess',
      args: { p_model: 'model-a' },
    });
    expect(next.userContent).toBe('stored-user');
    expect(next.postprocessVersion).toBe(4);
    expect(next.slotModes).toEqual({ choice: 'full', status: 'concise', memory: 'off' });
  });

  it('keeps session_busy on the wrapper and does not start a second write', async () => {
    const busy = repository(() => ({
      data: null,
      error: { code: '55006', message: 'chat session already has a streaming reply' },
    }));
    await expect(
      busy.history.startTurn({
        sessionId: 'session',
        userContent: 'raw-user',
        model: 'model-a',
      })
    ).rejects.toBeInstanceOf(ConversationRepositoryError);
    expect(busy.calls).toHaveLength(1);
  });

  it('fails closed without a legacy fallback when the new RPC is unavailable', async () => {
    const missing = repository(() => ({
      data: null,
      error: {
        code: 'PGRST202',
        message:
          'Could not find start_chat_history_turn_with_current_postprocess in the schema cache',
      },
    }));
    await expect(
      missing.history.startTurn({
        sessionId: 'session',
        userContent: 'raw-user',
        model: 'model-a',
      })
    ).rejects.toThrow(/创建对话轮次失败/);
    expect(missing.calls.map((call) => call.name)).toEqual([
      'start_chat_history_turn_with_current_postprocess',
    ]);
  });

  it('does not retry a mutation when the current version is unavailable', async () => {
    const unavailable = repository(() => ({
      data: null,
      error: { code: 'P0001', message: 'current text postprocess version is unavailable' },
    }));
    await expect(
      unavailable.history.startTurn({
        sessionId: 'session',
        userContent: 'raw-user',
        model: 'model-a',
      })
    ).rejects.toThrow(/current text postprocess version is unavailable/);
    expect(unavailable.calls).toHaveLength(1);
  });

  it('rejects a successful RPC payload that omits the bound version', async () => {
    const malformed = repository(() => ({
      data: { ...started, postprocess_version: null },
      error: null,
    }));
    await expect(
      malformed.history.startTurn({
        sessionId: 'session',
        userContent: 'raw-user',
        model: 'model-a',
      })
    ).rejects.toThrow(/结果字段不完整/);
    expect(malformed.calls).toHaveLength(1);
  });

  it('fails closed when a turn RPC omits or corrupts a persisted slot mode', async () => {
    const malformed = repository(() => ({
      data: { ...started, memory_rules_mode: null },
      error: null,
    }));
    await expect(
      malformed.history.startRegeneration({ sessionId: 'session', model: 'model-a' })
    ).rejects.toThrow(/结果字段不完整/);
    expect(malformed.calls).toHaveLength(1);
  });
});

describe('postprocess history mapping', () => {
  const row: ConversationHistoryRow = {
    id: 'history',
    user_id: 'user',
    model: 'model-a',
    user_input: 'raw-user',
    assistant_reply: 'raw reply {{user}} <p>not a rule</p>',
    history: [],
    character_id: null,
    status: 'success',
    upstream_status: 200,
    deduction_rate: null,
    created_at: '2026-09-28T00:00:00.000Z',
    llm_finish_reason: 'stop',
    llm_charge_id: null,
    llm_billing_snapshot: null,
    llm_billing_settled_at: null,
    session_id: 'session',
    turn_index: 2,
    revision: 1,
    postprocess_version: 4,
  };

  it('keeps the raw reply as content and puts the stored version only on the assistant message', () => {
    const [user, assistant] = toChatMessages(row);
    expect(user?.content).toBe('raw-user');
    expect(user?.postprocess_version).toBeNull();
    expect(assistant?.content).toBe(row.assistant_reply);
    expect(assistant?.postprocess_version).toBe(4);
    expect(toOpeningMessage('session', '开场白').postprocess_version).toBeNull();
    expect(toOpeningMessage('session', '开场白').turn_index).toBe(0);
  });

  it('does not copy the version or any display rule into the prompt context', () => {
    const context = assembleConversationContext({ windowStartTurn: 1, windowRows: [row] });
    expect(context.messages).toEqual([
      { role: 'user', content: 'raw-user' },
      { role: 'assistant', content: row.assistant_reply },
    ]);
    expect(JSON.stringify(context)).not.toContain('postprocess_version');
  });

  it('marks inherited text while dropping the original generation correlation', () => {
    const inherited = {
      ...row,
      is_inherited: true,
      history: [{ role: 'assistant', content: 'opening', request_id: 'old-request' }],
    };
    const messages = toChatMessages(inherited);
    expect(messages.every((message) => message.inherited === true)).toBe(true);
    expect(messages[1]).not.toHaveProperty('request_id');
    expect(messages[1]).toMatchObject({
      id: row.id,
      session_id: row.session_id,
      content: row.assistant_reply,
      postprocess_version: 4,
    });
  });

  it.each([true, false])(
    'projects liked=%s only onto the assistant without modifying prompt context',
    (liked) => {
      const feedbackRow = { ...row, liked };
      const [user, assistant] = toChatMessages(feedbackRow);
      expect(user).not.toHaveProperty('liked');
      expect(assistant?.liked).toBe(liked);
      expect(
        assembleConversationContext({ windowStartTurn: 1, windowRows: [feedbackRow] })
      ).toEqual(assembleConversationContext({ windowStartTurn: 1, windowRows: [row] }));
    }
  );
});

describe('branch-aware history reads', () => {
  function reader() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const query = {
      select: (...args: unknown[]) => record('select', args),
      eq: (...args: unknown[]) => record('eq', args),
      not: (...args: unknown[]) => record('not', args),
      gte: (...args: unknown[]) => record('gte', args),
      lt: (...args: unknown[]) => record('lt', args),
      or: (...args: unknown[]) => record('or', args),
      order: (...args: unknown[]) => record('order', args),
      limit: (...args: unknown[]) => record('limit', args),
      abortSignal: (...args: unknown[]) => record('abortSignal', args),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    function record(method: string, args: unknown[]) {
      calls.push({ method, args });
      return query;
    }
    const db = { from: (table: string) => record('from', [table]) };
    return {
      calls,
      history: new ConversationHistoryRepository(db as unknown as DomainDb),
    };
  }

  it('reads inherited and local rows through the overlay for paged display only', async () => {
    const { calls, history } = reader();
    await history.listMessages('branch', '', { beforeTurnIndex: 26 });
    expect(calls).toContainEqual({ method: 'from', args: ['session_chat_history'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['session_id', 'branch'] });
    expect(calls).toContainEqual({ method: 'lt', args: ['turn_index', 26] });
    expect(calls).toContainEqual({ method: 'limit', args: [26] });
    expect(calls.find((call) => call.method === 'select')?.args[0]).toContain('is_inherited');
    expect(calls.find((call) => call.method === 'select')?.args[0]).toContain(',liked');
    expect(calls.some((call) => call.method === 'abortSignal')).toBe(true);
  });

  it('continues to apply the stored A/B window to the branch overlay', async () => {
    const { calls, history } = reader();
    await history.getContextBeforeTurn('branch', 77, 27);
    expect(calls).toContainEqual({ method: 'from', args: ['session_chat_history'] });
    expect(calls.find((call) => call.method === 'select')?.args[0]).not.toContain('liked');
    expect(calls).toContainEqual({
      method: 'or',
      args: ['turn_index.eq.1,and(turn_index.gte.27,turn_index.lt.77)'],
    });
  });

  it('does not make inherited ids writable through the existing media lookup', async () => {
    const { calls, history } = reader();
    await history.findCurrentTurnById('branch', 'history');
    expect(calls).toContainEqual({ method: 'from', args: ['current_chat_history'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['session_id', 'branch'] });
  });
});
