import { describe, expect, it, vi } from 'vitest';

import { createPostHogAdapter, type PostHogClient } from './adapter';

const replayContextId = '11111111-1111-4111-8111-111111111111';
const occurredAt = '2026-09-15T10:00:00.000Z';

function createClient(): PostHogClient {
  return {
    init: vi.fn(),
    identify: vi.fn(),
    setPersonProperties: vi.fn(),
    register_for_session: vi.fn(),
    capture: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
    sessionRecordingStarted: vi.fn(() => false),
  };
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
    expect(client.startSessionRecording).toHaveBeenCalledWith({
      sampling: true,
      linked_flag: true,
      url_trigger: true,
      event_trigger: true,
    });
    expect(client.startSessionRecording).not.toHaveBeenCalledWith(false);
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
