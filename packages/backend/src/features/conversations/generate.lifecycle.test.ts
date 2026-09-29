import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}));
vi.mock('../../infrastructure/repositories/ConversationHistoryRepository.js', () => ({
  ConversationHistoryRepository: class {
    setPendingRequestId = mocks.pendingRequest;
    recoverStaleStreaming = mocks.recover;
    startTurn = mocks.start;
    startRegeneration = mocks.regenerate;
    getContextBeforeTurn = mocks.context;
    setPromptHistory = mocks.prompt;
    finalizeTurn = mocks.finalize;
    requireTurnById = mocks.find;
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
});

describe('turn lifecycle recovery', () => {
  it('expired route ownership preparation never opens a late turn', async () => {
    await expect(
      runConversationTurn({
        ...input({ kind: 'send', content: 'original' }),
        receivedAt: Date.now() - 20_001,
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' });
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
