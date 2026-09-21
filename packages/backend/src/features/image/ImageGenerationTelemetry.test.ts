import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  observeImageGenerationCompleted,
  observeImageGenerationFailed,
} from './ImageGenerationTelemetry.js';
import { findTelegramIdByUserId } from '../../lib/user.js';
import {
  captureReplayTelemetryEvent,
  isPosthogCaptureConfigured,
} from '../../infrastructure/telemetry/posthog-capture.js';

vi.mock('../../lib/user.js', () => ({
  findTelegramIdByUserId: vi.fn(),
}));

vi.mock('../../infrastructure/telemetry/posthog-capture.js', () => ({
  isPosthogCaptureConfigured: vi.fn(() => true),
  captureReplayTelemetryEvent: vi.fn(async () => 'sent'),
}));

function createLog() {
  return {
    biz: { info: vi.fn() },
    sys: { warn: vi.fn(), error: vi.fn() },
  };
}

const base = {
  userId: '00000000-0000-0000-0000-000000000001',
  characterId: '22222222-2222-4222-8222-222222222222',
  conversationSessionId: '33333333-3333-4333-8333-333333333333',
  selectedModelId: 'gpt-4o',
  messageId: '44444444-4444-4444-8444-444444444444',
  attemptId: '55555555-5555-4555-8555-555555555555',
  attemptNo: 1,
};

describe('ImageGenerationTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPosthogCaptureConfigured).mockReturnValue(true);
    vi.mocked(findTelegramIdByUserId).mockResolvedValue('123456789');
    vi.mocked(captureReplayTelemetryEvent).mockResolvedValue('sent');
  });

  it('captures a completed image terminal event with safe metadata only', async () => {
    await observeImageGenerationCompleted(
      {
        ...base,
        chargeStatus: 'charged',
        creditsCharged: 10,
        provider: 'liaobots_grok',
        fallbackUsed: false,
        width: 768,
        height: 1152,
        mimeType: 'image/webp',
        byteSize: 2048,
        durationMs: 20_000,
      },
      createLog()
    );

    await vi.waitFor(() => {
      expect(captureReplayTelemetryEvent).toHaveBeenCalledOnce();
    });

    const [event] = vi.mocked(captureReplayTelemetryEvent).mock.calls[0] ?? [];
    expect(event).toMatchObject({
      event: 'image_generation_completed',
      telegram_user_id: '123456789',
      attempt_id: base.attemptId,
      charge_status: 'charged',
      provider: 'liaobots_grok',
    });
    expect(event).not.toHaveProperty('prompt_cn');
    expect(event).not.toHaveProperty('image_url');
    expect(event).not.toHaveProperty('storage_path');
    expect(event).not.toHaveProperty('provider_request_id');
  });

  it('captures a failed image terminal event after the attempt is marked failed', async () => {
    await observeImageGenerationFailed(
      {
        ...base,
        terminalStatus: 'failed_unknown',
        errorCode: 'image_provider_timeout_unknown',
        failureKind: 'timeout',
        provider: 'liaobots_grok',
        fallbackUsed: false,
        durationMs: 15_000,
      },
      createLog()
    );

    await vi.waitFor(() => {
      expect(captureReplayTelemetryEvent).toHaveBeenCalledOnce();
    });
    expect(vi.mocked(captureReplayTelemetryEvent).mock.calls[0]?.[0]).toMatchObject({
      event: 'image_generation_failed',
      terminal_status: 'failed_unknown',
      failure_kind: 'timeout',
    });
  });

  it('does not look up users or capture when PostHog is unconfigured', async () => {
    vi.mocked(isPosthogCaptureConfigured).mockReturnValue(false);

    await observeImageGenerationCompleted(
      {
        ...base,
        chargeStatus: 'charged',
        creditsCharged: 10,
        provider: 'liaobots_grok',
        fallbackUsed: false,
        width: 768,
        height: 1152,
        mimeType: 'image/webp',
        byteSize: 2048,
        durationMs: 20_000,
      },
      createLog()
    );

    expect(findTelegramIdByUserId).not.toHaveBeenCalled();
    expect(captureReplayTelemetryEvent).not.toHaveBeenCalled();
  });
});
