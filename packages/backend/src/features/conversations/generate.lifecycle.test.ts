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
}));
vi.mock('../../infrastructure/repositories/GenerationObservationRepository.js', () => ({
  GenerationObservationRepository: class {
    begin = vi.fn();
    observe = vi.fn();
    prepareFallback = vi.fn();
    selectDelivery = vi.fn();
    markServer = mocks.markServer;
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
    async getGenerationConfig() {
      return {};
    }
    async getDisplayName() {
      return 'user';
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
  it('legacy missing flag is off and cannot emit unexpected reasoning', async () => {
    const turnInput = input({ kind: 'send', content: 'original' });
    await runConversationTurn(turnInput);
    const [request, hooks] = mocks.execute.mock.calls[0]!;
    expect(request.thinkingEnabled).toBe(false);
    hooks.onStreamOpen();
    hooks.onReasoningDelta('hidden');
    expect(turnInput.sink.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start', thinking_enabled: false })
    );
    expect(turnInput.sink.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reasoning' })
    );
  });

  it('first reasoning at 3s clears the 6s server deadline and emits the existing metric only once', async () => {
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
    expect(mocks.markServer).toHaveBeenCalledExactlyOnceWith('reply', {
      first_token_emitted_ms: 3000,
    });
    await vi.advanceTimersByTimeAsync(7000);
    await expect(result).resolves.toMatchObject({ kind: 'streamed' });
    expect(turnInput.sink.send).toHaveBeenCalledWith({ type: 'delta', text: '正文' });
    expect(mocks.markServer).toHaveBeenCalledTimes(1);
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
        receivedAt: Date.now() - 20_001,
      })
    ).rejects.toMatchObject({ name: 'FirstTokenDeadlineError' });
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

  it.each(['context', 'prompt', 'execute'] as const)(
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

  it('pre-stream failure preserves the cancellation marker', async () => {
    mocks.find.mockResolvedValue({ status: 'streaming', llm_finish_reason: 'cancelled' });
    mocks.execute.mockRejectedValue(new Error('cancel before upstream'));
    await expect(runConversationTurn(input({ kind: 'send', content: 'original' }))).rejects.toThrow(
      'cancel before upstream'
    );
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'stream_interrupted', finishReason: 'cancelled' })
    );
  });
  it('persists request correlation before prompt reads and passes it only to snapshot storage', async () => {
    const requestId = '11111111-2222-4333-8444-555555555555';
    const order: string[] = [];
    mocks.pendingRequest.mockImplementation(async () => {
      order.push('request identity');
    });
    mocks.context.mockImplementation(async () => {
      order.push('prompt context');
      return { messages: [], openingMessage: 'hello', truncatedTurns: 0 };
    });
    await runConversationTurn({ ...input({ kind: 'send', content: 'original' }), requestId });
    expect(order).toEqual(['request identity', 'prompt context']);
    expect(mocks.pendingRequest).toHaveBeenCalledWith('reply', requestId);
    expect(mocks.prompt).toHaveBeenCalledWith('reply', [], requestId);
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
    mocks.pendingRequest.mockRejectedValue(new Error('request identity DB failed'));
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
