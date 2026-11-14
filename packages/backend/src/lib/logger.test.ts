import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions, foundationLoggerOptions } from './logger.js';
import { bindBusinessContext, newContext, withContext } from '../platform/observability/context.js';
import {
  safeLogAttributes,
  safeLogRecord,
  validatedDramaLog,
} from '../platform/observability/safe-log.js';
import { safeError } from '../platform/observability/events.js';

describe('Pino compatibility safety', () => {
  it('keeps growth/community summaries and extended object IDs through JSON and excludes telemetry IDs', () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
    const id = '11111111-1111-4111-8111-111111111111';
    const ids = {
      conversationId: id,
      attemptId: id,
      workId: id,
      artifactId: id,
      messageId: id,
      imageId: id,
      audioId: id,
    };
    log.info({
      event: 'growth.prompt.event',
      kind: 'biz',
      prompt_kind: 'vip',
      recorded: false,
      community_prompt: true,
      vip_prompt: false,
      rewarded: true,
      with_button: false,
      ...ids,
      prompts: ['private'],
      text: 'private',
    });
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      kind: 'biz',
      prompt_kind: 'vip',
      recorded: false,
      community_prompt: true,
      vip_prompt: false,
      rewarded: true,
      with_button: false,
      image_conversation_id: id,
      attempt_id: id,
      work_id: id,
      artifact_id: id,
      message_id: id,
      image_id: id,
      audio_id: id,
    });
    expect(record).not.toHaveProperty('session_id');
    expect(lines[0]).not.toContain('private');
    expect(safeLogAttributes(ids)).toEqual({});
  });
  it('writes canonical business identifiers into physical JSON without leaking private fields', () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
    const userId = '11111111-1111-4111-8111-111111111111';
    const objectId = '22222222-2222-4222-8222-222222222222';
    const context = newContext('business-request');
    withContext(context, () => {
      bindBusinessContext({
        user_id: userId,
        telegram_user_id: '123456',
        business_module: 'creator',
      });
      log.child({ characterId: objectId }).child({ creationId: objectId }).info({
        event: 'creator.saved',
        sessionId: objectId,
        user_id: objectId,
        email: 'private-email',
        username: 'private-name',
        initData: 'private-init',
        token: 'private-token',
      });
    });
    log.info({
      event: 'drama.play',
      dramaId: objectId,
      videoId: objectId,
      sessionId: 'private-session',
      userId: 123456,
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      user_id: userId,
      telegram_user_id: '123456',
      business_module: 'creator',
      character_id: objectId,
      creation_id: objectId,
      session_id: objectId,
      trace_id: context.trace_id,
      request_id: 'business-request',
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ drama_id: objectId, video_id: objectId });
    expect(JSON.parse(lines[1]!)).not.toHaveProperty('user_id');
    expect(JSON.parse(lines[1]!)).not.toHaveProperty('session_id');
    expect(lines.join('')).not.toContain('private');
    expect(lines.join('')).not.toContain('[REDACTED]');
    expect(
      safeLogAttributes({ user_id: userId, sessionId: objectId, telegram_user_id: '123456' })
    ).toEqual({});
  });
  it('retains bounded diagnostic codes and causes through physical JSON output', () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
    const databaseError = { code: '23505', message: 'private-query', details: 'private-params' };
    log.error({ event: 'db.failed', err: databaseError });
    const error = Object.assign(new Error('private-error', { cause: databaseError }), {
      code: 'ECONNRESET',
    });
    error.stack = 'Error: private-error\n    at run (D:/private/source.ts:10:2)';
    log.error({ event: 'operation.terminal', error: safeError(error) });
    log.info({
      event: 'free_zone.evaluated',
      candidateCount: 5,
      listedCount: 3,
      missingMarketCount: 2,
      probeCount: 8,
      unroutableProbeCount: 4,
      skippedChangedCount: 1,
    });
    expect(JSON.parse(lines[0]!).err.code).toBe('23505');
    expect(JSON.parse(lines[1]!).error).toMatchObject({
      code: 'ECONNRESET',
      cause: { code: '23505' },
    });
    expect(JSON.parse(lines[1]!).error.stack).toContain('source.ts:10:2');
    expect(JSON.parse(lines[2]!)).toMatchObject({
      candidateCount: 5,
      listedCount: 3,
      missingMarketCount: 2,
      probeCount: 8,
      unroutableProbeCount: 4,
      skippedChangedCount: 1,
    });
    expect(lines.join('')).not.toContain('private');
    expect(safeError({ code: 'private-unknown-code', message: 'private' })).not.toHaveProperty(
      'code'
    );
  });

  it('filters nested child bindings and later additions without mutating the parent', () => {
    const lines: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output);
    const child = log.child({ module: 'test', arbitraryPayload: { text: 'private-child' } });
    child.setBindings({ reqId: 'child-request', customContent: 'private-addition' });
    child.child({ kind: 'sys', prompt: 'private-nested' }, { level: 'warn' }).warn({
      event: 'test.child',
    });
    child.info({ event: 'test.parent' });
    log.info({ event: 'test.root' });
    expect(lines.join('')).not.toContain('private');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      module: 'test',
      kind: 'sys',
      reqId: 'child-request',
      event: 'test.child',
    });
    expect(JSON.parse(lines[1] ?? '{}')).not.toHaveProperty('kind');
    expect(JSON.parse(lines[2] ?? '{}')).not.toHaveProperty('reqId');
  });

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
