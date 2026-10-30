import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import type { RequestLogger } from '../../lib/logger.js';
import type { ConversationStreamSink } from './sse.js';

const mocks = vi.hoisted(() => ({
  pendingRequest: vi.fn(),
  recover: vi.fn(),
  start: vi.fn(),
  regenerate: vi.fn(),
  context: vi.fn(),
  prompt: vi.fn(),
  finalize: vi.fn(),
  find: vi.fn(),
  execute: vi.fn(),
  ensureGenerationId: vi.fn(),
  ensurePlaceholder: vi.fn(),
  saveSnapshot: vi.fn(),
  markServer: vi.fn(),
  checkpoint: vi.fn(),
  begin: vi.fn(),
}));
vi.mock('../../infrastructure/repositories/GenerationObservationRepository.js', () => ({
  GenerationObservationRepository: class {
    begin = mocks.begin;
    observe = vi.fn();
    prepareFallback = vi.fn();
    selectDelivery = vi.fn();
    markServer = mocks.markServer;
    checkpoint = mocks.checkpoint;
  },
}));
vi.mock('../../infrastructure/repositories/ConversationHistoryRepository.js', () => ({
  ConversationHistoryRepository: class {
    setPendingRequestId = mocks.pendingRequest;
    saveBillingSnapshot = mocks.saveSnapshot;
    recoverStaleStreaming = mocks.recover;
    startTurn = mocks.start;
    startRegeneration = mocks.regenerate;
    getContextBeforeTurn = mocks.context;
    setPromptHistory = mocks.prompt;
    finalizeTurn = mocks.finalize;
    requireTurnById = mocks.find;
    requireTurnState = mocks.find;
  },
}));
vi.mock('../../infrastructure/repositories/OpenRouterChatHistoryRepository.js', () => ({
  OpenRouterChatHistoryRepository: class {
    ensureGenerationId = mocks.ensureGenerationId;
    ensurePlaceholder = mocks.ensurePlaceholder;
  },
}));
vi.mock('../../infrastructure/repositories/CharacterCardRepository.js', () => ({
  CharacterCardRepository: class {
    async requireCard() {
      return { name: 'role', first_mes: 'hello' };
    }
  },
}));
vi.mock('../../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {
    async getGenerationContext() {
      return { config: { selected_model_id: null }, displayName: 'user' };
    }
  },
}));
vi.mock('../engine/index.js', () => ({
  fetchPlatformInstructions: async () => ({ degraded: false, instructions: {} }),
  buildPrompt: () => ({ messages: [], sampling: {} }),
}));
vi.mock('../generation/index.js', () => ({
  execute: mocks.execute,
  resolveModelForUser: async () => ({
    modelId: 'model',
    provider: 'openrouter',
    openRouterModelId: 'model',
    isFree: false,
    tier: 'light',
    entitlement: { active: false, validUntil: null },
  }),
}));
vi.mock('./context-window.js', () => ({
  fetchContextWindowLimits: async () => ({ maxTurns: 50, retainTurns: 30 }),
}));
const { runConversationTurn } = await import('./generate.js');
const { GenerationCleanupPendingError } = await import('../generation/types.js');

