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
  layoutEffects: [] as (() => void)[],
  reportFirstToken: vi.fn().mockResolvedValue(undefined),
  engineeringMeasurement: vi.fn(),
  engineeringEvent: vi.fn(),
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
  useLayoutEffect: (callback: () => void, deps: unknown[]) => {
    const index = runtime.index++;
    const previous = runtime.slots[index] as unknown[] | undefined;
    if (!previous || previous.some((value, item) => value !== deps[item]))
      runtime.layoutEffects.push(callback);
    runtime.slots[index] = deps;
  },
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
  reportConversationFirstToken: runtime.reportFirstToken,
  useCancelConversationTurnMutation: () => ({ mutateAsync: runtime.cancel }),
}));
vi.mock('@/lib/api/free-quota', () => ({
  freeQuotaKeys: { detail: (id: string) => ['quota', id] },
  useCharacterFreeQuotaQuery: () => ({ refetch: vi.fn().mockResolvedValue({}), data: undefined }),
}));
vi.mock('@/lib/telemetry', () => ({
  getReplayLifecycle: () => ({ capture: vi.fn(), setStreaming: vi.fn() }),
}));
vi.mock('@/lib/perf/grafana', () => ({
  recordEngineeringMeasurement: runtime.engineeringMeasurement,
  recordEngineeringEvent: runtime.engineeringEvent,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  runtime.slots = [];
  runtime.index = 0;
  runtime.effects = [];
  runtime.layoutEffects = [];
  vi.clearAllMocks();
  runtime.client.invalidateQueries.mockResolvedValue(undefined);
  runtime.client.fetchQuery.mockReset().mockResolvedValue({ messages: [] });
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

function RenderTurn(
  sessionId = 's1',
  persistedMessages: ChatMessage[] = [],
  thinkingEnabled = true,
  firstTokenDeadlineMs = 10000
) {
  runtime.index = 0;
  const result = useConversationTurn({
    characterId: 'c1',
    sessionId,
    selectedModelId: 'm1',
    selectedModelUsesFreeQuota: false,
    thinkingEnabled,
    firstTokenDeadlineMs,
    persistedMessages,
    returnTo: '/chat/c1',
    onSessionGone: vi.fn(),
    goBack: vi.fn(),
    onRestoreSendContent: runtime.restore,
  });
  for (const effect of runtime.layoutEffects.splice(0)) effect();
  for (const effect of runtime.effects.splice(0)) effect();
  return result;
}

function holdStreams() {
  const streams: {
    options: Parameters<typeof import('@/lib/api/conversation-stream').streamConversationTurn>[0];
    finish: () => void;
  }[] = [];
  runtime.stream.mockImplementation(
    (options) =>
      new Promise<void>((finish) => {
        streams.push({ options, finish });
      })
  );
  return streams;
}

describe('useConversationTurn asynchronous ownership', () => {
  it('preserves partial text and ignores old callbacks after restoring regeneration', async () => {
    const streams = holdStreams();
    const oldRun = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    const old = streams[0]!;
    old.options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    old.options.onDelta('已收到的部分回复');
    const persisted = [
      message({
        id: 'a1',
        session_id: 's1',
        request_id: old.options.requestId,
        turn_index: 1,
        revision: 0,
        status: 'interrupted',
        content: '',
        finish_reason: 'timeout',
      }),
    ];
    RenderTurn('s1', persisted);
    const recovered = RenderTurn('s1', persisted);
    expect(recovered.messages.at(-1)?.content).toBe('已收到的部分回复');
    expect(recovered.canRegenerate).toBe(true);
    const nextRun = recovered.runTurn({ mode: 'regenerate' });
    old.options.onDelta('迟到的旧文本');
    old.options.onDone({
      type: 'done',
      assistant_message_id: 'a1',
      status: 'complete',
      finish_reason: 'stop',
    });
    old.finish();
    await oldRun;
    const current = RenderTurn('s1', persisted);
    expect(current.generating).toBe(true);
    expect(current.streaming?.text).toBe('');
    expect(runtime.stream).toHaveBeenCalledTimes(2);
    expect(runtime.cancel).not.toHaveBeenCalled();
    streams[1]!.finish();
    await nextRun;
  });

  it.each(['other-request', 'other-revision', 'streaming'] as const)(
    'does not unlock a hanging request for a %s server snapshot',
    async (kind) => {
      const streams = holdStreams();
      const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
      const { options, finish } = streams[0]!;
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      const persisted = [
        message({
          id: 'a1',
          session_id: 's1',
          request_id: kind === 'other-request' ? 'other' : options.requestId,
          turn_index: 1,
          revision: kind === 'other-revision' ? 1 : 0,
          status: kind === 'streaming' ? 'streaming' : 'complete',
        }),
      ];
      RenderTurn('s1', persisted);
      expect(RenderTurn('s1', persisted).generating).toBe(true);
      expect(options.signal?.aborted).toBe(false);
      finish();
      await run;
    }
  );

  it('recovers the matching terminal before SSE start without cancelling the server', async () => {
    const streams = holdStreams();
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    const { options, finish } = streams[0]!;
    const persisted = [
      message({
        id: 'a1',
        session_id: 's1',
        request_id: options.requestId,
        turn_index: 1,
        revision: 0,
      }),
    ];
    RenderTurn('s1', persisted);
    expect(RenderTurn('s1', persisted).canRegenerate).toBe(true);
    expect(options.signal?.aborted).toBe(true);
    expect(runtime.cancel).not.toHaveBeenCalled();
    finish();
    await run;
  });

  it('probes a silent foreground stream only once, including after a failed probe and more stalls', async () => {
    const streams = holdStreams();
    runtime.client.fetchQuery.mockRejectedValue(new Error('offline'));
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    const { options, finish } = streams[0]!;
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    RenderTurn();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(runtime.client.fetchQuery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.client.fetchQuery).toHaveBeenCalledOnce();
    expect(runtime.client.fetchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['conversations', 'detail', 's1'], retry: false })
    );
    options.onDelta('partial');
    RenderTurn();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.client.fetchQuery).toHaveBeenCalledOnce();
    expect(runtime.stream).toHaveBeenCalledOnce();
    expect(runtime.cancel).not.toHaveBeenCalled();
    finish();
    await run;
  });

  it.each(['background', 'already-polling'] as const)(
    'does not add a recovery query when %s',
    async (kind) => {
      const streams = holdStreams();
      const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
      const { options, finish } = streams[0]!;
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      const persisted =
        kind === 'already-polling'
          ? [
              message({
                id: 'a1',
                session_id: 's1',
                request_id: options.requestId,
                turn_index: 1,
                revision: 0,
                status: 'streaming',
              }),
            ]
          : [];
      if (kind === 'background')
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      RenderTurn('s1', persisted);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(runtime.client.fetchQuery).not.toHaveBeenCalled();
      expect(runtime.stream).toHaveBeenCalledOnce();
      finish();
      await run;
    }
  );

  it('does not run a stall probe or unlock while manual cancellation owns the turn', async () => {
    const streams = holdStreams();
    let confirm!: (result: unknown) => void;
    runtime.cancel.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        })
    );
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    const { options, finish } = streams[0]!;
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    const cancel = RenderTurn().abort();
    const persisted = [
      message({
        id: 'a1',
        session_id: 's1',
        request_id: options.requestId,
        turn_index: 1,
        revision: 0,
        status: 'interrupted',
        finish_reason: 'user_cancelled',
      }),
    ];
    RenderTurn('s1', persisted);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(runtime.client.fetchQuery).not.toHaveBeenCalled();
    expect(options.signal?.aborted).toBe(false);
    expect(RenderTurn('s1', persisted).cancelling).toBe(true);
    confirm({ message: persisted[0] });
    await cancel;
    finish();
    await run;
  });

  it.each(['complete', 'interrupted', 'failed'] as const)(
    'releases a hanging local stream when the exact server revision is %s',
    async (status) => {
      let options!: Parameters<
        typeof import('@/lib/api/conversation-stream').streamConversationTurn
      >[0];
      let finish!: () => void;
      runtime.stream.mockImplementation((value) => {
        options = value;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      const persisted = [
        message({
          id: 'a1',
          session_id: 's1',
          request_id: options.requestId,
          turn_index: 1,
          revision: 0,
          status,
          finish_reason: status === 'complete' ? 'stop' : 'timeout',
        }),
      ];
      RenderTurn('s1', persisted);
      const recovered = RenderTurn('s1', persisted);
      expect(recovered.generating).toBe(false);
      expect(recovered.canRegenerate).toBe(true);
      expect(options.signal?.aborted).toBe(true);
      expect(runtime.cancel).not.toHaveBeenCalled();
      finish();
      await run;
    }
  );

  it('the first committed thinking character satisfies the same deadline as an answer character', async () => {
    let options!: Parameters<
      typeof import('@/lib/api/conversation-stream').streamConversationTurn
    >[0];
    let finish!: () => void;
    runtime.stream.mockImplementation((value) => {
      options = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    options.onFirstDeltaReceived?.();
    options.onReasoning?.('思');
    RenderTurn();
    expect(runtime.reportFirstToken).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        outcome: 'observed',
        measurement_method: 'client_committed_v4',
      })
    );
    await vi.advanceTimersByTimeAsync(6_100);
    const after = RenderTurn();
    expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
    expect(after.generating).toBe(true);
    expect(after.streamError).toBeNull();
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(after.streaming?.text).toBe('');
    expect(after.thinkingByMessage['s1:a1:0']).toBe('思');
    finish();
    await run;
  });

  it('uses the frozen six-second SSE budget from the original click despite a cached ten-second catalog', async () => {
    let options!: Parameters<
      typeof import('@/lib/api/conversation-stream').streamConversationTurn
    >[0];
    let finish!: () => void;
    runtime.stream.mockImplementation((value) => {
      options = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const run = RenderTurn('s1', [], true, 10000).runTurn({ mode: 'send', content: 'hello' });
    await vi.advanceTimersByTimeAsync(2000);
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
      first_token_deadline_ms: 6000,
    });
    await vi.advanceTimersByTimeAsync(3999);
    expect(runtime.reportFirstToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.reportFirstToken).toHaveBeenCalledExactlyOnceWith(
      's1',
      expect.objectContaining({ outcome: 'timed_out', wait_finished_ms: 6000 })
    );
    expect(RenderTurn('s1').streamError).toBe('这次回应稍慢，再试一次吧');
    expect(runtime.cancel).not.toHaveBeenCalled();
    finish();
    await run;
  });

  it.each([
    ['normal', false],
    ['deep-thinking', true],
  ] as const)(
    'reports a silent %s deadline without cancelling the server-owned reply',
    async (_, thinkingEnabled) => {
      let options!: Parameters<
        typeof import('@/lib/api/conversation-stream').streamConversationTurn
      >[0];
      let finish!: () => void;
      runtime.stream.mockImplementation((value) => {
        options = value;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const run = RenderTurn('s1', [], thinkingEnabled).runTurn({ mode: 'send', content: 'hello' });
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      runtime.cancel.mockResolvedValue({
        message: message({
          id: 'a1',
          session_id: 's1',
          turn_index: 1,
          revision: 0,
          status: 'interrupted',
          content: '',
        }),
      });
      await vi.advanceTimersByTimeAsync(10_100);
      const waiting = RenderTurn('s1', [], thinkingEnabled);
      expect(runtime.reportFirstToken).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          assistant_message_id: 'a1',
          outcome: 'timed_out',
          first_token_visible_ms: null,
        })
      );
      expect(waiting.streamError).toBe('这次回应稍慢，再试一次吧');
      expect(runtime.cancel).not.toHaveBeenCalled();
      options.onFirstDeltaReceived?.();
      options.onDelta('迟到但可交付');
      expect(RenderTurn('s1', [], thinkingEnabled).messages.at(-1)?.content).toBe('迟到但可交付');
      expect(RenderTurn('s1', [], thinkingEnabled).streamError).toBeNull();
      expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
      finish();
      await run;
    }
  );

  it('keeps the deadline running after receiving text until React commits the message', async () => {
    let options!: Parameters<
      typeof import('@/lib/api/conversation-stream').streamConversationTurn
    >[0];
    let finish!: () => void;
    runtime.stream.mockImplementation((value) => {
      options = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    await vi.advanceTimersByTimeAsync(2000);
    options.onFirstDeltaReceived?.();
    options.onDelta('已经收到，但还未提交');
    expect(runtime.reportFirstToken).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8100);
    expect(runtime.reportFirstToken).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        outcome: 'timed_out',
        first_token_visible_ms: null,
        first_token_received_ms: 2000,
      })
    );
    expect(RenderTurn().messages.at(-1)?.content).toBe('已经收到，但还未提交');
    expect(RenderTurn().streamError).toBeNull();
    expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
    expect(runtime.cancel).not.toHaveBeenCalled();
    finish();
    await run;
  });

  it('does not erase the timeout hint on a late start, empty delta or an older revision', async () => {
    let options!: Parameters<
      typeof import('@/lib/api/conversation-stream').streamConversationTurn
    >[0];
    let finish!: () => void;
    runtime.stream.mockImplementation((value) => {
      options = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const run = RenderTurn().runTurn({ mode: 'regenerate' });
    await vi.advanceTimersByTimeAsync(10100);
    expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
    expect(runtime.engineeringMeasurement).toHaveBeenCalledWith(
      'roleplay.first_token',
      expect.any(Number),
      expect.objectContaining({ action: 'regenerate', outcome: 'timed_out' })
    );
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: null,
      turn_index: 1,
      revision: 1,
    });
    options.onDelta('  ');
    expect(RenderTurn().streamError).toBe('这次回应稍慢，再试一次吧');
    const older = message({
      id: 'a1',
      session_id: 's1',
      request_id: options.requestId,
      turn_index: 1,
      revision: 0,
      content: '旧版本正文',
    });
    RenderTurn('s1', [older]);
    expect(RenderTurn('s1', [older]).streamError).toBe('这次回应稍慢，再试一次吧');
    const unrelated = { ...older, revision: 1, request_id: 'other-request' };
    RenderTurn('s1', [unrelated]);
    expect(RenderTurn('s1', [unrelated]).streamError).toBe('这次回应稍慢，再试一次吧');
    const empty = { ...older, revision: 1, content: '', status: 'failed' as const };
    RenderTurn('s1', [empty]);
    expect(runtime.engineeringMeasurement).toHaveBeenCalledWith(
      'roleplay.full_reply',
      expect.any(Number),
      expect.objectContaining({ action: 'regenerate', outcome: 'failed' })
    );
    expect(RenderTurn('s1', [empty]).streamError).toBe('这次回应稍慢，再试一次吧');
    expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
    expect(runtime.reportFirstToken).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        revision: null,
        outcome: 'timed_out',
        wait_finished_ms: 10000,
      })
    );
    finish();
    await run;
  });

  it('separates background recovery from foreground delivery without cancelling generation or reporting twice', async () => {
    let options!: Parameters<
      typeof import('@/lib/api/conversation-stream').streamConversationTurn
    >[0];
    let finish!: () => void;
    runtime.stream.mockImplementation((value) => {
      options = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);
    Object.assign(document, { visibilityState: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(15000);
    Object.assign(document, { visibilityState: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    options.onFirstDeltaReceived?.();
    options.onDelta('回来继续看');
    expect(RenderTurn().messages.at(-1)?.content).toBe('回来继续看');
    expect(RenderTurn().streamError).toBeNull();
    expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
    expect(runtime.reportFirstToken).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        outcome: 'not_observed',
        reason: 'page_left',
        backgrounded: true,
        first_token_visible_ms: null,
      })
    );
    expect(runtime.cancel).not.toHaveBeenCalled();
    finish();
    await run;
  });

  it.each(['streaming', 'complete'] as const)(
    'clears a %s reply before a new session can commit its queued token',
    async (status) => {
      const streams: {
        options: Parameters<
          typeof import('@/lib/api/conversation-stream').streamConversationTurn
        >[0];
        resolve: () => void;
      }[] = [];
      runtime.stream.mockImplementation(
        (options) => new Promise<void>((resolve) => streams.push({ options, resolve }))
      );
      const firstRun = RenderTurn().runTurn({ mode: 'send', content: 'first' });
      const first = streams[0]!;
      first.options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      await vi.advanceTimersByTimeAsync(2000);
      first.options.onFirstDeltaReceived?.();
      first.options.onDelta('旧会话已收到但尚未提交的文字');
      if (status === 'complete') {
        first.options.onDone({
          type: 'done',
          assistant_message_id: 'a1',
          status: 'complete',
          finish_reason: 'stop',
        });
        first.resolve();
        await firstRun;
      }
      // React layout effects run before passive effects. Session cleanup must precede
      // the commit observer when both the queued token and session change render together.
      RenderTurn('s2');
      expect(runtime.reportFirstToken).toHaveBeenCalledExactlyOnceWith(
        's1',
        expect.objectContaining({
          request_id: first.options.requestId,
          outcome: 'not_observed',
          reason: 'page_left',
          first_token_visible_ms: null,
        })
      );
      first.options.onDelta('离开后旧流又到了');
      first.resolve();
      await firstRun;
      expect(RenderTurn('s2').messages).toEqual([]);
      expect(runtime.cancel).not.toHaveBeenCalled();

      const recovered = message({
        id: 'a1',
        session_id: 's1',
        request_id: first.options.requestId,
        turn_index: 1,
        revision: 0,
        content: '返回后看到完整旧回复',
      });
      RenderTurn('s1', [recovered]);
      expect(RenderTurn('s1', [recovered]).messages).toEqual([recovered]);
      expect(runtime.reportFirstToken).toHaveBeenCalledOnce();

      const secondRun = RenderTurn('s2').runTurn({ mode: 'send', content: 'second' });
      const second = streams[1]!;
      second.options.onStart({
        type: 'start',
        assistant_message_id: 'a2',
        user_message_id: 'u2',
        turn_index: 1,
        revision: 0,
      });
      second.options.onFirstDeltaReceived?.();
      second.options.onDelta('新会话首字');
      expect(RenderTurn('s2').messages.at(-1)?.content).toBe('新会话首字');
      expect(runtime.reportFirstToken).toHaveBeenCalledTimes(2);
      expect(runtime.reportFirstToken).toHaveBeenLastCalledWith(
        's2',
        expect.objectContaining({
          request_id: second.options.requestId,
          assistant_message_id: 'a2',
          outcome: 'observed',
        })
      );
      second.resolve();
      await secondRun;
    }
  );

  it.each([true, false])(
    'uses the submitted thinking preference (%s) after the preference changes',
    async (submittedThinking) => {
      let options!: Parameters<
        typeof import('@/lib/api/conversation-stream').streamConversationTurn
      >[0];
      let finish!: () => void;
      runtime.stream.mockImplementation((value) => {
        options = value;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const run = RenderTurn('s1', [], submittedThinking).runTurn({
        mode: 'send',
        content: 'hello',
      });
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      // Recovery may carry reasoning even when a subsequent settings render has changed.
      const recovered = message({
        id: 'a1',
        session_id: 's1',
        request_id: options.requestId,
        turn_index: 1,
        revision: 0,
        content: '',
        reasoning: '思考',
        status: 'streaming',
      });
      RenderTurn('s1', [recovered], !submittedThinking);
      expect(runtime.reportFirstToken).toHaveBeenCalledTimes(submittedThinking ? 1 : 0);
      options.onDelta('正文');
      RenderTurn('s1', [recovered], !submittedThinking);
      expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
      expect(runtime.reportFirstToken).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ outcome: 'observed' })
      );
      finish();
      await run;
    }
  );

  it('keeps thinking separate after completion, snapshots the switch and clears on session change', async () => {
    const streams: {
      options: Parameters<typeof import('@/lib/api/conversation-stream').streamConversationTurn>[0];
      resolve: () => void;
    }[] = [];
    runtime.stream.mockImplementation(
      (options) => new Promise<void>((resolve) => streams.push({ options, resolve }))
    );
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    const first = streams[0]!;
    first.options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    // A rerender with a different preference must not change the request already submitted.
    RenderTurn('s1', [], false);
    expect(first.options.thinkingEnabled).toBe(true);
    first.options.onReasoning?.('公开思考');
    first.options.onDelta('正文');
    expect(RenderTurn().thinkingByMessage['s1:a1:0']).toBe('公开思考');
    expect(RenderTurn().streaming?.text).toBe('正文');
    first.options.onDone({
      type: 'done',
      assistant_message_id: 'a1',
      status: 'complete',
      finish_reason: 'stop',
    });
    first.resolve();
    await run;
    expect(RenderTurn().thinkingByMessage['s1:a1:0']).toBe('公开思考');
    first.options.onReasoning?.('late after done');
    expect(RenderTurn().thinkingByMessage['s1:a1:0']).toBe('公开思考');
    const regenerate = RenderTurn('s1', [], false).runTurn({ mode: 'regenerate' });
    expect(streams[1]!.options.thinkingEnabled).toBe(false);
    streams[1]!.options.onStart({
      type: 'start',
      assistant_message_id: 'a2',
      user_message_id: null,
      turn_index: 1,
      revision: 1,
    });
    streams[1]!.options.onReasoning?.('off should ignore');
    expect(RenderTurn().thinkingByMessage['s1:a2:1']).toBeUndefined();
    streams[1]!.resolve();
    await regenerate;
    RenderTurn('s2');
    expect(RenderTurn('s2').thinkingByMessage).toEqual({});
  });

  it('confirmed cancellation ignores late thinking from that request', async () => {
    let options!: Parameters<
      typeof import('@/lib/api/conversation-stream').streamConversationTurn
    >[0];
    let finish!: () => void;
    runtime.stream.mockImplementation((value) => {
      options = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    options.onReasoning?.('before cancel');
    runtime.cancel.mockResolvedValue({
      message: message({
        id: 'a1',
        session_id: 's1',
        turn_index: 1,
        revision: 0,
        content: '',
        status: 'interrupted',
        finish_reason: 'cancelled',
      }),
    });
    await RenderTurn().abort();
    options.onReasoning?.('after cancel');
    expect(RenderTurn().thinkingByMessage['s1:a1:0']).toBe('before cancel');
    expect(RenderTurn().generating).toBe(false);
    finish();
    await run;
  });

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
    expect(runtime.cancel).toHaveBeenCalledWith({
      sessionId: 's1',
      assistantMessageId: 'a1',
      reason: 'user_stop',
    });
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
    streams[0]!.options.onReasoning?.('late thinking');
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
    expect(current.thinkingByMessage).toEqual({});
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
    expect(runtime.cancel).toHaveBeenCalledWith({
      sessionId: 's1',
      assistantMessageId: 'late-a1',
      reason: 'user_stop',
    });
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
    expect(runtime.cancel).toHaveBeenCalledWith({
      sessionId: 's1',
      assistantMessageId: 'a1',
      reason: 'user_stop',
    });
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

it('recovers a disconnected accepted reply from the same revision without another generation or cancellation', async () => {
  let options!: Parameters<
    typeof import('@/lib/api/conversation-stream').streamConversationTurn
  >[0];
  runtime.stream.mockImplementation(async (value) => {
    options = value;
    value.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    throw new ConversationStreamError('connection closed', 200, 'upstream_error', undefined, true);
  });
  await RenderTurn('s1', [], true).runTurn({ mode: 'send', content: 'hello' });
  const recovered = message({
    id: 'a1',
    session_id: 's1',
    request_id: options.requestId,
    turn_index: 1,
    revision: 0,
    status: 'streaming',
    content: '恢复的正文',
    reasoning: '恢复的思考',
  });
  RenderTurn('s1', [recovered], true);
  const view = RenderTurn('s1', [recovered], true);
  expect(view.messages.at(-1)?.content).toBe('恢复的正文');
  expect(view.thinkingByMessage['s1:a1:0']).toBe('恢复的思考');
  expect(view.streamError).toBeNull();
  expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
  expect(runtime.reportFirstToken).toHaveBeenCalledWith(
    's1',
    expect.objectContaining({
      assistant_message_id: 'a1',
      outcome: 'observed',
      measurement_method: 'client_committed_v4',
    })
  );
  expect(runtime.stream).toHaveBeenCalledOnce();
  expect(runtime.cancel).not.toHaveBeenCalled();
  expect(
    runtime.engineeringMeasurement.mock.calls.filter(([name]) => name === 'roleplay.full_reply')
  ).toHaveLength(0);
  RenderTurn('s1', [{ ...recovered, status: 'complete' }], true);
  expect(runtime.engineeringMeasurement).toHaveBeenCalledWith(
    'roleplay.recovery',
    expect.any(Number),
    expect.objectContaining({ action: 'send', stage: 'recovery', outcome: 'complete' })
  );
});

describe('terminal SSE batches retain delivered text until persistence catches up', () => {
  it.each([
    ['body', 'error', 2000],
    ['reasoning', 'error', 2000],
    ['body', 'done', 2000],
    ['reasoning', 'done', 2000],
    ['body', 'error', 10000],
    ['reasoning', 'error', 10000],
    ['body', 'done', 10000],
    ['reasoning', 'done', 10000],
  ] as const)(
    '%s + %s commits at %s ms, with no transient disappearance',
    async (part, end, commitMs) => {
      let options!: Parameters<
        typeof import('@/lib/api/conversation-stream').streamConversationTurn
      >[0];
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      runtime.stream.mockImplementation((value) => {
        options = value;
        return new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
      });
      const run = RenderTurn().runTurn({ mode: 'send', content: 'hello' });
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      await vi.advanceTimersByTimeAsync(2000);
      options.onFirstDeltaReceived?.();
      if (part === 'body') options.onDelta('已经交付的文字');
      else options.onReasoning?.('已经交付的思考');
      if (end === 'error')
        reject(new ConversationStreamError('upstream failed', 200, 'upstream_error'));
      else {
        options.onDone({
          type: 'done',
          assistant_message_id: 'a1',
          status: 'complete',
          finish_reason: 'stop',
        });
        resolve();
      }
      await run;
      expect(runtime.reportFirstToken).not.toHaveBeenCalled();
      expect(
        runtime.engineeringMeasurement.mock.calls.filter(([name]) => name === 'roleplay.full_reply')
      ).toHaveLength(0);
      if (commitMs > 2000) await vi.advanceTimersByTimeAsync(commitMs - 2000);
      const committed = RenderTurn();
      expect(committed.messages.at(-1)).toMatchObject({
        id: 'a1',
        content: part === 'body' ? '已经交付的文字' : '',
        status: end === 'done' ? 'complete' : 'interrupted',
      });
      expect(committed.generating).toBe(false);
      expect(committed.streaming).toBeNull();
      if (part === 'reasoning')
        expect(committed.thinkingByMessage['s1:a1:0']).toBe('已经交付的思考');
      expect(runtime.reportFirstToken).toHaveBeenCalledExactlyOnceWith(
        's1',
        expect.objectContaining({
          outcome: commitMs < 10000 ? 'observed' : 'timed_out',
          first_token_visible_ms: commitMs < 10000 ? commitMs : null,
          first_token_received_ms: 2000,
        })
      );
      expect(runtime.engineeringMeasurement).toHaveBeenCalledWith(
        'roleplay.full_reply',
        expect.any(Number),
        expect.objectContaining({
          stage: 'full_reply',
          action: 'send',
          outcome: end === 'done' ? 'complete' : 'interrupted',
        })
      );
      expect(RenderTurn().messages.at(-1)?.id).toBe('a1');
      const durable = message({
        id: 'a1',
        session_id: 's1',
        request_id: options.requestId,
        turn_index: 1,
        revision: 0,
        content: part === 'body' ? '已经交付的文字（持久化）' : '',
        status: 'complete',
      });
      RenderTurn('s1', [durable]);
      expect(RenderTurn('s1', [durable]).messages).toEqual([durable]);
      expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
      expect(
        runtime.engineeringMeasurement.mock.calls.filter(([name]) => name === 'roleplay.full_reply')
      ).toHaveLength(1);
      expect(runtime.cancel).not.toHaveBeenCalled();
    }
  );

  it('immediately records an empty explicit error without waiting for the deadline', async () => {
    runtime.stream.mockImplementation(async (options) => {
      options.onStart({
        type: 'start',
        assistant_message_id: 'a1',
        user_message_id: 'u1',
        turn_index: 1,
        revision: 0,
      });
      throw new ConversationStreamError('upstream failed', 200, 'upstream_error');
    });
    await RenderTurn().runTurn({ mode: 'send', content: 'hello' });
    expect(runtime.reportFirstToken).toHaveBeenCalledExactlyOnceWith(
      's1',
      expect.objectContaining({
        outcome: 'not_observed',
        reason: 'upstream_error',
        first_token_received_ms: null,
      })
    );
    expect(RenderTurn().messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(11000);
    expect(runtime.reportFirstToken).toHaveBeenCalledOnce();
  });

  it('keeps an unacknowledged terminal reply when the next turn starts from an old server snapshot', async () => {
    const streams: {
      options: Parameters<typeof import('@/lib/api/conversation-stream').streamConversationTurn>[0];
      resolve: () => void;
    }[] = [];
    runtime.stream.mockImplementation(
      (options) => new Promise<void>((resolve) => streams.push({ options, resolve }))
    );
    const firstRun = RenderTurn().runTurn({ mode: 'send', content: 'first' });
    const first = streams[0]!;
    first.options.onStart({
      type: 'start',
      assistant_message_id: 'a1',
      user_message_id: 'u1',
      turn_index: 1,
      revision: 0,
    });
    first.options.onFirstDeltaReceived?.();
    first.options.onDelta('first response');
    first.options.onDone({
      type: 'done',
      assistant_message_id: 'a1',
      status: 'complete',
      finish_reason: 'stop',
    });
    first.resolve();
    await firstRun;
    const secondRun = RenderTurn().runTurn({ mode: 'send', content: 'second' });
    const waiting = RenderTurn();
    expect(
      waiting.messages.some((item) => item.id === 'a1' && item.content === 'first response')
    ).toBe(true);
    expect(waiting.streaming?.turnIndex).toBe(2);
    streams[1]!.options.onStart({
      type: 'start',
      assistant_message_id: 'a2',
      user_message_id: 'u2',
      turn_index: 2,
      revision: 0,
    });
    streams[1]!.options.onFirstDeltaReceived?.();
    streams[1]!.options.onDelta('second response');
    streams[1]!.options.onDone({
      type: 'done',
      assistant_message_id: 'a2',
      status: 'complete',
      finish_reason: 'stop',
    });
    streams[1]!.resolve();
    await secondRun;
    expect(
      RenderTurn()
        .messages.filter((item) => item.role === 'assistant')
        .map((item) => item.content)
    ).toEqual(['first response', 'second response']);
    const durable = [
      message({
        id: 'a1',
        session_id: 's1',
        request_id: first.options.requestId,
        turn_index: 1,
        revision: 0,
        content: 'first response',
      }),
      message({
        id: 'a2',
        session_id: 's1',
        request_id: streams[1]!.options.requestId,
        turn_index: 2,
        revision: 0,
        content: 'second response',
      }),
    ];
    RenderTurn('s1', durable);
    expect(RenderTurn('s1', durable).messages).toEqual(durable);
  });
});
