import { describe, expect, it, vi } from 'vitest';

import { REPLAY_IDLE_TIMEOUT_MS } from '@miniapp/shared';

import type { PostHogAdapter } from './adapter';
import { createReplayLifecycle } from './lifecycle';

const characterId = '22222222-2222-4222-8222-222222222222';
const conversationSessionId = '33333333-3333-4333-8333-333333333333';
const replayContextId = '11111111-1111-4111-8111-111111111111';

function createMockAdapter(): PostHogAdapter & { captures: unknown[] } {
  const captures: unknown[] = [];
  const adapter = {
    init: vi.fn(async () => true),
    isReady: vi.fn(() => true),
    getDistinctId: vi.fn(() => '123456789'),
    identify: vi.fn(),
    setPersonProperties: vi.fn(),
    registerSessionProperties: vi.fn(),
    startNewRecording: vi.fn(() => true),
    stopRecording: vi.fn(),
    capture: vi.fn((event: unknown) => {
      captures.push(event);
      return true;
    }),
    reportHealth: vi.fn(),
    captures,
  };
  return adapter as PostHogAdapter & { captures: unknown[] };
}

describe('replay lifecycle owner', () => {
  it('is idle until chat replay starts and does not auto-record', () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    expect(api.getState()).toBe('idle');
    expect(adapter.startNewRecording).not.toHaveBeenCalled();
  });

  it('starts a new recording once for duplicate chat starts', async () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    const first = await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: 'gpt-4o',
    });
    const second = await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: 'gpt-4o',
    });
    expect(first).toBe(replayContextId);
    expect(second).toBe(replayContextId);
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);
    expect(api.getState()).toBe('chat');
  });

  it('keeps context across paywall follow-up and pauses idle during external payment', async () => {
    const adapter = createMockAdapter();
    const timeouts: Array<() => void> = [];
    const api = createReplayLifecycle({
      adapter,
      createContextId: () => replayContextId,
      setTimeoutFn: (fn) => {
        timeouts.push(fn);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: vi.fn(),
    });
    await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    await api.enterPaywallFollowup();
    expect(api.getState()).toBe('paywall_followup');
    expect(adapter.stopRecording).not.toHaveBeenCalled();

    await api.enterExternalPaymentPending();
    expect(api.getState()).toBe('external_payment_pending');
    for (const fn of timeouts) fn();
    await Promise.resolve();
    expect(api.getState()).toBe('external_payment_pending');
  });

  it('ends chat on idle timeout and pagehide, but not while streaming', async () => {
    vi.useFakeTimers();
    const adapter = createMockAdapter();
    const windowListeners = new Map<string, EventListener>();
    const api = createReplayLifecycle({
      adapter,
      createContextId: () => replayContextId,
      addWindowListener: (type, listener) => {
        windowListeners.set(type, listener);
      },
      removeWindowListener: (type) => {
        windowListeners.delete(type);
      },
    });
    api.attachWindowListeners();
    await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    api.setStreaming(true);
    vi.advanceTimersByTime(REPLAY_IDLE_TIMEOUT_MS);
    expect(api.getState()).toBe('chat');

    api.setStreaming(false);
    vi.advanceTimersByTime(REPLAY_IDLE_TIMEOUT_MS);
    await vi.runAllTimersAsync();
    expect(api.getState()).toBe('ended');

    await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    windowListeners.get('pagehide')?.(new Event('pagehide'));
    await vi.runAllTimersAsync();
    expect(api.getState()).toBe('ended');
    vi.useRealTimers();
  });
});
