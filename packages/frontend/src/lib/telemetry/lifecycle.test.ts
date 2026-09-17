import { describe, expect, it, vi, type Mocked } from 'vitest';

import { REPLAY_IDLE_TIMEOUT_MS } from '@miniapp/shared';

import type { PostHogAdapter } from './adapter';
import { createReplayLifecycle } from './lifecycle';

const characterId = '22222222-2222-4222-8222-222222222222';
const conversationSessionId = '33333333-3333-4333-8333-333333333333';
const replayContextId = '11111111-1111-4111-8111-111111111111';

function createMockAdapter(): Mocked<PostHogAdapter> & { captures: unknown[] } {
  const captures: unknown[] = [];
  let recording = false;
  const adapter = {
    init: vi.fn(async () => true),
    isReady: vi.fn(() => true),
    whenReady: vi.fn(async () => true),
    isRecording: vi.fn(() => recording),
    getDistinctId: vi.fn(() => '123456789'),
    identify: vi.fn(),
    setPersonProperties: vi.fn(),
    registerSessionProperties: vi.fn(),
    clearReplaySessionProperties: vi.fn(),
    startNewRecording: vi.fn(() => {
      recording = true;
      return true;
    }),
    resumeRecording: vi.fn(() => {
      recording = true;
      return true;
    }),
    stopRecording: vi.fn(() => {
      recording = false;
    }),
    capture: vi.fn((event: unknown) => {
      captures.push(event);
      return true;
    }),
    reportHealth: vi.fn(),
    captures,
  };
  return adapter as Mocked<PostHogAdapter> & { captures: unknown[] };
}

