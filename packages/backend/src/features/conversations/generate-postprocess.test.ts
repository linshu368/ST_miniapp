import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSessionRow } from '../../infrastructure/repositories/ChatSessionRepository.js';
import type { RequestLogger } from '../../lib/logger.js';
import { ConversationRepositoryError } from '../../infrastructure/repositories/conversation-errors.js';
import type { ConversationStreamSink } from './sse.js';

const mocks = vi.hoisted(() => ({
  startTurn: vi.fn(),
  startRegeneration: vi.fn(),
  recoverStaleStreaming: vi.fn(),
  getContextBeforeTurn: vi.fn(),
  setPromptHistory: vi.fn(),
  finalizeTurn: vi.fn(),
  requireTurnById: vi.fn(),
  readVersion: vi.fn(),
  execute: vi.fn(),
  buildPrompt: vi.fn(),
  fetchInstructions: vi.fn(),
  resolveModel: vi.fn(),
  requireCard: vi.fn(),
  getGenerationConfig: vi.fn(),
  getDisplayName: vi.fn(),
  fetchWindow: vi.fn(),
}));

vi.mock('../../infrastructure/repositories/ConversationHistoryRepository.js', () => ({
  ConversationHistoryRepository: class {
    startTurn = mocks.startTurn;
    startRegeneration = mocks.startRegeneration;
    recoverStaleStreaming = mocks.recoverStaleStreaming;
    getContextBeforeTurn = mocks.getContextBeforeTurn;
    setPromptHistory = mocks.setPromptHistory;
    finalizeTurn = mocks.finalizeTurn;
    requireTurnById = mocks.requireTurnById;
  },
}));

vi.mock('../../infrastructure/repositories/CharacterCardRepository.js', () => ({
  CharacterCardRepository: class {
    requireCard = mocks.requireCard;
  },
}));

vi.mock('../../infrastructure/repositories/MiniappUserSettingsRepository.js', () => ({
  MiniappUserSettingsRepository: class {
    getGenerationConfig = mocks.getGenerationConfig;
    getDisplayName = mocks.getDisplayName;
  },
}));

vi.mock('../generation/index.js', () => ({
  execute: mocks.execute,
  resolveModelForUser: mocks.resolveModel,
}));

vi.mock('../engine/index.js', () => ({
  buildPrompt: mocks.buildPrompt,
  fetchPlatformInstructions: mocks.fetchInstructions,
}));

vi.mock('../text-postprocess/config.js', () => ({
  readCurrentPostprocessVersion: mocks.readVersion,
}));

vi.mock('./context-window.js', () => ({
  fetchContextWindowLimits: mocks.fetchWindow,
}));

import { runConversationTurn } from './generate.js';

const SESSION = {
  id: 'session',
  user_id: 'user',
  character_id: 'character',
  title: null,
  last_message_at: null,
  last_message_preview: null,
  message_count: 0,
  pinned_at: null,
  context_window_start_turn: 1,
  deleted_at: null,
  created_at: '2026-09-28T00:00:00.000Z',
  updated_at: '2026-09-28T00:00:00.000Z',
} as ChatSessionRow;

function sink(): ConversationStreamSink & { events: unknown[] } {
  const events: unknown[] = [];
  let opened = false;
  return {
    events,
    get opened() {
      return opened;
    },
    clientGone: false,
    open() {
      opened = true;
    },
    send(event) {
      events.push(event);
    },
    close() {
      return undefined;
    },
  };
}

