import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions, foundationLoggerOptions } from './logger.js';
import { newContext, withContext } from '../platform/observability/context.js';
import { safeLogRecord, validatedDramaLog } from '../platform/observability/safe-log.js';

describe('Pino compatibility safety', () => {
  it('retains validated performance diagnostics and rejects extra sensitive report fields', () => {
    const report = {
      type: 'playback',
      phase: 'final',
      id: 'observation-id',
      outcome: 'playing',
      elapsedMs: 1234,
      marks: { first_frame: 1234 },
      stages: {},
      queries: [],
    };
    expect(safeLogRecord({ ...validatedDramaLog(report), body: 'private' })).toMatchObject({
      marks: { first_frame: 1234 },
      queries: [],
      elapsed_ms: 1234,
    });
    expect(() => validatedDramaLog({ ...report, token: 'private' })).toThrow();
  });
  it('sanitizes Error-derived messages and causes and adds active correlation to child loggers', () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
    const context = newContext('safe-request');
    const err = new Error('private-content', { cause: new Error('private-content') });
    withContext(context, () => {
      log.child({ module: 'test' }).error({ err }, err.message);
      log.error(err);
    });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('private-content');
      expect(JSON.parse(line)).toMatchObject({
        request_id: 'safe-request',
        trace_id: context.trace_id,
      });
    }
  });

  it('keeps foundation events enabled outside tests regardless of diagnostic log level', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(foundationLoggerOptions().level).toBe('info');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('drops legacy DTOs, child-bound personal fields and interpolated message data', () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
    log.child({ module: 'payment', userId: 'private-user' }).error(
      {
        event: 'payment.failed',
        body: { arbitrary: 'private-body' },
        url: 'https://private-url',
        err: new Error('private-error'),
        durationMs: 25,
      },
      'private-message'
    );
    log.info('private-unstructured');
    expect(lines.join('')).not.toContain('private');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'payment.failed',
      module: 'payment',
      durationMs: 25,
    });
  });
});
