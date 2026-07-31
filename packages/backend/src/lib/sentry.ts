import * as Sentry from '@sentry/node';
import type { FastifyRequest } from 'fastify';
import { sanitizeTelemetry } from '@miniapp/shared';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogValue = string | number | boolean | null | undefined;
type LogAttributes = Record<string, LogValue>;

export type RequestTelemetryContext = {
  requestId: string;
  journeyId?: string;
  attemptId?: string;
  bootSessionId?: string;
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function getRequestTelemetryContext(request: FastifyRequest): RequestTelemetryContext {
  return {
    requestId: request.id,
    journeyId: header(request, 'x-first-chat-journey-id'),
    attemptId: header(request, 'x-first-chat-attempt-id'),
    bootSessionId: header(request, 'x-boot-session-id'),
  };
}

export function bindRequestSentryContext(request: FastifyRequest): void {
  const context = getRequestTelemetryContext(request);
  const scope = Sentry.getIsolationScope();
  scope.setTag('service', 'backend');
  scope.setTag('request_id', context.requestId);
  if (context.journeyId) scope.setTag('journey_id', context.journeyId);
  if (context.attemptId) scope.setTag('attempt_id', context.attemptId);
  if (context.bootSessionId) scope.setTag('boot_session_id', context.bootSessionId);
  scope.setContext('request_correlation', {
    requestId: context.requestId,
    journeyId: context.journeyId,
    attemptId: context.attemptId,
    bootSessionId: context.bootSessionId,
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
    if (context.journeyId) scope.setTag('journey_id', context.journeyId);
    if (context.attemptId) scope.setTag('attempt_id', context.attemptId);
    for (const [name, value] of Object.entries(attributes)) {
      if (value !== undefined && value !== null) scope.setTag(name, String(value));
    }
    scope.setContext('first_chat', sanitizeTelemetry({ ...context, stage, ...attributes }));
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}

export function downstreamTelemetryHeaders(request: FastifyRequest): Record<string, string> {
  const context = getRequestTelemetryContext(request);
  const traceData = Sentry.getTraceData();
  return {
    'X-Request-Id': context.requestId,
    ...(context.journeyId ? { 'X-First-Chat-Journey-Id': context.journeyId } : {}),
    ...(context.attemptId ? { 'X-First-Chat-Attempt-Id': context.attemptId } : {}),
    ...(context.bootSessionId ? { 'X-Boot-Session-Id': context.bootSessionId } : {}),
    ...(traceData['sentry-trace'] ? { 'sentry-trace': traceData['sentry-trace'] } : {}),
    ...(traceData.baggage ? { baggage: traceData.baggage } : {}),
  };
}
