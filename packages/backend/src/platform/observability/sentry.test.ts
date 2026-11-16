import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import * as Sentry from '@sentry/node';

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

import {
  getRequestTelemetryContext,
  sendBackendSentryLog,
  captureBackendException,
} from './sentry.js';
import { safeSentryEvent, safeSentryLog } from './sentry-safety.js';

function request(): FastifyRequest {
  return {
    id: 'request-1',
    headers: {},
  } as unknown as FastifyRequest;
}

describe('backend Sentry request correlation', () => {
  it('does not export Railway business identifiers in tags, breadcrumbs, spans or logs', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const fields = {
      user_id: id,
      characterId: id,
      session_id: id,
      creation_id: id,
      drama_id: id,
      video_id: id,
      telegram_user_id: '123456',
    };
    const event = safeSentryEvent({
      tags: fields,
      breadcrumbs: [{ data: fields }],
      spans: [
        { span_id: 'span', trace_id: 'trace', start_timestamp: 1, timestamp: 2, data: fields },
      ],
    });
    const log = safeSentryLog({ level: 'info', message: 'test', attributes: fields });
    expect(JSON.stringify({ event, log })).not.toContain(id);
    expect(JSON.stringify({ event, log })).not.toContain('123456');
  });
  it('isolates SDK failures from business execution', () => {
    vi.mocked(Sentry.logger.error).mockImplementationOnce(() => {
      throw new Error('sdk failure');
    });
    vi.mocked(Sentry.withScope).mockImplementationOnce(() => {
      throw new Error('sdk failure');
    });
    expect(() => sendBackendSentryLog('error', 'request.failed')).not.toThrow();
    expect(() =>
      captureBackendException(new Error('original'), request(), 'request')
    ).not.toThrow();
  });
  it('removes automatic request/exception/breadcrumb/log payloads at the output boundary', () => {
    const event = safeSentryEvent({
      message: 'private-message',
      request: { data: 'private-body', url: 'https://private-url' },
      user: { id: 'private-user' },
      extra: { provider: 'private-response' },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'private-error',
            stacktrace: {
              frames: [
                {
                  filename: '/private-path/source.ts',
                  lineno: 12,
                  colno: 3,
                  context_line: 'private-code',
                },
              ],
            },
          },
        ],
      },
      breadcrumbs: [{ message: 'private-breadcrumb', data: { body: 'private-body' } }],
    });
    expect(JSON.stringify(event)).not.toContain('private');
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({
      filename: 'source.ts',
      lineno: 12,
    });
    const log = safeSentryLog({
      level: 'error',
      message: 'private message',
      attributes: { body: 'private-body', event: 'payment.failed' },
    });
    expect(JSON.stringify(log)).not.toContain('private');
  });
  it('extracts the request id as the only correlation key', () => {
    expect(getRequestTelemetryContext(request())).toEqual({
      requestId: 'request-1',
    });
  });
});
