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
  getActiveBootSessionId: () => 'boot-test',
}));

function createSessionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('business navigation telemetry', () => {
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

  it('uses one transaction for character timing and first-chat specialization', async () => {
    const telemetry = await import('./business-navigation-telemetry');
    const attemptId = telemetry.beginCharacterNavigation('character-1', 'gallery', {
      pageFrom: '首页',
      navigationType: 'push',
      bridgePhase: 'connecting',
    });

    expect(telemetry.mountCharacterNavigation('character-1', 'interactive')).toBe(attemptId);
    telemetry.recordCharacterGateOpen(attemptId, 'interactive');
    await telemetry.traceBusinessNavigationOperation(
      attemptId,
      'bridge.select_character',
      'bridge.action',
      async () => ({ selected: true })
    );
    telemetry.completeBusinessNavigationData(attemptId);
    telemetry.completeBusinessNavigation(attemptId);

    const roots = sentry.spans.filter((span) => span.options.name === 'business.character_open');
    expect(roots).toHaveLength(1);
    expect(sentry.spans.some((span) => span.options.name === 'tavern.first_chat_open')).toBe(false);
    expect(roots[0]?.attributes).toEqual(
      expect.objectContaining({
        is_first_chat: true,
        boot_session_id: 'boot-test',
        'business.action': '点击角色',
        'page.from': '首页',
        'page.to': '角色页',
        result: 'success',
      })
    );
    expect(sessionStorage.getItem('miniapp:first-chat-completed')).toBe('1');
    expect(sendSentryLog).toHaveBeenCalledWith(
      'info',
      'tavern.first_chat.completed',
      expect.objectContaining({ result: 'success', characterId: 'character-1' })
    );
  });

  it('keeps a retryable failure in the same journey until retry succeeds', async () => {
    const telemetry = await import('./business-navigation-telemetry');
    const attemptId = telemetry.beginCharacterNavigation('character-2', 'history', {
      pageFrom: '会话列表',
      navigationType: 'link',
      bridgePhase: 'ready',
    });
    const root = sentry.spans.find((span) => span.options.name === 'business.character_open');

    telemetry.recordBusinessNavigationRetryableFailure(
      attemptId,
      'select_error',
      new Error('select failed')
    );
    expect(root?.ended).toBe(false);
    expect(root?.attributes.retry_pending).toBe(true);

    telemetry.recordBusinessNavigationRetry(attemptId);
    await telemetry.traceBusinessNavigationOperation(
      attemptId,
      'bridge.select_character',
      'bridge.action',
      async () => ({ selected: true })
    );
    telemetry.completeBusinessNavigationData(attemptId);
    telemetry.completeBusinessNavigation(attemptId);

    expect(root?.ended).toBe(true);
    expect(root?.attributes.result).toBe('success');
    expect(root?.attributes.retry_count).toBe(1);
    expect(root?.attributes.retryable_error_count).toBe(1);
    expect(sentry.captureException).toHaveBeenCalledOnce();
  });

  it('does not classify later character opens as first chat', async () => {
    sessionStorage.setItem('miniapp:first-chat-completed', '1');
    const telemetry = await import('./business-navigation-telemetry');
    const attemptId = telemetry.beginCharacterNavigation('character-3', 'favorites', {
      pageFrom: '会话列表',
      navigationType: 'link',
      bridgePhase: 'ready',
    });
    telemetry.completeBusinessNavigationData(attemptId);
    telemetry.completeBusinessNavigation(attemptId);

    const root = sentry.spans.find((span) => span.options.name === 'business.character_open');
    expect(root?.attributes.is_first_chat).toBeUndefined();
    expect(sendSentryLog).not.toHaveBeenCalled();
  });

  it('marks the hard timeout as deadline_exceeded', async () => {
    let timeoutCallback: (() => void) | undefined;
    vi.stubGlobal('window', {
      setTimeout: vi.fn((callback: () => void) => {
        timeoutCallback = callback;
        return 1;
      }),
      clearTimeout: vi.fn(),
    });
    const telemetry = await import('./business-navigation-telemetry');
    telemetry.beginChatListNavigation('首页');

    timeoutCallback?.();

    const root = sentry.spans.find((span) => span.options.name === 'business.chat_list_open');
    expect(root?.ended).toBe(true);
    expect(root?.attributes.result).toBe('deadline_exceeded');
  });
});
