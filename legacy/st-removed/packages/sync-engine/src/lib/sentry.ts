import * as Sentry from '@sentry/node';
import type { IncomingMessage } from 'node:http';
import { sanitizeTelemetry } from '@miniapp/shared';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogValue = string | number | boolean | null | undefined;
type LogAttributes = Record<string, LogValue>;

export type ProvisionTelemetryContext = {
  requestId?: string;
  journeyId?: string;
  attemptId?: string;
  bootSessionId?: string;
};

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function getProvisionTelemetryContext(req: IncomingMessage): ProvisionTelemetryContext {
  return {
    requestId: header(req, 'x-request-id'),
    journeyId: header(req, 'x-first-chat-journey-id'),
    attemptId: header(req, 'x-first-chat-attempt-id'),
    bootSessionId: header(req, 'x-boot-session-id'),
  };
}

export function bindProvisionSentryContext(
  req: IncomingMessage,
  userId?: string,
  characterId?: string
): ProvisionTelemetryContext {
  const context = getProvisionTelemetryContext(req);
  const scope = Sentry.getIsolationScope();
  scope.setTag('service', 'sync-engine');
  if (context.requestId) scope.setTag('request_id', context.requestId);
  if (context.journeyId) scope.setTag('journey_id', context.journeyId);
  if (context.attemptId) scope.setTag('attempt_id', context.attemptId);
  if (context.bootSessionId) scope.setTag('boot_session_id', context.bootSessionId);
  if (userId) scope.setTag('miniapp_user_id', userId);
  if (characterId) scope.setTag('character_id', characterId);
  scope.setContext('request_correlation', {
    ...context,
    miniappUserId: userId,
    characterId,
  });
  return context;
}

export function sendSyncSentryLog(
  level: LogLevel,
  eventName: string,
  attributes: LogAttributes = {}
): void {
  Sentry.logger[level](
    eventName,
    sanitizeTelemetry({
      service: 'sync-engine',
      event_name: eventName,
      ...attributes,
    })
  );
}

export function captureSyncException(
  error: unknown,
  req: IncomingMessage,
  stage: string,
  attributes: LogAttributes = {}
): void {
  Sentry.withScope((scope) => {
    const context = getProvisionTelemetryContext(req);
    scope.setTag('service', 'sync-engine');
    scope.setTag('stage', stage);
    if (context.requestId) scope.setTag('request_id', context.requestId);
    if (context.journeyId) scope.setTag('journey_id', context.journeyId);
    if (context.attemptId) scope.setTag('attempt_id', context.attemptId);
    for (const [name, value] of Object.entries(attributes)) {
      if (value !== undefined && value !== null) scope.setTag(name, String(value));
    }
    scope.setContext('first_chat', sanitizeTelemetry({ ...context, stage, ...attributes }));
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
  });
}
