'use client';

import { useEffect } from 'react';
import type {
  ImageEntrySource,
  ImageFailureKind,
  ImagePromptSource,
  MessageImageAttempt,
} from '@miniapp/shared';

import { getReplayLifecycle, type ReplayEventDraft } from '@/lib/telemetry';

export type ImageTelemetryContext = {
  characterId: string;
  conversationSessionId: string;
  selectedModelId: string | null;
  messageId: string;
  requiredCredits?: number;
};

const observedTerminalKeys = new Set<string>();
const observedSaveResultKeys = new Set<string>();

function imageBase(context: ImageTelemetryContext) {
  return {
    character_id: context.characterId,
    conversation_session_id: context.conversationSessionId,
    selected_model_id: context.selectedModelId,
    message_id: context.messageId,
  };
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries) as T;
}

function hasActiveImageReplayContext(): boolean {
  const snapshot = getReplayLifecycle().getSnapshot();
  if (!snapshot.replayContextId) return false;
  return (
    snapshot.state === 'chat' ||
    snapshot.state === 'paywall_followup' ||
    snapshot.state === 'external_payment_pending'
  );
}

function captureDraft(draft: ReplayEventDraft): boolean {
  if (!hasActiveImageReplayContext()) return false;
  try {
    return getReplayLifecycle().capture(draft);
  } catch {
    return false;
  }
}

function durationSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

export function imageFailureKind(error: unknown): ImageFailureKind {
  const status = typeof error === 'object' && error ? (error as { status?: unknown }).status : null;
  const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : null;
  const text = typeof code === 'string' ? code : '';
  if (status === 402 || text === 'insufficient_balance') return 'business';
  if (text.includes('timeout')) return 'timeout';
  if (text.includes('network')) return 'network';
  return 'unknown';
}

export function imageErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

export function captureImageEntrySelected(input: {
  context: ImageTelemetryContext;
  entrySource: ImageEntrySource;
  latestStatus?: MessageImageAttempt['status'];
  hasReadyImage: boolean;
}): void {
  captureDraft(
    omitUndefined({
      event: 'image_entry_selected' as const,
      ...imageBase(input.context),
      entry_source: input.entrySource,
      latest_status: input.latestStatus,
      has_ready_image: input.hasReadyImage,
    })
  );
}

export function captureImageDescriptionRequested(context: ImageTelemetryContext): void {
  captureDraft({
    event: 'image_description_requested',
    ...imageBase(context),
  });
}

export function captureImageDescriptionPresented(input: {
  context: ImageTelemetryContext;
  attemptId: string;
  promptChars: number;
}): void {
  captureDraft({
    event: 'image_description_presented',
    ...imageBase(input.context),
    attempt_id: input.attemptId,
    prompt_chars: input.promptChars,
  });
}

export function captureImageDescriptionFailed(input: {
  context: ImageTelemetryContext;
  error: unknown;
  startedAt: number;
}): void {
  captureDraft(
    omitUndefined({
      event: 'image_description_ui_failed' as const,
      ...imageBase(input.context),
      failure_kind: imageFailureKind(input.error),
      error_code: imageErrorCode(input.error),
      duration_ms: durationSince(input.startedAt),
    })
  );
}

export function captureImageCustomPromptOpened(input: {
  context: ImageTelemetryContext;
  entrySource: ImageEntrySource;
}): void {
  captureDraft({
    event: 'image_custom_prompt_opened',
    ...imageBase(input.context),
    entry_source: input.entrySource,
  });
}

export function captureImageGenerationSubmitted(input: {
  context: ImageTelemetryContext;
  promptSource: ImagePromptSource;
  promptChars: number;
}): void {
  captureDraft(
    omitUndefined({
      event: 'image_generation_submitted' as const,
      ...imageBase(input.context),
      prompt_source: input.promptSource,
      prompt_chars: input.promptChars,
      required_credits: input.context.requiredCredits,
    })
  );
}