describe('runConversationTurn postprocess binding', () => {
  beforeEach(() => {
    mocks.startTurn.mockReset();
    mocks.startRegeneration.mockReset();
    mocks.recoverStaleStreaming.mockReset();
    mocks.getContextBeforeTurn.mockReset();
    mocks.setPromptHistory.mockReset();
    mocks.finalizeTurn.mockReset();
    mocks.requireTurnById.mockReset();
    mocks.readVersion.mockReset();
    mocks.execute.mockReset();
    mocks.buildPrompt.mockReset();
    mocks.requireCard.mockResolvedValue({
      name: '角色',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '开场白',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
    });
    mocks.getGenerationConfig.mockResolvedValue({});
    mocks.getDisplayName.mockResolvedValue('Alice');
    mocks.fetchInstructions.mockResolvedValue({ instructions: {}, degraded: false });
    mocks.fetchWindow.mockResolvedValue({ maxTurns: 75, retainTurns: 50 });
    mocks.resolveModel.mockResolvedValue({ openRouterModelId: 'model-a' });
    mocks.getContextBeforeTurn.mockResolvedValue({
      openingMessage: '开场白',
      messages: [
        { role: 'user', content: 'previous-user' },
        { role: 'assistant', content: 'previous-assistant-raw' },
      ],
      truncatedTurns: 0,
    });
    mocks.buildPrompt.mockImplementation(
      (input: { userInput: string; history: Array<{ role: string; content: string }> }) => ({
        messages: [...input.history, { role: 'user', content: input.userInput }],
        sampling: {},
      })
    );
    mocks.execute.mockImplementation(
      async (
        request: { userInput: string; messages: unknown[] },
        hooks: { onStreamOpen: () => void; onDelta: (text: string) => void }
      ) => {
        hooks.onStreamOpen();
        hooks.onDelta('model-delta');
        return {
          status: 'success',
          content: 'model-raw-reply',
          generationId: null,
          finishReason: 'stop',
          chargeId: null,
          modelId: null,
          modelOpenRouterId: 'model-a',
        };
      }
    );
    mocks.finalizeTurn.mockResolvedValue({ status: 'success', llm_finish_reason: 'stop' });
    mocks.requireTurnById.mockResolvedValue({ llm_finish_reason: null });
    mocks.setPromptHistory.mockResolvedValue(undefined);
    mocks.recoverStaleStreaming.mockResolvedValue(undefined);
  });

  it('binds the wrapper result into SSE start and keeps the raw prompt input', async () => {
    mocks.readVersion.mockResolvedValue(4);
    mocks.startTurn.mockResolvedValue({
      turnIndex: 2,
      historyId: 'history',
      revision: 1,
      userContent: 'raw-user',
      contextWindowStartTurn: 1,
      postprocessVersion: 4,
    });
    const events = sink();
    await runConversationTurn({
      session: SESSION,
      mode: { kind: 'send', content: 'raw-user' },
      sink: events,
      log: { sys: { error() {} }, biz: { info() {} } } as unknown as RequestLogger,
    });
    expect(mocks.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userContent: 'raw-user',
        postprocessVersion: 4,
        maxContextTurns: 75,
        retainContextTurns: 50,
      })
    );
    expect(mocks.startRegeneration).not.toHaveBeenCalled();
    expect(events.events[0]).toMatchObject({ type: 'start', postprocess_version: 4 });
    expect(mocks.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        userInput: 'raw-user',
        history: [
          { role: 'assistant', content: '开场白' },
          { role: 'user', content: 'previous-user' },
          { role: 'assistant', content: 'previous-assistant-raw' },
        ],
      })
    );
    expect(mocks.execute.mock.calls[0]?.[0]).toMatchObject({ userInput: 'raw-user' });
    expect(mocks.finalizeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'model-raw-reply' })
    );
    expect(JSON.stringify(mocks.setPromptHistory.mock.calls)).not.toContain('SECRET_TEMPLATE');
  });

  it('still starts a turn when the published version is null', async () => {
    mocks.readVersion.mockResolvedValue(null);
    mocks.startTurn.mockResolvedValue({
      turnIndex: 1,
      historyId: 'history',
      revision: 0,
      userContent: 'raw-user',
      contextWindowStartTurn: 1,
      postprocessVersion: null,
    });
    const events = sink();
    await runConversationTurn({
      session: SESSION,
      mode: { kind: 'send', content: 'raw-user' },
      sink: events,
      log: { sys: { error() {} }, biz: { info() {} } } as unknown as RequestLogger,
    });
    expect(mocks.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ postprocessVersion: null })
    );
    expect(events.events[0]).toMatchObject({ type: 'start', postprocess_version: null });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('uses the regeneration wrapper and does not bypass session_busy', async () => {
    mocks.readVersion.mockResolvedValue(4);
    mocks.startRegeneration.mockResolvedValue({
      turnIndex: 2,
      historyId: 'history',
      revision: 2,
      userContent: 'stored-user',
      contextWindowStartTurn: 1,
      postprocessVersion: 4,
    });
    await runConversationTurn({
      session: SESSION,
      mode: { kind: 'regenerate' },
      sink: sink(),
      log: { sys: { error() {} }, biz: { info() {} } } as unknown as RequestLogger,
    });
    expect(mocks.startRegeneration).toHaveBeenCalledWith(
      expect.objectContaining({ postprocessVersion: 4 })
    );
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(mocks.buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ userInput: 'stored-user' })
    );

    mocks.startRegeneration.mockRejectedValueOnce(
      new ConversationRepositoryError('session_busy', 'busy')
    );
    await expect(
      runConversationTurn({
        session: SESSION,
        mode: { kind: 'regenerate' },
        sink: sink(),
        log: { sys: { error() {} }, biz: { info() {} } } as unknown as RequestLogger,
      })
    ).rejects.toMatchObject({ code: 'session_busy' });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
