import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions, foundationLoggerOptions } from './logger.js';
import { newContext, withContext } from '../platform/observability/context.js';

describe('Pino compatibility safety', () => {
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
});
