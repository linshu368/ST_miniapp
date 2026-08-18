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

import { getRequestTelemetryContext } from './sentry.js';

function request(): FastifyRequest {
  return {
    id: 'request-1',
    headers: {},
  } as unknown as FastifyRequest;
}

describe('backend Sentry request correlation', () => {
  it('extracts the request id as the only correlation key', () => {
    expect(getRequestTelemetryContext(request())).toEqual({
      requestId: 'request-1',
    });
  });
});
