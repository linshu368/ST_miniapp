import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageImageAttempt } from '@miniapp/shared';

import {
  captureImageGenerationSubmitted,
  captureImageSaveCompleted,
  captureImageStatusObserved,
  imageFailureKind,
  resetImageGenerationTelemetryForTests,
  type ImageTelemetryContext,
} from './telemetry';

type Snapshot = {
  state: 'idle' | 'chat' | 'paywall_followup' | 'external_payment_pending';
  replayContextId: string | null;
  telemetryReady: boolean;
  streaming: boolean;
};

const capture = vi.fn((_draft: unknown) => true);
const getSnapshot = vi.fn(
  (): Snapshot => ({
    state: 'chat' as const,
    replayContextId: '11111111-1111-4111-8111-111111111111',
    telemetryReady: true,
    streaming: false,
  })
);

vi.mock('@/lib/telemetry', () => ({
  getReplayLifecycle: () => ({
    capture,
    getSnapshot,
  }),
}));

const context: ImageTelemetryContext = {
  characterId: '22222222-2222-4222-8222-222222222222',
  conversationSessionId: '33333333-3333-4333-8333-333333333333',
  selectedModelId: 'gpt-4o',
  messageId: '44444444-4444-4444-8444-444444444444',
  requiredCredits: 10,
};

const readyAttempt: MessageImageAttempt = {
  id: '55555555-5555-4555-8555-555555555555',
  message_id: context.messageId,
  attempt_no: 1,
  status: 'ready',
  prompt_cn: 'safe prompt text must never be copied',
  prompt_source: 'generated',
  image_url: 'https://storage.example/image.webp',
  width: 768,
  height: 1152,
  mime_type: 'image/webp',
  byte_size: 2048,
  error_code: null,
  price_credits: 10,
  price_label: '10 星尘',
  credits_charged: 10,
  created_at: '2026-09-15T10:00:00.000Z',
  updated_at: '2026-09-15T10:00:20.000Z',
  completed_at: '2026-09-15T10:00:20.000Z',
};

function capturedPayload(): string {
  return JSON.stringify(capture.mock.calls);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetImageGenerationTelemetryForTests();
  getSnapshot.mockReturnValue({
    state: 'chat',
    replayContextId: '11111111-1111-4111-8111-111111111111',
    telemetryReady: true,
    streaming: false,
  });
});

afterEach(() => {
  resetImageGenerationTelemetryForTests();
});

describe('image generation telemetry', () => {
  it('captures submit intent with length and price but not prompt text', () => {
    captureImageGenerationSubmitted({
      context,
      promptSource: 'generated',
      promptChars: 24,
    });

    expect(capture).toHaveBeenCalledWith({
      event: 'image_generation_submitted',
      character_id: context.characterId,
      conversation_session_id: context.conversationSessionId,
      selected_model_id: context.selectedModelId,
      message_id: context.messageId,
      prompt_source: 'generated',
      prompt_chars: 24,
      required_credits: 10,
    });
    expect(capturedPayload()).not.toContain('prompt_cn');
    expect(capturedPayload()).not.toContain('safe prompt text');
  });

  it('dedupes terminal status observations only after capture succeeds', () => {
    capture.mockReturnValueOnce(false);
    captureImageStatusObserved({ context, attempt: readyAttempt });
    captureImageStatusObserved({ context, attempt: readyAttempt });
    expect(capture).toHaveBeenCalledTimes(2);

    captureImageStatusObserved({ context, attempt: readyAttempt });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capturedPayload()).not.toContain('image_url');
    expect(capturedPayload()).not.toContain('storage.example');
  });

  it('dedupes save completion per attempt', () => {
    captureImageSaveCompleted({ context, attempt: readyAttempt, startedAt: Date.now() - 10 });
    captureImageSaveCompleted({ context, attempt: readyAttempt, startedAt: Date.now() - 10 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('no-ops without an active replay context', () => {
    getSnapshot.mockReturnValue({
      state: 'idle',
      replayContextId: null,
      telemetryReady: false,
      streaming: false,
    });
    captureImageGenerationSubmitted({ context, promptSource: 'custom', promptChars: 12 });
    expect(capture).not.toHaveBeenCalled();
  });

  it('classifies insufficient balance as a business failure', () => {
    expect(imageFailureKind({ status: 402 })).toBe('business');
    expect(imageFailureKind({ code: 'image_description_timeout' })).toBe('timeout');
  });
});
