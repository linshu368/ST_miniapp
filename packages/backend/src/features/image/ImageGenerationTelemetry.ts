import {
  parseReplayTelemetryEvent,
  type ImageChargeStatus,
  type ImageFailureKind,
  type ImagePromptSource,
  type ImageTerminalStatus,
} from '@miniapp/shared';
import { findTelegramIdByUserId } from '../../lib/user.js';
import {
  captureReplayTelemetryEvent,
  isPosthogCaptureConfigured,
  type PosthogCaptureLogger,
} from '../../infrastructure/telemetry/posthog-capture.js';

type ImageTelemetryBase = {
  userId: string;
  characterId: string;
  conversationSessionId: string;
  selectedModelId: string | null;
  messageId: string;
};

type ImageAttemptTelemetry = ImageTelemetryBase & {
  attemptId: string;
  attemptNo: number;
};

export type ImageDescriptionCompletedTelemetryInput = ImageAttemptTelemetry & {
  promptChars: number;
  durationMs: number;
};

export type ImageDescriptionFailedTelemetryInput = ImageTelemetryBase & {
  attemptId?: string;
  attemptNo?: number;
  errorCode: string;
  durationMs: number;
  failureKind: ImageFailureKind;
};

export type ImageGenerationAcceptedTelemetryInput = ImageAttemptTelemetry & {
  promptSource: ImagePromptSource;
  promptChars: number;
  priceCredits: number;
  width: number;
  height: number;
};

export type ImageGenerationCompletedTelemetryInput = ImageAttemptTelemetry & {
  chargeStatus: Exclude<ImageChargeStatus, 'insufficient_balance'>;
  creditsCharged: number;
  provider: string;
  fallbackUsed: boolean;
  width: number;
  height: number;
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg';
  byteSize: number;
  durationMs: number;
};

export type ImageGenerationFailedTelemetryInput = ImageAttemptTelemetry & {
  terminalStatus: Exclude<ImageTerminalStatus, 'ready'>;
  errorCode: string;
  failureKind: ImageFailureKind;
  provider: string;
  fallbackUsed: boolean;
  durationMs: number;
};

export function observeImageDescriptionCompleted(
  input: ImageDescriptionCompletedTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  return queueImageTelemetry('description_completed', input, log);
}

export function observeImageDescriptionFailed(
  input: ImageDescriptionFailedTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  return queueImageTelemetry('description_failed', input, log);
}

export function observeImageGenerationAccepted(
  input: ImageGenerationAcceptedTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  return queueImageTelemetry('generation_accepted', input, log);
}

export function observeImageGenerationCompleted(
  input: ImageGenerationCompletedTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  return queueImageTelemetry('generation_completed', input, log);
}

export function observeImageGenerationFailed(
  input: ImageGenerationFailedTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  return queueImageTelemetry('generation_failed', input, log);
}

function queueImageTelemetry(
  kind:
    | 'description_completed'
    | 'description_failed'
    | 'generation_accepted'
    | 'generation_completed'
    | 'generation_failed',
  input:
    | ImageDescriptionCompletedTelemetryInput
    | ImageDescriptionFailedTelemetryInput
    | ImageGenerationAcceptedTelemetryInput
    | ImageGenerationCompletedTelemetryInput
    | ImageGenerationFailedTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  try {
    return emitImageTelemetry(kind, input, log).catch((err: unknown) => {
      log.sys.error(
        { event: 'image.telemetry.failed', err, attemptId: readAttemptId(input) },
        '图片生成事件发送失败'
      );
    });
  } catch (err) {
    log.sys.error(
      { event: 'image.telemetry.failed', err, attemptId: readAttemptId(input) },
      '图片生成事件发送失败'
    );
    return Promise.resolve();
  }
}