export function captureImageGenerationSubmitFailed(input: {
  context: ImageTelemetryContext;
  promptSource: ImagePromptSource;
  promptChars: number;
  error: unknown;
  startedAt: number;
}): void {
  captureDraft(
    omitUndefined({
      event: 'image_generation_submit_failed' as const,
      ...imageBase(input.context),
      prompt_source: input.promptSource,
      prompt_chars: input.promptChars,
      failure_kind: imageFailureKind(input.error),
      error_code: imageErrorCode(input.error),
      required_credits: input.context.requiredCredits,
      duration_ms: durationSince(input.startedAt),
    })
  );
}

export function captureImageStatusObserved(input: {
  context: ImageTelemetryContext;
  attempt: MessageImageAttempt;
}): void {
  const status = input.attempt.status;
  if (status !== 'ready' && status !== 'failed' && status !== 'failed_unknown') return;
  const key = `${input.attempt.id}:${status}`;
  if (observedTerminalKeys.has(key)) return;
  const durationMs = terminalDurationMs(input.attempt);
  if (
    captureDraft(
      omitUndefined({
        event: 'image_generation_status_observed' as const,
        ...imageBase(input.context),
        attempt_id: input.attempt.id,
        attempt_no: input.attempt.attempt_no,
        terminal_status: status,
        error_code: input.attempt.error_code,
        credits_charged: input.attempt.credits_charged,
        duration_ms: durationMs,
        prompt_source: input.attempt.prompt_source,
      })
    )
  ) {
    observedTerminalKeys.add(key);
  }
}

export function useImageStatusTelemetry(
  context: ImageTelemetryContext | null,
  attempt: MessageImageAttempt | null
): void {
  useEffect(() => {
    if (!context || !attempt) return;
    captureImageStatusObserved({ context, attempt });
  }, [attempt, context]);
}

export function captureImagePreviewOpened(input: {
  context: ImageTelemetryContext;
  attempt: MessageImageAttempt;
}): void {
  captureDraft({
    event: 'image_preview_opened',
    ...imageBase(input.context),
    attempt_id: input.attempt.id,
    attempt_no: input.attempt.attempt_no,
  });
}

export function captureImageSaveRequested(input: {
  context: ImageTelemetryContext;
  attempt: MessageImageAttempt;
}): void {
  captureDraft({
    event: 'image_save_requested',
    ...imageBase(input.context),
    attempt_id: input.attempt.id,
    attempt_no: input.attempt.attempt_no,
  });
}

export function captureImageSaveCompleted(input: {
  context: ImageTelemetryContext;
  attempt: MessageImageAttempt;
  startedAt: number;
}): void {
  const key = `${input.attempt.id}:completed`;
  if (observedSaveResultKeys.has(key)) return;
  if (
    captureDraft({
      event: 'image_save_completed',
      ...imageBase(input.context),
      attempt_id: input.attempt.id,
      attempt_no: input.attempt.attempt_no,
      duration_ms: durationSince(input.startedAt),
    })
  ) {
    observedSaveResultKeys.add(key);
  }
}

export function captureImageSaveFailed(input: {
  context: ImageTelemetryContext;
  attempt: MessageImageAttempt;
  startedAt: number;
  failureKind?: ImageFailureKind;
}): void {
  const key = `${input.attempt.id}:failed`;
  if (observedSaveResultKeys.has(key)) return;
  if (
    captureDraft({
      event: 'image_save_failed',
      ...imageBase(input.context),
      attempt_id: input.attempt.id,
      attempt_no: input.attempt.attempt_no,
      failure_kind: input.failureKind ?? 'unknown',
      duration_ms: durationSince(input.startedAt),
    })
  ) {
    observedSaveResultKeys.add(key);
  }
}

export function resetImageGenerationTelemetryForTests(): void {
  observedTerminalKeys.clear();
  observedSaveResultKeys.clear();
}

function terminalDurationMs(attempt: MessageImageAttempt): number | undefined {
  const completedAt = attempt.completed_at ? Date.parse(attempt.completed_at) : NaN;
  const createdAt = Date.parse(attempt.created_at);
  if (!Number.isFinite(completedAt) || !Number.isFinite(createdAt)) return undefined;
  return Math.max(0, completedAt - createdAt);
}
