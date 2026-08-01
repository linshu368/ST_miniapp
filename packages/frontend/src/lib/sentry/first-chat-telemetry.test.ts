import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => {
  class MockSpan {
    attributes: Record<string, unknown>;
    ended = false;

    constructor(
      readonly options: {
        name: string;
        attributes?: Record<string, unknown>;
      }
    ) {
      this.attributes = { ...(options.attributes ?? {}) };
    }

    setAttribute(name: string, value: unknown) {
      this.attributes[name] = value;
    }

    end() {
      this.ended = true;
    }
  }

  return {
    spans: [] as MockSpan[],
    captureException: vi.fn(),
    MockSpan,
  };
});

const sendSentryLog = vi.hoisted(() => vi.fn());

vi.mock('@sentry/nextjs', () => ({
  getClient: () => ({}),
  startInactiveSpan: (options: { name: string; attributes?: Record<string, unknown> }) => {
    const span = new sentry.MockSpan(options);
    sentry.spans.push(span);
    return span;
  },
  withActiveSpan: (_span: unknown, callback: () => unknown) => callback(),
  withScope: (callback: (scope: Record<string, unknown>) => void) =>
    callback({
      setTag: vi.fn(),
      setContext: vi.fn(),
    }),
  captureException: sentry.captureException,
}));

vi.mock('./client', () => ({
  sendSentryLog,
}));

vi.mock('@/lib/bridge/boot-session', () => ({
  getActiveBootSessionId: () => 'boot_test',
}));

function createSessionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('first chat telemetry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sentry.spans.length = 0;
    vi.stubGlobal('sessionStorage', createSessionStorage());
    vi.stubGlobal('window', {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
  });

  it('records a successful first-chat span tree and marks the session complete', async () => {
    const telemetry = await import('./first-chat-telemetry');
    const attemptId = telemetry.beginFirstChatNavigation('character-1', 'gallery', {
      bridgePhase: 'connecting',
      bootElapsedMs: 1200,
    });
    expect(attemptId).toBeTruthy();

    telemetry.mountFirstChatAttempt('character-1', 'connecting', 1300);
    telemetry.recordFirstChatGateOpen(attemptId, 'interactive');
    await telemetry.traceFirstChatOperation(
      attemptId,
      'ensure',
      'api.ensure_character_wait',
      'http.client',
      async () => ({ status: 'written' })
    );
    telemetry.finishFirstChatPrepare(attemptId);
    await telemetry.traceFirstChatOperation(
      attemptId,
      'select',
      'bridge.select_character',
      'bridge.action',
      async () => ({})
    );
    telemetry.startFirstChatRender(attemptId);
    telemetry.completeFirstChatAfterPaint(attemptId);

    const root = sentry.spans.find((span) => span.options.name === 'tavern.first_chat_open');
    expect(root?.ended).toBe(true);
    expect(root?.attributes.result).toBe('success');
    expect(root?.attributes.boot_session_id).toBe('boot_test');
    expect(sessionStorage.getItem('miniapp:first-chat-completed')).toBe('1');
    expect(sendSentryLog).toHaveBeenCalledWith(
      'info',
      'tavern.first_chat.completed',
      expect.objectContaining({ result: 'success', characterId: 'character-1' })
    );
  });

  it('keeps a recovered ensure failure as degraded success', async () => {
    const telemetry = await import('./first-chat-telemetry');
    const attemptId = telemetry.beginFirstChatNavigation('character-2', 'direct');
    telemetry.mountFirstChatAttempt('character-2', 'ready');
    telemetry.recordFirstChatGateOpen(attemptId, 'ready');
    telemetry.markFirstChatDegraded(attemptId, 'ensure_failed');
    telemetry.startFirstChatRender(attemptId);
    telemetry.completeFirstChatAfterPaint(attemptId);

    const root = sentry.spans.find((span) => span.options.name === 'tavern.first_chat_open');
    expect(root?.attributes.result).toBe('degraded');
    expect(sendSentryLog).toHaveBeenCalledWith(
      'warn',
      'tavern.first_chat.completed',
      expect.objectContaining({ result: 'degraded' })
    );
  });

  it('records a stall without ending the transaction prematurely', async () => {
    const telemetry = await import('./first-chat-telemetry');
    const attemptId = telemetry.beginFirstChatNavigation('character-3', 'history');
    telemetry.mountFirstChatAttempt('character-3', 'connecting');
    telemetry.recordFirstChatStall(attemptId, 'gate', 'connecting');

    const root = sentry.spans.find((span) => span.options.name === 'tavern.first_chat_open');
    expect(root?.ended).toBe(false);
    expect(root?.attributes.stall_observed).toBe(true);

    telemetry.failFirstChatAttempt(attemptId, 'bridge_disconnected', new Error('disconnected'));
    expect(root?.ended).toBe(true);
    expect(root?.attributes.result).toBe('failed');
    expect(sentry.captureException).toHaveBeenCalledOnce();
  });
});
