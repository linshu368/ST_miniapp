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

const started = {
  turn_index: 2,
  history_id: '00000000-0000-4000-8000-0000000000b1',
  revision: 1,
  context_window_start_turn: 1,
  postprocess_version: 4,
  user_content: 'stored-user',
};

describe('postprocess turn binding', () => {
  it('calls the send and regeneration wrappers with an explicit version and window args', async () => {
    const send = repository(() => ({ data: started, error: null }));
    const turn = await send.history.startTurn({
      sessionId: 'session',
      userContent: 'raw-user',
      model: 'model-a',
      maxContextTurns: 75,
      retainContextTurns: 50,
      postprocessVersion: 4,
    });
    expect(send.calls.map((call) => call.name)).toEqual([
      'start_chat_history_turn_with_postprocess',
    ]);
    expect(send.calls[0]?.args).toMatchObject({
      p_user_content: 'raw-user',
      p_postprocess_version: 4,
      p_max_context_turns: 75,
      p_retain_context_turns: 50,
    });
    expect(turn).toMatchObject({ userContent: 'raw-user', postprocessVersion: 4 });
    expect(send.tableReads()).toBe(0);

    const regenerate = repository(() => ({ data: started, error: null }));
    const next = await regenerate.history.startRegeneration({
      sessionId: 'session',
      model: 'model-a',
      postprocessVersion: null,
    });
    expect(regenerate.calls[0]).toMatchObject({
      name: 'start_chat_history_regeneration_with_postprocess',
      args: { p_postprocess_version: null, p_model: 'model-a' },
    });
    expect(next.userContent).toBe('stored-user');
    expect(next.postprocessVersion).toBe(4);
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
        postprocessVersion: 4,
      })
    ).rejects.toBeInstanceOf(ConversationRepositoryError);
    expect(busy.calls).toHaveLength(1);
  });

  it('falls back to the old RPC only when the wrapper is missing and nothing is bound', async () => {
    const missing = repository((name) => {
      if (name.includes('with_postprocess')) {
        return {
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find start_chat_history_turn_with_postprocess in the schema cache',
          },
        };
      }
      return { data: { ...started, postprocess_version: undefined }, error: null };
    });
    const turn = await missing.history.startTurn({
      sessionId: 'session',
      userContent: 'raw-user',
      model: 'model-a',
    });
    expect(missing.calls.map((call) => call.name)).toEqual([
      'start_chat_history_turn_with_postprocess',
      'start_chat_history_turn',
    ]);
    expect(turn.postprocessVersion).toBeNull();

    const blocked = repository(() => ({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find start_chat_history_turn_with_postprocess in the schema cache',
      },
    }));
    await expect(
      blocked.history.startTurn({
        sessionId: 'session',
        userContent: 'raw-user',
        model: 'model-a',
        postprocessVersion: 4,
      })
    ).rejects.toThrow(/创建对话轮次失败/);
    expect(blocked.calls).toHaveLength(1);
  });

  it('retries the same wrapper with null when the configured version is not published', async () => {
    const unpublished = repository((_name, args) => {
      if (args.p_postprocess_version === 9) {
        return {
          data: null,
          error: { code: 'P0002', message: 'postprocess version 9 is not published' },
        };
      }
      return { data: { ...started, postprocess_version: null }, error: null };
    });
    const turn = await unpublished.history.startTurn({
      sessionId: 'session',
      userContent: 'raw-user',
      model: 'model-a',
      postprocessVersion: 9,
    });
    expect(unpublished.calls).toHaveLength(2);
    expect(unpublished.calls[1]?.args.p_postprocess_version).toBeNull();
    expect(turn.postprocessVersion).toBeNull();
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
    llm_generation_id: null,
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
});