async function emitImageTelemetry(
  kind:
    | 'description_completed'
    | 'description_failed'
    | 'generation_accepted'
    | 'generation_completed'
    | 'generation_failed',
  input:
    | ImageDescriptionCompletedTelemetryInput
    | ImageDescriptionFailedTelemetryInput
    | ImageGenerationAcceptedTelemetryInput
    | ImageGenerationCompletedTelemetryInput
    | ImageGenerationFailedTelemetryInput,
  log: PosthogCaptureLogger
): Promise<void> {
  // 未配置时不反查用户，保持 PostHog 对图片主链路完全非关键。
  if (!isPosthogCaptureConfigured()) return;

  const telegramUserId = await findTelegramIdByUserId(input.userId);
  if (!telegramUserId) {
    log.sys.warn(
      { event: 'image.telemetry.identity_missing', attemptId: readAttemptId(input) },
      '图片生成事件缺少 Telegram 用户 ID，跳过'
    );
    return;
  }

  const parsed = parseReplayTelemetryEvent({
    event: imageEventName(kind),
    telegram_user_id: telegramUserId,
    occurred_at: new Date().toISOString(),
    character_id: input.characterId,
    conversation_session_id: input.conversationSessionId,
    selected_model_id: input.selectedModelId,
    message_id: input.messageId,
    ...imageEventPayload(kind, input),
  });

  await captureReplayTelemetryEvent(parsed, log);
}

function imageEventName(
  kind:
    | 'description_completed'
    | 'description_failed'
    | 'generation_accepted'
    | 'generation_completed'
    | 'generation_failed'
) {
  switch (kind) {
    case 'description_completed':
      return 'image_description_completed';
    case 'description_failed':
      return 'image_description_failed';
    case 'generation_accepted':
      return 'image_generation_accepted';
    case 'generation_completed':
      return 'image_generation_completed';
    case 'generation_failed':
      return 'image_generation_failed';
  }
}

function imageEventPayload(
  kind:
    | 'description_completed'
    | 'description_failed'
    | 'generation_accepted'
    | 'generation_completed'
    | 'generation_failed',
  input:
    | ImageDescriptionCompletedTelemetryInput
    | ImageDescriptionFailedTelemetryInput
    | ImageGenerationAcceptedTelemetryInput
    | ImageGenerationCompletedTelemetryInput
    | ImageGenerationFailedTelemetryInput
): Record<string, unknown> {
  switch (kind) {
    case 'description_completed': {
      const value = input as ImageDescriptionCompletedTelemetryInput;
      return {
        attempt_id: value.attemptId,
        attempt_no: value.attemptNo,
        prompt_chars: value.promptChars,
        duration_ms: value.durationMs,
      };
    }
    case 'description_failed': {
      const value = input as ImageDescriptionFailedTelemetryInput;
      return {
        ...(value.attemptId ? { attempt_id: value.attemptId } : {}),
        ...(value.attemptNo ? { attempt_no: value.attemptNo } : {}),
        error_code: value.errorCode,
        duration_ms: value.durationMs,
        failure_kind: value.failureKind,
      };
    }
    case 'generation_accepted': {
      const value = input as ImageGenerationAcceptedTelemetryInput;
      return {
        attempt_id: value.attemptId,
        attempt_no: value.attemptNo,
        prompt_source: value.promptSource,
        prompt_chars: value.promptChars,
        price_credits: value.priceCredits,
        width: value.width,
        height: value.height,
      };
    }
    case 'generation_completed': {
      const value = input as ImageGenerationCompletedTelemetryInput;
      return {
        attempt_id: value.attemptId,
        attempt_no: value.attemptNo,
        charge_status: value.chargeStatus,
        credits_charged: value.creditsCharged,
        provider: value.provider,
        fallback_used: value.fallbackUsed,
        width: value.width,
        height: value.height,
        mime_type: value.mimeType,
        byte_size: value.byteSize,
        duration_ms: value.durationMs,
      };
    }
    case 'generation_failed': {
      const value = input as ImageGenerationFailedTelemetryInput;
      return {
        attempt_id: value.attemptId,
        attempt_no: value.attemptNo,
        terminal_status: value.terminalStatus,
        error_code: value.errorCode,
        failure_kind: value.failureKind,
        provider: value.provider,
        fallback_used: value.fallbackUsed,
        duration_ms: value.durationMs,
      };
    }
  }
}

function readAttemptId(input: { attemptId?: string }): string | undefined {
  return input.attemptId;
}
