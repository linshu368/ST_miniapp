import * as Sentry from '@sentry/node';
import type { FastifyRequest } from 'fastify';
import { sanitizeTelemetry } from '@miniapp/shared';

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
  const safeAttributes = sanitizeTelemetry({
    service: 'backend',
    event_name: eventName,
    ...attributes,
  });
  Sentry.logger[level](eventName, safeAttributes);
}

export function captureBackendException(
  error: unknown,
  request: FastifyRequest,
  stage: string,
  attributes: LogAttributes = {}
): void {
  Sentry.withScope((scope) => {
    const context = getRequestTelemetryContext(request);
    scope.setTag('service', 'backend');
    scope.setTag('stage', stage);
    scope.setTag('request_id', context.requestId);
    for (const [name, value] of Object.entries(attributes)) {
      if (value !== undefined && value !== null) scope.setTag(name, String(value));
    }
    scope.setContext('request', sanitizeTelemetry({ ...context, stage, ...attributes }));
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}
