import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@miniapp/shared';

import { ConversationStreamError } from '@/lib/api/conversation-stream';

import {
  CANCEL_DISCOVERY_DEADLINE_MS,
  useConversationTurn,
  findPendingTurnMessage,
  classifyChatTurnFailure,
  estimateChatTurnTelemetry,
  toTelemetryRevision,
} from './use-conversation-turn';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const runtime = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  effects: [] as (() => void)[],
  restore: vi.fn(),
  stream: vi.fn(),
  cancel: vi.fn(),
  fetchDetail: vi.fn(),
  client: { invalidateQueries: vi.fn(), setQueryData: vi.fn(), fetchQuery: vi.fn() },
}));

// Lightweight hook runtime: exercise asynchronous lifecycle guards without introducing a DOM dependency.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: (initial: unknown) => {
    const index = runtime.index++;
    runtime.slots[index] ??= { current: initial };
    return runtime.slots[index];
  },
  useState: (initial: unknown) => {
    const index = runtime.index++;
    if (!(index in runtime.slots)) runtime.slots[index] = initial;
    return [
      runtime.slots[index],
      (value: unknown) => {
        runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value;
      },
    ];
  },
  useCallback: (callback: unknown) => callback,
  useMemo: (callback: () => unknown) => callback(),
  useEffect: (callback: () => void, deps: unknown[]) => {
    const index = runtime.index++;
    const previous = runtime.slots[index] as unknown[] | undefined;
    if (!previous || previous.some((value, item) => value !== deps[item]))
      runtime.effects.push(callback);
    runtime.slots[index] = deps;
  },
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => runtime.client }));
vi.mock('@/lib/api/conversation-stream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/conversation-stream')>()),
  streamConversationTurn: runtime.stream,
}));
vi.mock('@/lib/api/conversations', () => ({
  conversationKeys: { detail: (id: string) => ['conversations', 'detail', id] },
  fetchConversationDetail: runtime.fetchDetail,
  useCancelConversationTurnMutation: () => ({ mutateAsync: runtime.cancel }),
}));
vi.mock('@/lib/api/free-quota', () => ({
  freeQuotaKeys: { detail: (id: string) => ['quota', id] },
  useCharacterFreeQuotaQuery: () => ({ refetch: vi.fn().mockResolvedValue({}), data: undefined }),
}));
vi.mock('@/lib/telemetry', () => ({
  getReplayLifecycle: () => ({ capture: vi.fn(), setStreaming: vi.fn() }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  runtime.slots = [];
  runtime.index = 0;
  runtime.effects = [];
  vi.clearAllMocks();
  runtime.client.invalidateQueries.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function message(
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'turn_index' | 'revision'>
): ChatMessage {
  return {
    id: 'm1',
    session_id: '33333333-3333-4333-8333-333333333333',
    role: 'assistant',
    content: 'hi',
    status: 'complete',
    error_code: null,
    finish_reason: 'stop',
    model_id: null,
    created_at: '2026-09-15T10:00:00.000Z',
    ...partial,
  };
}

describe('toTelemetryRevision', () => {
  it('projects domain revision 0 to 1 so the shared contract accepts it', () => {
    expect(toTelemetryRevision(0)).toBe(1);
    expect(toTelemetryRevision(1)).toBe(1);
    expect(toTelemetryRevision(3)).toBe(3);
  });
});

describe('estimateChatTurnTelemetry', () => {
  it('starts the next send after the last persisted turn', () => {
    expect(
      estimateChatTurnTelemetry({
        mode: 'send',
        messages: [message({ turn_index: 0, revision: 0, role: 'assistant' })],
      })
    ).toEqual({ turnIndex: 1, revision: 1 });
    expect(
      estimateChatTurnTelemetry({
        mode: 'send',
        messages: [message({ turn_index: 4, revision: 0 })],
      })
    ).toEqual({ turnIndex: 5, revision: 1 });
  });

  it('keeps regenerate on the last user turn and bumps revision', () => {
    expect(
      estimateChatTurnTelemetry({
        mode: 'regenerate',
        messages: [message({ turn_index: 2, revision: 0 })],
      })
    ).toEqual({ turnIndex: 2, revision: 1 });
    expect(
      estimateChatTurnTelemetry({
        mode: 'regenerate',
        messages: [message({ turn_index: 2, revision: 2 })],
      })
    ).toEqual({ turnIndex: 2, revision: 3 });
  });
});

describe('classifyChatTurnFailure', () => {
  it('maps credit and conversation business codes to business', () => {
    expect(
      classifyChatTurnFailure(new ConversationStreamError('余额不足', 402, 'insufficient_balance'))
    ).toBe('business');
    expect(
      classifyChatTurnFailure(new ConversationStreamError('会话忙', 409, 'session_busy'))
    ).toBe('business');
  });

  it('maps timeout names/status and treats other fetch failures as network', () => {
    expect(
      classifyChatTurnFailure(new ConversationStreamError('超时', 504, 'upstream_error'))
    ).toBe('timeout');
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    expect(classifyChatTurnFailure(timeout)).toBe('timeout');
    expect(classifyChatTurnFailure(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('does not put error bodies into the classification result', () => {
    const error = new ConversationStreamError('secret body', 502, 'upstream_error');
    expect(classifyChatTurnFailure(error)).toBe('unknown');
  });
});

describe('findPendingTurnMessage', () => {
  it('start 前只定位预期 turn/revision，不取消最近的其他轮次', () => {
    const expected = {
      sessionId: 's1',
      turnIndex: 2,
      revision: 1,
      assistantMessageId: null,
      requestId: 'request-1',
    };
    const target = message({
      session_id: 's1',
      id: 'a2',
      request_id: 'request-1',
      turn_index: 2,
      revision: 1,
      status: 'streaming',
    });
    const other = message({
      session_id: 's1',
      id: 'a3',
      turn_index: 3,
      revision: 0,
      status: 'streaming',
    });
    expect(findPendingTurnMessage([target, other], expected)).toBe(target);
    expect(findPendingTurnMessage([other], expected)).toBeUndefined();
    expect(findPendingTurnMessage([target], { ...expected, sessionId: 'other' })).toBeUndefined();
  });

  it('同轮次同 revision 的其他设备与旧无 nonce 行不能归属本请求', () => {
    const pending = {
      sessionId: 's1',
      turnIndex: 1,
      revision: 0,
      assistantMessageId: null,
      requestId: 'request-A',
    };
    const other = message({
      id: 'B',
      session_id: 's1',
      turn_index: 1,
      revision: 0,
      request_id: 'request-B',
    });
    const legacy = message({ id: 'legacy', session_id: 's1', turn_index: 1, revision: 0 });
    expect(findPendingTurnMessage([other, legacy], pending)).toBeUndefined();
  });

  it('已收到 start 后固定 ID，迟到取消不会匹配新 revision', () => {
    const expected = {
      sessionId: 's1',
      turnIndex: 2,
      revision: 0,
      assistantMessageId: 'old',
      requestId: 'request-1',
    };
    expect(
      findPendingTurnMessage(
        [message({ session_id: 's1', id: 'new', turn_index: 2, revision: 1 })],
        expected
      )
    ).toBeUndefined();
    const completed = message({ session_id: 's1', id: 'old', turn_index: 2, revision: 0 });
    expect(findPendingTurnMessage([completed], expected)).toBe(completed);
  });
});

function RenderTurn(sessionId = 's1', persistedMessages: ChatMessage[] = []) {
  runtime.index = 0;
  const result = useConversationTurn({
    characterId: 'c1',
    sessionId,
    selectedModelId: 'm1',
    selectedModelUsesFreeQuota: false,
    persistedMessages,
    returnTo: '/chat/c1',
    onSessionGone: vi.fn(),
    goBack: vi.fn(),
    onRestoreSendContent: runtime.restore,
  });
  for (const effect of runtime.effects.splice(0)) effect();
  return result;
}

describe('useConversationTurn asynchronous ownership', () => {
  it('已接受的中途错误和未知接受状态的本地超时不恢复重复草稿', async () => {
    runtime.stream.mockImplementation(async (options) => {
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'a1:user',
        turn_index: 1,
        revision: 0,
      });
      throw new ConversationStreamError('中途断流', 200, 'upstream_error');
    });
    await RenderTurn().runTurn({ mode: 'send', content: 'original' });
    expect(runtime.restore).not.toHaveBeenCalled();
    runtime.stream.mockRejectedValue(
      new ConversationStreamError('本地超时', 408, 'upstream_error')
    );
    await RenderTurn().runTurn({ mode: 'send', content: 'second' });
    expect(runtime.restore).not.toHaveBeenCalled();
  });

  it('明确 HTTP 拒绝且回查没有本轮消息时才恢复发送草稿', async () => {
    runtime.stream.mockRejectedValue(
      new ConversationStreamError('上游暂不可用', 503, 'upstream_error')
    );
    runtime.client.fetchQuery.mockResolvedValue({ messages: [] });
    await RenderTurn().runTurn({ mode: 'send', content: 'original' });
    expect(runtime.restore).toHaveBeenCalledWith('original');
  });

  it('服务端单独 streaming 时仍显示取消，失败保持 busy 且可重试', async () => {
    const pending = message({
      id: 'a1',
      session_id: 's1',
      turn_index: 1,
      revision: 0,
      status: 'streaming',
    });
    runtime.cancel.mockRejectedValue(new Error('正在取消本次回复，请稍后重试'));
    const turn = RenderTurn('s1', [pending]);
    expect(turn.generating).toBe(true);
    await turn.abort();
    const after = RenderTurn('s1', [pending]);
    expect(after.generating).toBe(true);
    expect(after.cancelling).toBe(false);
    expect(after.streamError).toContain('请稍后重试');
    expect(runtime.cancel).toHaveBeenCalledWith({ sessionId: 's1', assistantMessageId: 'a1' });
    await after.abort();
    expect(runtime.cancel).toHaveBeenCalledTimes(2);
  });

  it('旧会话迟到的 delta/done/finally 不得清空新会话生成', async () => {
    const streams: {
      options: Parameters<typeof import('@/lib/api/conversation-stream').streamConversationTurn>[0];
      resolve: () => void;
    }[] = [];
    runtime.stream.mockImplementation(
      (options) => new Promise<void>((resolve) => streams.push({ options, resolve }))
    );
    const old = RenderTurn();
    const oldRun = old.runTurn({ mode: 'send', content: 'old' });
    const next = RenderTurn('s2');
    const nextRun = next.runTurn({ mode: 'send', content: 'new' });
    streams[0]!.options.onDelta('late');
    streams[0]!.options.onDone({
      type: 'done',
      assistant_message_id: 'old',
      status: 'complete',
      finish_reason: 'stop',
    });
    streams[0]!.resolve();
    await oldRun;
    const current = RenderTurn('s2');
    expect(current.generating).toBe(true);
    expect(current.streaming?.userMessage?.content).toBe('new');
    expect(current.streaming?.text).toBe('');
    expect(runtime.client.invalidateQueries).not.toHaveBeenCalled();
    streams[1]!.resolve();
    await nextRun;
  });

  it('一次点击持续保留取消意图，前三次未发现消息后收到 start 仍取消本轮', async () => {
    let finish!: () => void;
    let streamOptions!: Parameters<
      typeof import('@/lib/api/conversation-stream').streamConversationTurn
    >[0];
    runtime.stream.mockImplementation((options) => {
      streamOptions = options;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    runtime.client.fetchQuery.mockReset();
    runtime.client.fetchQuery.mockResolvedValue({ messages: [] });
    runtime.cancel.mockResolvedValue({
      message: message({
        id: 'late-a1',
        session_id: 's1',
        turn_index: 1,
        revision: 0,
        status: 'interrupted',
        finish_reason: 'cancelled',
      }),
    });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'original' });
    const cancellation = RenderTurn().abort();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(runtime.client.fetchQuery).toHaveBeenCalledTimes(3);
    expect(RenderTurn().cancelling).toBe(true);
    expect(runtime.cancel).not.toHaveBeenCalled();
    streamOptions.onStart({
      type: 'start',
      assistant_message_id: 'late-a1',
      user_message_id: 'late-a1:user',
      turn_index: 1,
      revision: 0,
    });
    await vi.advanceTimersByTimeAsync(500);
    await cancellation;
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.cancel).toHaveBeenCalledWith({ sessionId: 's1', assistantMessageId: 'late-a1' });
    expect(RenderTurn().cancelling).toBe(false);
    finish();
    await run;
  });

  it('另一设备先接受同 turn/revision，自己的 409 迟到时不能误取消它', async () => {
    let rejectStream!: (error: unknown) => void;
    runtime.stream.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStream = reject;
        })
    );
    const otherDevice = message({
      id: 'device-B',
      session_id: 's1',
      turn_index: 1,
      revision: 0,
      status: 'streaming',
      request_id: '11111111-1111-4111-8111-111111111111',
    });
    runtime.client.fetchQuery.mockReset();
    runtime.client.fetchQuery.mockResolvedValue({ messages: [otherDevice] });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'original-A' });
    const cancellation = RenderTurn().abort();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(RenderTurn().cancelling).toBe(true);
    rejectStream(new ConversationStreamError('会话忙', 409, 'session_busy'));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([run, cancellation]);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.restore).toHaveBeenCalledWith('original-A');
  });

  it('未发现本轮时取消发现等待严格有界，不误取消另一轮', async () => {
    let finish!: () => void;
    runtime.stream.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    runtime.client.fetchQuery.mockResolvedValue({
      messages: [
        message({
          id: 'unrelated',
          session_id: 's1',
          turn_index: 8,
          revision: 0,
          status: 'streaming',
        }),
      ],
    });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'original' });
    const cancellation = RenderTurn().abort();
    await vi.advanceTimersByTimeAsync(CANCEL_DISCOVERY_DEADLINE_MS);
    await cancellation;
    expect(runtime.cancel).not.toHaveBeenCalled();
    const after = RenderTurn();
    expect(after.cancelling).toBe(false);
    expect(after.streamError).toContain('请稍后重试取消');
    finish();
    await run;
  });

  it('取消发现等待期间确认本轮未被接受时停止等待并保留原输入', async () => {
    let rejectStream!: (error: unknown) => void;
    runtime.stream.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStream = reject;
        })
    );
    runtime.client.fetchQuery.mockResolvedValue({ messages: [] });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'original' });
    const cancellation = RenderTurn().abort();
    rejectStream(new ConversationStreamError('上游不可用', 503, 'upstream_error'));
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all([run, cancellation]);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.restore).toHaveBeenCalledWith('original');
    expect(RenderTurn().cancelling).toBe(false);
    expect(RenderTurn().streaming).toBeNull();
  });

  it('双击发送只发一轮；start 前取消精确发现本轮 ID 并保留原输入', async () => {
    let finish!: () => void;
    runtime.stream.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    runtime.client.fetchQuery.mockImplementation(async () => ({
      messages: [
        message({ id: 'other', session_id: 's1', turn_index: 5, revision: 0, status: 'streaming' }),
        message({
          id: 'a1',
          session_id: 's1',
          turn_index: 1,
          revision: 0,
          status: 'streaming',
          request_id: runtime.stream.mock.calls.at(-1)?.[0].requestId,
        }),
      ],
    }));
    runtime.cancel.mockResolvedValue({
      message: message({
        id: 'a1',
        session_id: 's1',
        turn_index: 1,
        revision: 0,
        status: 'interrupted',
        finish_reason: 'cancelled',
      }),
    });
    const turn = RenderTurn();
    const run = turn.runTurn({ mode: 'send', content: 'original' });
    await turn.runTurn({ mode: 'send', content: 'duplicate' });
    expect(runtime.stream).toHaveBeenCalledTimes(1);
    const active = RenderTurn();
    await active.abort();
    expect(runtime.cancel).toHaveBeenCalledWith({ sessionId: 's1', assistantMessageId: 'a1' });
    const cacheUpdater = runtime.client.setQueryData.mock.calls.at(-1)?.[1] as (
      detail: unknown
    ) => { messages: ChatMessage[] };
    const cached = cacheUpdater({ messages: [] });
    expect(cached.messages).toMatchObject([
      { role: 'user', content: 'original', id: 'a1:user' },
      { role: 'assistant', status: 'interrupted' },
    ]);
    finish();
    await run;
    expect(RenderTurn().streaming).toBeNull();
  });
});
