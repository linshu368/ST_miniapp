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
    MockSpan,
  };
});

vi.mock('@sentry/nextjs', () => ({
  getClient: () => ({}),
  startInactiveSpan: (options: { name: string; attributes?: Record<string, unknown> }) => {
    const span = new sentry.MockSpan(options);
    sentry.spans.push(span);
    return span;
  },
  withActiveSpan: (_span: unknown, callback: () => unknown) => callback(),
}));

describe('business navigation telemetry', () => {
  beforeEach(() => {
    vi.resetModules();
    sentry.spans.length = 0;
    vi.stubGlobal('window', {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
  });

  it('records the three required phases for a successful character open', async () => {
    const telemetry = await import('./business-navigation-telemetry');
    const attemptId = telemetry.beginBusinessNavigation('character_open', {
      pageFrom: '首页',
      navigationType: 'push',
      attributes: { character_id: 'character-1' },
    });

    telemetry.markBusinessNavigationStarted(attemptId);
    expect(telemetry.mountBusinessNavigation('character_open')).toBe(attemptId);
    await telemetry.traceBusinessNavigationOperation(
      attemptId,
      'bridge.select_character',
      'bridge.action',
      async () => ({ selected: true })
    );
    telemetry.completeBusinessNavigationData(attemptId);
    telemetry.completeBusinessNavigation(attemptId);

    const root = sentry.spans.find((span) => span.options.name === 'business.character_open');
    expect(root?.ended).toBe(true);
    expect(root?.attributes).toEqual(
      expect.objectContaining({
        'business.action': '点击角色',
        'page.from': '首页',
        'page.to': '角色页',
        result: 'success',
      })
    );
    expect(
      sentry.spans
        .filter((span) =>
          ['click_to_navigation', 'navigation_to_data', 'data_to_ui_ready'].includes(
            span.options.name
          )
        )
        .map((span) => span.options.name)
    ).toEqual(['click_to_navigation', 'navigation_to_data', 'data_to_ui_ready']);
    expect(
      sentry.spans.find((span) => span.options.name === 'bridge.select_character')?.attributes
        .result
    ).toBe('success');
  });

  it('separates a replaced navigation from successful samples', async () => {
    const telemetry = await import('./business-navigation-telemetry');
    telemetry.beginBusinessNavigation('chat_list_open', {
      pageFrom: '首页',
      navigationType: 'link',
    });
    telemetry.beginBusinessNavigation('character_open', {
      pageFrom: '会话列表',
      navigationType: 'link',
    });

    const chatListRoot = sentry.spans.find(
      (span) => span.options.name === 'business.chat_list_open'
    );
    expect(chatListRoot?.ended).toBe(true);
    expect(chatListRoot?.attributes.result).toBe('cancelled');
    expect(chatListRoot?.attributes.reason).toBe('replaced_by_navigation');
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
    telemetry.beginBusinessNavigation('chat_list_open', {
      pageFrom: '首页',
      navigationType: 'link',
    });

    timeoutCallback?.();

    const root = sentry.spans.find((span) => span.options.name === 'business.chat_list_open');
    expect(root?.ended).toBe(true);
    expect(root?.attributes.result).toBe('deadline_exceeded');
  });
});
