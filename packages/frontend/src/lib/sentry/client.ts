'use client';

import * as Sentry from '@sentry/nextjs';

import { createLogger } from '@/lib/logger';

import { sanitizeTelemetry } from './sanitize';

const log = createLogger('sentry');

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogAttribute = string | number | boolean | null | undefined;
export type SentryLogAttributes = Record<string, LogAttribute>;

let replayLoadPromise: Promise<void> | undefined;

export function sendSentryLog(
  level: LogLevel,
  eventName: string,
  attributes: SentryLogAttributes = {}
): void {
  if (!Sentry.getClient()) return;

  const safeAttributes = sanitizeTelemetry({
    event_name: eventName,
    ...attributes,
  });
  Sentry.logger[level](eventName, safeAttributes);
}

export function loadSessionReplay(): Promise<void> {
  if (!Sentry.getClient()) return Promise.resolve();
  if (replayLoadPromise) return replayLoadPromise;

  replayLoadPromise = import('@sentry/nextjs')
    .then((lazySentry) => {
      Sentry.addIntegration(
        lazySentry.replayIntegration({
          maskAllText: false,
          blockAllMedia: false,
          beforeAddRecordingEvent: (event) => sanitizeTelemetry(event),
        })
      );
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn('Session Replay failed to load', { reason });
      sendSentryLog('warn', 'sentry.replay_load_failed', { reason });
    });

  return replayLoadPromise;
}

export function setTelegramUser(telegramUserId: number | undefined): void {
  if (!Sentry.getClient()) return;

  if (telegramUserId === undefined) {
    sendSentryLog('warn', 'sentry.telegram_user_context_failed', {
      reason: 'telegram_user_id_missing',
    });
    return;
  }

  const id = String(telegramUserId);
  Sentry.setUser({ id });
  Sentry.setTag('telegram_user_id', id);
}

export function setCharacterContext(characterId: string): void {
  if (!Sentry.getClient()) return;
  Sentry.setTag('character_id', characterId);
  Sentry.setContext('character', { id: characterId });
}