describe('replay lifecycle owner', () => {
  it('starts direct recharge recording before releasing the clicked event, without chat identity', async () => {
    const adapter = createMockAdapter();
    let resolveReady: ((ready: boolean) => void) | undefined;
    adapter.whenReady.mockReturnValue(
      new Promise((resolve) => {
        resolveReady = resolve;
      })
    );
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });

    expect(api.startRechargeReplay('123456789')).toBe(replayContextId);
    expect(api.getState()).toBe('recharge');
    expect(api.capture({ event: 'recharge_entry_clicked', entry_source: 'profile_balance' })).toBe(
      true
    );
    expect(api.capture({ event: 'recharge_viewed' })).toBe(true);
    expect(adapter.capture).not.toHaveBeenCalled();

    resolveReady?.(true);
    await vi.waitFor(() => expect(adapter.capture).toHaveBeenCalledTimes(2));
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);
    expect(adapter.startNewRecording.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.capture.mock.invocationCallOrder[0] ?? 0
    );
    expect(adapter.registerSessionProperties).toHaveBeenCalledWith({
      replay_context_id: replayContextId,
    });
    expect(adapter.captures).toEqual([
      expect.objectContaining({
        event: 'recharge_entry_clicked',
        replay_context_id: replayContextId,
        telegram_user_id: '123456789',
      }),
      expect.objectContaining({
        event: 'recharge_viewed',
        replay_context_id: replayContextId,
        telegram_user_id: '123456789',
      }),
    ]);
    expect(adapter.captures).not.toContainEqual(
      expect.objectContaining({ event: 'replay_chat_started' })
    );
  });

  it('stops before external payment and resumes without starting a new session', async () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    api.startRechargeReplay('123456789');
    await vi.waitFor(() => expect(adapter.startNewRecording).toHaveBeenCalledTimes(1));
    await api.enterExternalPaymentPending();
    expect(api.getState()).toBe('external_payment_pending');
    expect(adapter.stopRecording).toHaveBeenCalledTimes(1);
    api.refreshTelemetryReady();
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);
    api.resumePaymentReplay();
    expect(api.getState()).toBe('recharge');
    expect(adapter.resumeRecording).toHaveBeenCalledTimes(1);
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);
    expect(api.getSnapshot().replayContextId).toBe(replayContextId);
  });

  it('drops queued recharge events if the user leaves before the SDK is ready', async () => {
    const adapter = createMockAdapter();
    let resolveReady: ((ready: boolean) => void) | undefined;
    adapter.whenReady.mockReturnValue(
      new Promise((resolve) => {
        resolveReady = resolve;
      })
    );
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    api.startRechargeReplay('123456789');
    api.capture({ event: 'recharge_entry_clicked', entry_source: 'profile_balance' });
    const ending = api.endReplay('route_change');
    resolveReady?.(true);
    await ending;
    expect(api.getState()).toBe('ended');
    expect(adapter.startNewRecording).not.toHaveBeenCalled();
    expect(adapter.capture).not.toHaveBeenCalled();
  });

  it('does not start a new recording in the payment gateway when SDK readiness arrives late', async () => {
    const adapter = createMockAdapter();
    let resolveReady: ((ready: boolean) => void) | undefined;
    adapter.whenReady.mockReturnValue(
      new Promise((resolve) => {
        resolveReady = resolve;
      })
    );
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    api.startRechargeReplay('123456789');
    api.capture({ event: 'recharge_entry_clicked', entry_source: 'profile_balance' });
    await api.enterExternalPaymentPending();
    resolveReady?.(true);
    await vi.waitFor(() => expect(adapter.capture).toHaveBeenCalledTimes(1));
    expect(adapter.startNewRecording).not.toHaveBeenCalled();
    api.resumePaymentReplay();
    expect(adapter.resumeRecording).toHaveBeenCalledTimes(1);
    expect(adapter.startNewRecording).not.toHaveBeenCalled();
  });

  it('restores a persisted payment context without inventing chat fields', () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter });
    api.restorePaymentReplay(replayContextId, '123456789');
    expect(api.getState()).toBe('external_payment_pending');
    expect(adapter.startNewRecording).not.toHaveBeenCalled();
    api.resumePaymentReplay();
    expect(adapter.resumeRecording).toHaveBeenCalledWith(replayContextId);
    expect(adapter.registerSessionProperties).toHaveBeenCalledWith({
      replay_context_id: replayContextId,
    });
    expect(adapter.capture).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'replay_chat_started' })
    );
  });

  it('starts a normal chat after leaving an external standalone recharge', async () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    api.startRechargeReplay('123456789');
    await vi.waitFor(() => expect(adapter.startNewRecording).toHaveBeenCalledTimes(1));
    await api.enterExternalPaymentPending();
    api.reenterChatFromFollowup();
    expect(api.getState()).toBe('external_payment_pending');
    await api.startChatReplay({ characterId, conversationSessionId, selectedModelId: null });
    expect(api.getState()).toBe('chat');
  });

  it('keeps a chat context if the user clicks the profile recharge entry during chat', async () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    await api.startChatReplay({ characterId, conversationSessionId, selectedModelId: null });
    expect(api.startRechargeReplay('123456789')).toBe(replayContextId);
    expect(api.getState()).toBe('chat');
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);
    api.capture({ event: 'recharge_entry_clicked', entry_source: 'profile_balance' });
    expect(adapter.captures.at(-1)).toMatchObject({
      event: 'recharge_entry_clicked',
      replay_context_id: replayContextId,
    });
    expect(adapter.captures.at(-1)).not.toHaveProperty('character_id');
  });

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

  it('retries start after SDK init if chat already has a context', async () => {
    const adapter = createMockAdapter();
    adapter.isReady.mockReturnValue(false);
    adapter.whenReady.mockResolvedValue(false);
    adapter.getDistinctId.mockReturnValue(undefined);
    adapter.startNewRecording.mockImplementation(() => false);
    adapter.isRecording.mockReturnValue(false);
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: 'gpt-4o',
    });
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);

    adapter.isReady.mockReturnValue(true);
    adapter.getDistinctId.mockReturnValue('123456789');
    api.refreshTelemetryReady();
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(2);
    expect(api.getSnapshot().telemetryReady).toBe(true);
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
    expect(adapter.clearReplaySessionProperties).not.toHaveBeenCalled();

    await api.enterExternalPaymentPending();
    expect(api.getState()).toBe('external_payment_pending');
    expect(adapter.clearReplaySessionProperties).not.toHaveBeenCalled();
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

  it('applies paywall follow-up to an in-flight chat start without a second context', async () => {
    const adapter = createMockAdapter();
    adapter.whenReady.mockImplementation(async () => {
      await Promise.resolve();
      return true;
    });
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    const started = api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    await api.enterPaywallFollowup();
    await started;
    expect(api.getState()).toBe('paywall_followup');
    expect(api.getSnapshot().replayContextId).toBe(replayContextId);
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);
    expect(adapter.stopRecording).not.toHaveBeenCalled();
  });

  it('keeps the same context when chat rebinds during paywall follow-up', async () => {
    let nextId = 0;
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({
      adapter,
      createContextId: () => `11111111-1111-4111-8111-11111111111${nextId++}`,
    });
    const first = await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    await api.enterPaywallFollowup();
    const second = await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: 'gpt-4o',
    });
    expect(second).toBe(first);
    expect(api.getState()).toBe('paywall_followup');
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(1);
    expect(adapter.stopRecording).not.toHaveBeenCalled();
    expect(
      adapter.captures.filter((item) => (item as { event: string }).event === 'replay_chat_ended')
    ).toEqual([]);
  });

  it('ignores route_change and pagehide while paywall continuation is held', async () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    await api.enterPaywallFollowup();
    await api.endReplay('route_change');
    expect(api.getState()).toBe('paywall_followup');
    expect(api.getSnapshot().replayContextId).toBe(replayContextId);
    expect(adapter.stopRecording).not.toHaveBeenCalled();
    expect(adapter.clearReplaySessionProperties).not.toHaveBeenCalled();

    await api.endReplay('pagehide');
    expect(api.getState()).toBe('paywall_followup');
    expect(api.isPaywallContinuationActive()).toBe(true);
  });

  it('starts a new recording when entering a different character', async () => {
    const otherCharacterId = '44444444-4444-4444-8444-444444444444';
    const otherSessionId = '55555555-5555-4555-8555-555555555555';
    let nextId = 0;
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({
      adapter,
      createContextId: () => `11111111-1111-4111-8111-11111111111${nextId++}`,
    });
    const first = await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    const second = await api.startChatReplay({
      characterId: otherCharacterId,
      conversationSessionId: otherSessionId,
      selectedModelId: null,
    });
    expect(second).not.toBe(first);
    expect(adapter.startNewRecording).toHaveBeenCalledTimes(2);
    expect(adapter.stopRecording).toHaveBeenCalledTimes(1);
    expect(adapter.captures.map((item) => (item as { event: string }).event)).toEqual([
      'replay_chat_started',
      'replay_chat_ended',
      'replay_chat_started',
    ]);
  });

  it('allows leaving chat after returning from paywall follow-up', async () => {
    const adapter = createMockAdapter();
    const api = createReplayLifecycle({ adapter, createContextId: () => replayContextId });
    await api.startChatReplay({
      characterId,
      conversationSessionId,
      selectedModelId: null,
    });
    await api.enterPaywallFollowup();
    api.reenterChatFromFollowup();
    expect(api.getState()).toBe('chat');
    expect(api.isPaywallContinuationActive()).toBe(false);
    await api.endReplay('route_change');
    expect(api.getState()).toBe('ended');
    expect(adapter.stopRecording).toHaveBeenCalledTimes(1);
    expect(adapter.clearReplaySessionProperties).toHaveBeenCalledTimes(1);
    expect(adapter.capture.mock.invocationCallOrder.at(-1)).toBeLessThan(
      adapter.clearReplaySessionProperties.mock.invocationCallOrder[0] ?? 0
    );
  });
});