const session = { id: 'session', user_id: 'user', character_id: 'character' } as ChatSessionRow;
function input(mode: { kind: 'send'; content: string } | { kind: 'regenerate' }) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    session,
    mode,
    log: { biz: logger, sys: logger } as unknown as RequestLogger,
    sink: {
      opened: false,
      open: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as ConversationStreamSink,
  };
}
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.checkpoint.mockResolvedValue(undefined);
  mocks.pendingRequest.mockResolvedValue(undefined);
  mocks.recover.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({
    historyId: 'reply',
    turnIndex: 1,
    revision: 1,
    userContent: 'original',
  });
  mocks.regenerate.mockResolvedValue({
    historyId: 'reply',
    turnIndex: 1,
    revision: 2,
    userContent: 'original',
  });
  mocks.context.mockResolvedValue({ messages: [], openingMessage: 'hello', truncatedTurns: 0 });
  mocks.prompt.mockResolvedValue(undefined);
  mocks.find.mockResolvedValue({ status: 'streaming', llm_finish_reason: null });
  mocks.finalize.mockResolvedValue({ status: 'upstream_error', llm_finish_reason: null });
  mocks.execute.mockResolvedValue({
    status: 'upstream_error',
    content: '',
    finishReason: null,
    generationId: null,
    chargeId: null,
  });
  mocks.ensureGenerationId.mockResolvedValue(undefined);
  mocks.markServer.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('turn lifecycle recovery', () => {
  it.each([undefined, 'client_committed_v4'] as const)(
    'persists the %s cohort during the existing initial observation write',
    async (firstTokenMeasurement) => {
      await runConversationTurn({
        ...input({ kind: 'send', content: 'original' }),
        firstTokenMeasurement,
      });
      expect(mocks.begin).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ measurementMethod: firstTokenMeasurement })
      );
    }
  );

  it('joins parallel identity writes before cleaning up an early context failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    mocks.begin.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 300)));
    mocks.context.mockRejectedValue(new Error('context unavailable'));
    const pending = runConversationTurn(input({ kind: 'send', content: 'original' }));
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.finalize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(201);
    await expect(pending).rejects.toThrow('context unavailable');
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('overlaps independent context and pricing preparation without dispatching before durable identity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    let snapshotSaved = false;
    let dispatched = false;
    mocks.begin.mockImplementation(async (value) => {
      await pause(300);
      if (value.snapshot) snapshotSaved = true;
    });
    mocks.context.mockImplementation(async () => {
      await pause(600);
      return { messages: [], openingMessage: 'hello', truncatedTurns: 0 };
    });
    mocks.execute.mockImplementation(async (_request, hooks) => {
      // Independent pricing/entitlement reads can start while the prompt is saved.
      expect(snapshotSaved).toBe(false);
      await pause(500);
      await hooks.onBeforeDispatch({ charge_id: 'charge' });
      expect(snapshotSaved).toBe(true);
      dispatched = true;
      return {
        status: 'upstream_error',
        content: '',
        finishReason: null,
        generationId: null,
        chargeId: null,
      };
    });
    const pending = runConversationTurn({
      ...input({ kind: 'send', content: 'original' }),
      requestId: 'request',
    });
    await vi.advanceTimersByTimeAsync(1399);
    expect(dispatched).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(dispatched).toBe(true);
    expect(mocks.begin).toHaveBeenCalledTimes(2);
    expect(mocks.pendingRequest).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.begin.mock.calls[0]?.[0]).toMatchObject({
      history: [],
      chargeId: expect.any(String),
    });
    expect(mocks.begin.mock.calls[1]?.[0]).toMatchObject({
      history: [],
      snapshot: { charge_id: 'charge' },
    });
    // Only the two durable admission stages remain; obsolete prompt/identity writes are gone.
    expect(performance.now()).toBeLessThan(1500);
  });

  it('shares the durable charge key with execute and rejects a different reserve identity', async () => {
    let key: string | undefined;
    mocks.begin.mockImplementation(async (value) => {
      key ??= value.chargeId;
      expect(value.chargeId).toBe(key);
    });
    mocks.execute.mockImplementation(async (request, hooks) => {
      expect(request.plannedChargeId).toBe(key);
      await hooks.onBeforeReserve(request.plannedChargeId);
      await expect(hooks.onBeforeReserve('another-charge')).rejects.toThrow('生成计费身份发生变化');
      await hooks.onBeforeDispatch({ charge_id: request.plannedChargeId });
      return {
        status: 'upstream_error',
        content: '',
        finishReason: null,
        generationId: null,
        chargeId: null,
      };
    });
    await runConversationTurn(input({ kind: 'send', content: 'original' }));
    expect(mocks.begin).toHaveBeenCalledTimes(2);
    expect(mocks.pendingRequest).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('dispatch preparation uses only two durable admission calls instead of five sequential writes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    mocks.begin.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 200)));
    let dispatchedAt = 0;
    mocks.execute.mockImplementation(async (request, hooks) => {
      await hooks.onBeforeReserve(request.plannedChargeId);
      await hooks.onBeforeDispatch({ charge_id: request.plannedChargeId });
      dispatchedAt = performance.now();
      return {
        status: 'upstream_error',
        content: '',
        finishReason: null,
        generationId: null,
        chargeId: null,
      };
    });
    const operation = runConversationTurn({
      ...input({ kind: 'send', content: 'original' }),
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    await vi.advanceTimersByTimeAsync(401);
    await operation;
    expect(dispatchedAt).toBe(400);
    expect(mocks.begin).toHaveBeenCalledTimes(2);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.pendingRequest).not.toHaveBeenCalled();
  });

  it('failed snapshot prevents dispatch even when pricing has already completed', async () => {
    let dispatched = false;
    mocks.begin.mockImplementation(async (value) => {
      if (value.snapshot) throw new Error('snapshot unavailable');
    });
    mocks.execute.mockImplementation(async (_request, hooks) => {
      await hooks.onBeforeDispatch({ charge_id: 'charge' });
      dispatched = true;
    });
    await expect(runConversationTurn(input({ kind: 'send', content: 'original' }))).rejects.toThrow(
      'snapshot unavailable'
    );
    expect(dispatched).toBe(false);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'upstream_error' })
    );
  });

  it('legacy missing flag is off and cannot emit unexpected reasoning', async () => {
    const turnInput = input({ kind: 'send', content: 'original' });
    await runConversationTurn(turnInput);
    const [request, hooks] = mocks.execute.mock.calls[0]!;
    expect(request.thinkingEnabled).toBe(false);
    hooks.onStreamOpen();
    hooks.onReasoningDelta('hidden');
    expect(turnInput.sink.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'start',
        thinking_enabled: false,
        first_token_deadline_ms: 6000,
        requested_model_id: 'model',
        fallback_trigger_ms: 4000,
      })
    );
    expect(turnInput.sink.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reasoning' })
    );
  });

  it('first reasoning at 3s clears the 6s deadline without an extra monitoring DB write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    mocks.execute.mockImplementation(async (request, hooks) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      hooks.onStreamOpen();
      hooks.onReasoningDelta('真实思考');
      await new Promise((resolve) => setTimeout(resolve, 7000));
      request.signal.throwIfAborted();
      hooks.onDelta('正文');
      return {
        status: 'stream_interrupted',
        content: '正文',
        finishReason: 'length',
        generationId: 'gen',
        chargeId: 'charge',
      };
    });
    const turnInput = { ...input({ kind: 'send', content: 'original' }), thinkingEnabled: true };
    const result = runConversationTurn(turnInput);
    await vi.advanceTimersByTimeAsync(3001);
    expect(turnInput.sink.send).toHaveBeenCalledWith({ type: 'reasoning', text: '真实思考' });
    expect(mocks.markServer).not.toHaveBeenCalled();
    expect(mocks.checkpoint).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(7000);
    await expect(result).resolves.toMatchObject({ kind: 'streamed' });
    expect(turnInput.sink.send).toHaveBeenCalledWith({ type: 'delta', text: '正文' });
    expect(mocks.markServer).not.toHaveBeenCalled();
  });

  it.each([
    ['normal', false],
    ['deep-thinking', true],
  ] as const)('enforces the 6s hard limit for silent %s replies', async (_, thinkingEnabled) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    mocks.execute.mockImplementation(async (request, hooks) => {
      hooks.onStreamOpen();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      request.signal.throwIfAborted();
      hooks.onDelta('稍后的正文');
      return {
        status: 'stream_interrupted',
        content: '稍后的正文',
        finishReason: 'length',
        generationId: 'gen',
        chargeId: 'charge',
      };
    });
    const turnInput = { ...input({ kind: 'send', content: 'original' }), thinkingEnabled };
    const result = runConversationTurn(turnInput);
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(6_001);
    await expect(result).rejects.toMatchObject({ stage: 'global' });
    expect(mocks.markServer).toHaveBeenCalledWith('reply', {
      first_token_timeout: true,
      server_timeout_stage: 'global',
    });
    expect(turnInput.sink.send).not.toHaveBeenCalledWith({ type: 'delta', text: '稍后的正文' });
    expect(turnInput.sink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start', assistant_message_id: 'reply' })
    );
  });

  it.each(['send', 'regenerate'] as const)(
    'explicit thinking on for %s emits progress without changing saved content',
    async (kind) => {
      const turnInput = {
        ...input(kind === 'send' ? { kind, content: 'original' } : { kind }),
        thinkingEnabled: true,
      };
      await runConversationTurn(turnInput);
      const [request, hooks] = mocks.execute.mock.calls[0]!;
      expect(request.thinkingEnabled).toBe(true);
      hooks.onStreamOpen();
      hooks.onReasoningDelta('provider progress');
      hooks.onDelta('answer');
      expect(turnInput.sink.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'start',
          thinking_enabled: true,
        })
      );
      expect(turnInput.sink.send).toHaveBeenCalledWith({
        type: 'reasoning',
        text: 'provider progress',
      });
      expect(
        mocks.finalize.mock.calls.every(
          ([value]) => !JSON.stringify(value).includes('provider progress')
        )
      ).toBe(true);
    }
  );

  it.each(['send', 'regenerate'] as const)(
    'explicit off is respected for %s, including unexpected reasoning hooks',
    async (kind) => {
      const turnInput = {
        ...input(kind === 'send' ? { kind, content: 'original' } : { kind }),
        thinkingEnabled: false,
      };
      await runConversationTurn(turnInput);
      const [request, hooks] = mocks.execute.mock.calls[0]!;
      expect(request.thinkingEnabled).toBe(false);
      hooks.onStreamOpen();
      hooks.onReasoningDelta('do not expose');
      expect(turnInput.sink.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'start',
          thinking_enabled: false,
        })
      );
      expect(turnInput.sink.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'reasoning' })
      );
    }
  );

  it('expired route ownership preparation never opens a late turn', async () => {
    await expect(
      runConversationTurn({
        ...input({ kind: 'send', content: 'original' }),
        receivedAt: Date.now() - 10_001,
      })
    ).rejects.toMatchObject({ name: 'FirstTokenDeadlineError', stage: 'global' });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it.each(['send', 'regenerate'] as const)(
    'reclaims stale quota before %s; RPC guard cannot bypass cleanup at the horizon',
    async (kind) => {
      const order: string[] = [];
      mocks.recover.mockImplementation(async () => {
        order.push('recover');
      });
      const start = kind === 'send' ? mocks.start : mocks.regenerate;
      start.mockImplementation(async () => {
        order.push('start');
        return { historyId: 'reply', turnIndex: 1, revision: 1, userContent: 'original' };
      });
      await runConversationTurn(input(kind === 'send' ? { kind, content: 'original' } : { kind }));
      expect(order).toEqual(['recover', 'start']);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ staleAfterSeconds: 86_400 }));
    }
  );

  it.each(['context', 'execute'] as const)(
    'post-start %s failure closes the persisted streaming row',
    async (stage) => {
      mocks[stage].mockRejectedValue(new Error(`${stage} failed`));
      await expect(
        runConversationTurn(input({ kind: 'send', content: 'original' }))
      ).rejects.toThrow(`${stage} failed`);
      expect(mocks.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ historyId: 'reply', status: 'upstream_error' })
      );
    }
  );

  it('quota uncertainty keeps session busy rather than prematurely acknowledging cancellation', async () => {
    mocks.execute.mockRejectedValue(new GenerationCleanupPendingError());
    await expect(runConversationTurn(input({ kind: 'send', content: 'original' }))).rejects.toThrow(
      '生成额度收口待恢复'
    );
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('manual cancellation finalizes its free entitlement before terminal acknowledgement', async () => {
    const order: string[] = [];
    mocks.find.mockResolvedValue({ status: 'streaming', llm_finish_reason: 'user_cancelled' });
    mocks.finalize.mockImplementation(async (value: { status: string }) => {
      if (value.status === 'success') {
        order.push('completion CAS lost');
        return { status: 'streaming', llm_finish_reason: 'user_cancelled' };
      }
      order.push('terminal acknowledgement');
      return { status: 'stream_interrupted', llm_finish_reason: 'user_cancelled' };
    });
    mocks.execute.mockImplementation(
      async (_request, hooks: import('../generation/types.js').GenerationHooks) => {
        const actual = await hooks.onBeforeSettle!(
          {
            completed: true,
            content: 'partial',
            deltaCount: 1,
            finishReason: 'stop',
            generationId: 'gen',
            usage: null,
            responseMetadata: {},
          },
          async () => {
            order.push('quota finalized');
          }
        );
        expect(actual.finishReason).toBe('user_cancelled');
        return {
          status: 'stream_interrupted',
          content: actual.content,
          finishReason: actual.finishReason,
          generationId: 'gen',
          chargeId: 'charge',
        };
      }
    );
    await runConversationTurn(input({ kind: 'send', content: 'original' }));
    expect(order.slice(0, 3)).toEqual([
      'completion CAS lost',
      'quota finalized',
      'terminal acknowledgement',
    ]);
  });

  it.each(['cancelled', 'user_cancelled', 'timeout'])(
    'pre-stream failure preserves the %s marker',
    async (reason) => {
      mocks.find.mockResolvedValue({ status: 'streaming', llm_finish_reason: reason });
      mocks.execute.mockRejectedValue(new Error('cancel before upstream'));
      await expect(
        runConversationTurn(input({ kind: 'send', content: 'original' }))
      ).rejects.toThrow('cancel before upstream');
      expect(mocks.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'stream_interrupted', finishReason: reason })
      );
    }
  );
  it('persists request correlation before prompt reads and passes it only to snapshot storage', async () => {
    const requestId = '11111111-2222-4333-8444-555555555555';
    const order: string[] = [];
    mocks.begin.mockImplementation(async () => {
      order.push('request identity');
    });
    mocks.context.mockImplementation(async () => {
      order.push('prompt context');
      return { messages: [], openingMessage: 'hello', truncatedTurns: 0 };
    });
    await runConversationTurn({ ...input({ kind: 'send', content: 'original' }), requestId });
    expect(order).toEqual(['request identity', 'prompt context']);
    expect(mocks.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        historyId: 'reply',
        requestId,
        history: [],
        chargeId: expect.any(String),
      })
    );
    expect(mocks.pendingRequest).not.toHaveBeenCalled();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.execute.mock.calls[0]?.[0].messages).toEqual([]);
    expect(mocks.execute.mock.calls[0]?.[0]).not.toHaveProperty('request_id');
  });

  it('persists attempt intent before dispatch and leaves provider binding to delivery selection', async () => {
    mocks.execute.mockResolvedValue({
      status: 'stream_interrupted',
      content: 'reply',
      finishReason: 'stop',
      generationId: 'generation-1',
      chargeId: 'charge-1',
    });
    mocks.find.mockResolvedValue({ status: 'stream_interrupted', llm_finish_reason: 'stop' });
    mocks.finalize.mockResolvedValue({ status: 'stream_interrupted', llm_finish_reason: 'stop' });

    await runConversationTurn(input({ kind: 'send', content: 'original' }));

    const hooks = mocks.execute.mock.calls[0]?.[1];
    await hooks.onBeforeDispatch({ provider: 'openrouter' });
    expect(hooks.onGenerationId).toBeUndefined();
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();
    expect(mocks.ensurePlaceholder).not.toHaveBeenCalled();
    expect(mocks.ensureGenerationId).not.toHaveBeenCalled();
    expect(mocks.execute.mock.calls[0]?.[0].firstToken.store.selectDelivery).toBeTypeOf('function');
    expect(mocks.finalize.mock.calls.every(([value]) => !('generationId' in value))).toBe(true);
  });

  it('failed pending-identity storage terminally closes the new turn without generating', async () => {
    mocks.begin.mockRejectedValue(new Error('request identity DB failed'));
    await expect(
      runConversationTurn({
        ...input({ kind: 'send', content: 'original' }),
        requestId: '11111111-2222-4333-8444-555555555555',
      })
    ).rejects.toThrow('request identity DB failed');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ historyId: 'reply', status: 'upstream_error' })
    );
  });
});

it('keeps a selected token alive beyond the 6s deadline when persistence is slow and does not call a closed socket delivered', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  mocks.execute.mockImplementation(async (request, hooks) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    request.firstToken.onReady();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    request.signal.throwIfAborted();
    hooks.onStreamOpen();
    hooks.onDelta('already generated');
    expect(mocks.checkpoint).toHaveBeenCalledWith('reply', 1, 5000, 'delta', 'already generated');
    return {
      status: 'success',
      content: 'already generated',
      finishReason: 'stop',
      generationId: 'g',
      chargeId: 'c',
    };
  });
  const turnInput = input({ kind: 'send', content: 'original' });
  vi.mocked(turnInput.sink.send).mockReturnValue(false);
  const result = runConversationTurn(turnInput);
  await vi.advanceTimersByTimeAsync(7501);
  await expect(result).resolves.toMatchObject({ kind: 'streamed' });
  expect(mocks.markServer).not.toHaveBeenCalled();
});
