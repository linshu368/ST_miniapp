import * as Sentry from '@sentry/node';
import type { FastifyRequest } from 'fastify';
import { sanitizeTelemetry } from '@miniapp/shared';
import { safeLogAttributes } from '../platform/observability/safe-log.js';
import { safeName } from '../platform/observability/events.js';

const capturedErrors = new WeakSet<Error>();

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogValue = string | number | boolean | null | undefined;
type LogAttributes = Record<string, LogValue>;

export type RequestTelemetryContext = {
  requestId: string;
};

export function getRequestTelemetryContext(request: FastifyRequest): RequestTelemetryContext {
  return {
    requestId: request.id,
  };
}

export function bindRequestSentryContext(request: FastifyRequest): void {
  const context = getRequestTelemetryContext(request);
  const scope = Sentry.getIsolationScope();
  scope.setTag('service', 'backend');
  scope.setTag('request_id', context.requestId);
  scope.setContext('request_correlation', {
    requestId: context.requestId,
  });
}

export function bindBackendUserContext(
  telegramUserId: string,
  miniappUserId?: string,
  characterId?: string
): void {
  const scope = Sentry.getIsolationScope();
  scope.setUser({ id: telegramUserId });
  scope.setTag('telegram_user_id', telegramUserId);
  if (miniappUserId) scope.setTag('miniapp_user_id', miniappUserId);
  if (characterId) scope.setTag('character_id', characterId);
}

export function sendBackendSentryLog(
  level: LogLevel,
  eventName: string,
  attributes: LogAttributes = {}
): void {
  const safeAttributes = safeLogAttributes({
    service: 'backend',
    event_name: eventName,
    ...attributes,
  });
  try {
    Sentry.logger[level](safeName(eventName), safeAttributes);
  } catch {
    /* Optional SDK output must not fail the request. */
  }
}

export function captureBackendException(
  error: unknown,
  request: FastifyRequest,
  stage: string,
  attributes: LogAttributes = {}
): void {
  if (error instanceof Error && capturedErrors.has(error)) return;
  try {
    Sentry.withScope((scope) => {
      const context = getRequestTelemetryContext(request);
      scope.setTag('service', 'backend');
      scope.setTag('stage', stage);
      scope.setTag('request_id', context.requestId);
      for (const [name, value] of Object.entries(attributes)) {
        if (value !== undefined && value !== null) scope.setTag(name, String(value));
      }
      scope.setContext('request', sanitizeTelemetry({ ...context, stage, ...attributes }));
      Sentry.captureException(
        error instanceof Error ? error : new Error('Non-error failure', { cause: error })
      );
    });
    if (error instanceof Error) capturedErrors.add(error);
  } catch {
    /* Observation cannot replace the original failure. */
  }
}
