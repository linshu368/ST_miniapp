import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

vi.mock('@sentry/node', () => ({
  getTraceData: () => ({
    'sentry-trace': 'trace-id-span-id-1',
    baggage: 'sentry-environment=development',
  }),
  getIsolationScope: () => ({
    setTag: vi.fn(),
    setContext: vi.fn(),
    setUser: vi.fn(),
  }),
  withScope: vi.fn(),
  captureException: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { downstreamTelemetryHeaders, getRequestTelemetryContext } from './sentry.js';

function request(): FastifyRequest {
  return {
    id: 'request-1',
    headers: {
      'x-first-chat-journey-id': 'journey-1',
      'x-first-chat-attempt-id': 'attempt-1',
      'x-boot-session-id': 'boot-1',
    },
  } as unknown as FastifyRequest;
}

describe('backend Sentry request correlation', () => {
  it('extracts and propagates trace plus business correlation headers', () => {
    expect(getRequestTelemetryContext(request())).toEqual({
      requestId: 'request-1',
      journeyId: 'journey-1',
      attemptId: 'attempt-1',
      bootSessionId: 'boot-1',
    });
    expect(downstreamTelemetryHeaders(request())).toEqual({
      'X-Request-Id': 'request-1',
      'X-First-Chat-Journey-Id': 'journey-1',
      'X-First-Chat-Attempt-Id': 'attempt-1',
      'X-Boot-Session-Id': 'boot-1',
      'sentry-trace': 'trace-id-span-id-1',
      baggage: 'sentry-environment=development',
    });
  });
});
