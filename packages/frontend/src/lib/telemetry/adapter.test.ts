import { describe, expect, it, vi } from 'vitest';

import {
  createPostHogAdapter,
  POSTHOG_SDK_LOAD_TIMEOUT_MS,
  type PostHogClient,
  type PostHogSdkModule,
} from './adapter';

const replayContextId = '11111111-1111-4111-8111-111111111111';
const occurredAt = '2026-09-15T10:00:00.000Z';

function createClient(): PostHogClient {
  let recording = false;
  const client: PostHogClient = {
    init: vi.fn(),
    identify: vi.fn(),
    setPersonProperties: vi.fn(),
    register_for_session: vi.fn(),
    unregister_for_session: vi.fn(),
    capture: vi.fn(),
    startSessionRecording: vi.fn(() => {
      recording = true;
    }),
    stopSessionRecording: vi.fn(() => {
      recording = false;
    }),
    sessionRecordingStarted: vi.fn(() => recording),
    sessionManager: {
      resetSessionId: vi.fn(),
    },
  };
  return client;
}

describe('PostHog adapter', () => {
  it('is a no-op when public config is missing', async () => {
    const client = createClient();
    const adapter = createPostHogAdapter({
      env: { key: undefined, host: undefined },
      isBrowser: () => true,
      loadSdk: async () => ({ default: client }),
    });

    await expect(adapter.init('123456789')).resolves.toBe(false);
    expect(adapter.isReady()).toBe(false);
    expect(client.init).not.toHaveBeenCalled();
    expect(adapter.startNewRecording()).toBe(false);
    expect(adapter.capture({ event: 'replay_sdk_init_failed' })).toBe(false);
  });

  it('is a no-op when the host is not https', async () => {
    const client = createClient();
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'http://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: async () => ({ default: client }),
    });

    await expect(adapter.init('123456789')).resolves.toBe(false);
    expect(client.init).not.toHaveBeenCalled();
    expect(adapter.startNewRecording()).toBe(false);
  });

  it('is a no-op when SDK init throws', async () => {
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: async () => {
        throw new Error('cdn blocked');
      },
    });

    await expect(adapter.init('123456789')).resolves.toBe(false);
    expect(adapter.isReady()).toBe(false);
    expect(adapter.startNewRecording()).toBe(false);
  });

  it('fails init when SDK import never settles, and ignores a late load', async () => {
    vi.useFakeTimers();
    const client = createClient();
    let resolveSdk: ((mod: PostHogSdkModule) => void) | undefined;
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: () =>
        new Promise((resolve) => {
          resolveSdk = resolve;
        }),
    });

    try {
      const pending = adapter.init('123456789');
      await vi.advanceTimersByTimeAsync(POSTHOG_SDK_LOAD_TIMEOUT_MS);
      await expect(pending).resolves.toBe(false);
      await expect(adapter.whenReady()).resolves.toBe(false);
      expect(adapter.isReady()).toBe(false);

      resolveSdk?.({ default: client });
      await Promise.resolve();
      expect(client.init).not.toHaveBeenCalled();
      expect(adapter.isReady()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts recording with ingestion overrides, not startSessionRecording(false)', async () => {
    const client = createClient();
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: async () => ({ default: client }),
    });

    await expect(adapter.init('123456789')).resolves.toBe(true);
    expect(client.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        api_host: 'https://us.i.posthog.com',
        disable_session_recording: true,
        autocapture: false,
        enable_recording_console_log: false,
        capture_performance: false,
      })
    );
    expect(client.identify).toHaveBeenCalledWith('123456789');
    expect(adapter.startNewRecording(replayContextId)).toBe(true);
    expect(adapter.isRecording()).toBe(true);
    expect(client.startSessionRecording).toHaveBeenCalledWith({
      sampling: true,
      linked_flag: true,
      url_trigger: true,
      event_trigger: true,
    });
    expect(client.startSessionRecording).not.toHaveBeenCalledWith(false);
    expect(client.sessionManager?.resetSessionId).toHaveBeenCalledTimes(1);
  });

  it('rotates $session_id between consecutive recordings without resetting identity', async () => {
    const client = createClient();
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: async () => ({ default: client }),
    });
    await adapter.init('123456789');
    expect(adapter.startNewRecording(replayContextId)).toBe(true);
    expect(adapter.startNewRecording(replayContextId)).toBe(true);
    expect(client.stopSessionRecording).toHaveBeenCalledTimes(1);
    expect(client.sessionManager?.resetSessionId).toHaveBeenCalledTimes(2);
    expect(client.startSessionRecording).toHaveBeenCalledTimes(2);
    expect(client.identify).toHaveBeenCalledTimes(1);
    expect(client.identify).toHaveBeenCalledWith('123456789');
  });

  it('does not treat startSessionRecording() itself as proof that recording started', async () => {
    const client = createClient();
    client.startSessionRecording = vi.fn();
    client.sessionRecordingStarted = vi.fn(() => false);
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: async () => ({ default: client }),
    });
    await adapter.init('123456789');
    expect(adapter.startNewRecording(replayContextId)).toBe(false);
    expect(adapter.isRecording()).toBe(false);
    expect(client.startSessionRecording).toHaveBeenCalled();
  });

  it('rejects events that carry chat body or pay_url', async () => {
    const client = createClient();
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      now: () => new Date(occurredAt),
      loadSdk: async () => ({ default: client }),
    });
    await adapter.init('123456789');

    expect(
      adapter.capture({
        event: 'replay_chat_started',
        telegram_user_id: '123456789',
        replay_context_id: replayContextId,
        occurred_at: occurredAt,
        character_id: '22222222-2222-4222-8222-222222222222',
        conversation_session_id: '33333333-3333-4333-8333-333333333333',
        selected_model_id: 'gpt-4o',
        content: 'secret chat',
      } as Record<string, unknown>)
    ).toBe(false);
    expect(client.capture).not.toHaveBeenCalledWith('replay_chat_started', expect.anything());
  });

  it('captures recharge_entry_clicked without replay_context_id', async () => {
    const client = createClient();
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      now: () => new Date(occurredAt),
      loadSdk: async () => ({ default: client }),
    });
    await adapter.init('123456789');

    expect(
      adapter.capture({
        event: 'recharge_entry_clicked',
        telegram_user_id: '123456789',
        occurred_at: occurredAt,
        entry_source: 'profile_balance',
      })
    ).toBe(true);
    expect(client.capture).toHaveBeenCalledWith('recharge_entry_clicked', {
      telegram_user_id: '123456789',
      occurred_at: occurredAt,
      entry_source: 'profile_balance',
    });
  });

  it('removes chat session properties before a standalone entry event is enriched', async () => {
    const sessionProperties = new Map<string, unknown>();
    const delivered: Array<Record<string, unknown>> = [];
    const client = createClient();
    client.register_for_session = vi.fn((properties) => {
      for (const [key, value] of Object.entries(properties)) sessionProperties.set(key, value);
    });
    client.unregister_for_session = vi.fn((key) => {
      sessionProperties.delete(key);
    });
    client.capture = vi.fn((_event, properties) => {
      delivered.push({ ...Object.fromEntries(sessionProperties), ...properties });
    });
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: async () => ({ default: client }),
    });
    await adapter.init('123456789');
    adapter.registerSessionProperties({
      replay_context_id: replayContextId,
      character_id: '22222222-2222-4222-8222-222222222222',
      conversation_session_id: '33333333-3333-4333-8333-333333333333',
      selected_model_id: null,
      is_paid_user: true,
    });

    adapter.clearReplaySessionProperties();
    adapter.capture({
      event: 'recharge_entry_clicked',
      telegram_user_id: '123456789',
      occurred_at: occurredAt,
      entry_source: 'profile_balance',
    });

    expect(delivered[0]).toMatchObject({
      telegram_user_id: '123456789',
      entry_source: 'profile_balance',
      is_paid_user: true,
    });
    expect(delivered[0]).not.toHaveProperty('replay_context_id');
    expect(delivered[0]).not.toHaveProperty('character_id');
    expect(delivered[0]).not.toHaveProperty('conversation_session_id');
    expect(delivered[0]).not.toHaveProperty('selected_model_id');
  });

  it('does not throw when start/stop recording fails', async () => {
    const client = createClient();
    client.startSessionRecording = vi.fn(() => {
      throw new Error('recorder missing');
    });
    const adapter = createPostHogAdapter({
      env: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      isBrowser: () => true,
      loadSdk: async () => ({ default: client }),
    });
    await adapter.init('123456789');
    expect(adapter.startNewRecording()).toBe(false);
  });
});
