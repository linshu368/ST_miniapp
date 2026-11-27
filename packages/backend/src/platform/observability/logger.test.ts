import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions, foundationLoggerOptions } from './logger.js';
import { bindBusinessContext, newContext, withContext } from './context.js';
import { safeLogAttributes, safeLogRecord, validatedDramaLog } from './safe-log.js';
import { safeError } from './events.js';
import { chineseLogCatalog } from './labels.zh-CN.js';
import { createJobObservation } from './job-core.js';
import { createObserver } from './core.js';
import { detailDiagnostics } from '../../routes/conversation-detail-diagnostics.js';
import { safeFields } from './events.js';
import { receiptDiagnostics } from '../../routes/conversation-receipt-diagnostics.js';

function captureLogs() {
  const lines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return {
    lines,
    log: pino({ ...fastifyLoggerOptions(), level: 'info', transport: undefined }, output),
  };
}

describe('Railway readable summaries', () => {
  it('records receipt phases and unknown results in real Pino JSON without changing errors', async () => {
    const { log, lines } = captureLogs();
    const diagnostic = receiptDiagnostics(log);
    await diagnostic.measure('identity', async () => 'not logged');
    const original = new Error('private receipt data');
    await expect(
      diagnostic.measure('first_token', async () => {
        throw original;
      })
    ).rejects.toBe(original);
    diagnostic.failure();
    diagnostic.failure();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'conversation.first_token_receipt',
      outcome: 'unknown',
      outcome_known: false,
      failed_stage: 'first_token',
      identity_ms: expect.any(Number),
      rpc_ms: expect.any(Number),
    });
    expect(lines.join('')).not.toContain('private');
    const success = receiptDiagnostics(log);
    success.success(true);
    const unrecorded = receiptDiagnostics(log);
    unrecorded.success(false);
    expect(JSON.parse(lines[1]!)).toMatchObject({ stage: 'recorded', outcome_known: true });
    expect(JSON.parse(lines[2]!)).toMatchObject({ stage: 'not_recorded', outcome: 'rejected' });
    const broken = receiptDiagnostics(log);
    vi.spyOn(log, 'warn').mockImplementation(() => {
      throw new Error('output unavailable');
    });
    expect(() => broken.failure()).not.toThrow();
  });
  it('keeps logging failures from changing read results or replacing dependency errors', async () => {
    const { log } = captureLogs();
    vi.spyOn(log, 'warn').mockImplementation(() => {
      throw new Error('broken output');
    });
    vi.spyOn(log, 'error').mockImplementation(() => {
      throw new Error('broken output');
    });
    expect(() => detailDiagnostics(log, 'entry', false).success(20, 2)).not.toThrow();
    const diagnostic = detailDiagnostics(log, 'entry', false);
    const original = new Error('dependency failure');
    await expect(
      diagnostic.measure('page', async () => {
        throw original;
      })
    ).rejects.toBe(original);
    expect(() => diagnostic.failure(original, false)).not.toThrow();
  });

  it('uses proven failure kinds in readable summaries instead of treating every abort as user stop', () => {
    const { log, lines } = captureLogs();
    const err = new DOMException('private fixture text', 'AbortError');
    log.info({ event: 'llm.stream.failed', outcome: 'cancelled', failure_kind: 'user_stop', err });
    log.error({
      event: 'llm.stream.failed',
      outcome: 'timed_out',
      failure_kind: 'first_token_timeout',
      err,
    });
    log.error({
      event: 'llm.stream.failed',
      outcome: 'failed',
      failure_kind: 'db_write_failed',
      err,
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      result: '已取消',
      error_message: '用户主动停止生成',
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      result: '超时',
      error_message: '等待生成首字超时',
    });
    expect(JSON.parse(lines[2]!)).toMatchObject({
      result: '失败',
      error_message: '数据库写入失败',
    });
    expect(lines.join('')).not.toContain('private fixture');
  });

  it('prints bounded chat read phases and purpose through real stdout without private nested data', async () => {
    const { log, lines } = captureLogs();
    const diagnostic = detailDiagnostics(log, 'entry', false);
    await diagnostic.measure('owner', async () => undefined);
    await diagnostic.measure('page', async () => undefined);
    const failure = new Error('private fixture content and token');
    diagnostic.failure(failure, false);
    diagnostic.failure(failure, false);
    const record = JSON.parse(lines[0] ?? '{}');
    expect(lines).toHaveLength(1);
    expect(record).toMatchObject({
      event: 'conversation.detail.failed',
      history_page_kind: 'entry',
      read_path: 'parallel',
      failed_stage: 'unknown',
      failure_kind: 'dependency_failed',
    });
    expect(record.owner_ms).toBeGreaterThanOrEqual(0);
    expect(record.page_ms).toBeGreaterThanOrEqual(0);
    expect(lines.join('')).not.toContain('private fixture');
    expect(
      safeFields({ history_page_kind: 'raw-user-content', failed_stage: 'private', sample_rate: 2 })
    ).toEqual({});
  });
  it('retains true story-memory limits and Unicode counts through actual Pino JSON without content', () => {
    const { log, lines } = captureLogs();
    const fields = {
      event: 'story_memory.validation.rejected',
      outcome: 'rejected',
      stage: 'pre_shrink',
      attempt: 1,
      job_attempt: 3,
      chunk_index: 2,
      chunk_count: 4,
      range_start: 20,
      range_end: 24,
      output_chars: 6000,
      hard_max_chars: 5000,
      validation_max_chars: 4250,
      target_chars: 3250,
      over_limit_chars: 1750,
      prompt_chars: 9000,
      history_chars: 0,
      recent_chars: 0,
      old_memory_chars: 8000,
      input_tokens: 100,
      output_tokens: 12000,
      max_output_tokens: 12000,
      response_bytes: 35000,
      max_response_bytes: 262144,
      timeout_ms: 120000,
      finish_reason: 'stop',
      prompt_version: 'v1',
      duration_ms: 120,
    };
    log.warn({
      ...fields,
      content: 'private-archive',
      prompt: 'private-prompt',
      nickname: 'private-name',
      apiKey: 'private-key',
      unexpected_chars: 1,
      inputTokens: 100,
      arbitrary_object: { output_chars: 6000 },
    });
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject(fields);
    expect(row.scenario).toContain('剧情记忆');
    expect(row).not.toHaveProperty('unexpected_chars');
    expect(row).not.toHaveProperty('inputTokens');
    expect(row).not.toHaveProperty('arbitrary_object');
    expect(JSON.stringify(row)).not.toContain('private');
  });
  it('retains rewrite recovery counts, reset flag and fallback model through actual Pino JSON', () => {
    const { log, lines } = captureLogs();
    const fields = {
      event: 'llm.recovery.completed',
      mode: 'rewrite',
      fallback_model: 'deepseek-v4.1-flash-1017',
      outcome: 'completed',
      http_status: 200,
      first_token_ms: 2360,
      duration_ms: 5600,
      added_chars: 677,
      reasoning_chars: 120,
      reset: true,
    };
    log.info({ ...fields, content: 'private-rewrite' });
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject(fields);
    expect(JSON.stringify(row)).not.toContain('private');
  });

  it('retains feed media/version through the actual Pino projection without content', () => {
    const { log, lines } = captureLogs();
    log.info({
      event: 'image_plaza.feed.completed',
      media: 'video',
      ranking_version: 2,
      sort: 'recommended',
      count: 20,
      hasCursor: true,
      durationMs: 123,
      prompt: 'private',
    });
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({ media: 'video', ranking_version: 2, count: 20, hasCursor: true });
    expect(JSON.stringify(row)).not.toContain('private');
  });
  it('names provider and storage operations with their caller scene', () => {
    const { log, lines } = captureLogs();
    log.info({
      event: 'operation.terminal',
      module: 'provider',
      operation: 'provider.venice',
      provider: 'venice',
      call_scene: 'POST:/api/v1/conversations/:id/messages',
      outcome: 'succeeded',
    });
    log.info({
      event: 'operation.terminal',
      module: 'storage',
      operation: 'storage.avatar',
      outcome: 'succeeded',
    });
    const rows = lines.map((line) => JSON.parse(line));
    expect(rows[0].msg).toContain('[模型供应商]');
    expect(rows[0].msg).toContain('发送聊天消息 / 调用 Venice 模型服务');
    expect(rows[0].msg).toContain('供应商：Venice');
    expect(rows[1]).toMatchObject({ module_name: '对象存储', scenario: '读取头像资源' });
  });
  it('keeps overlapping job call scenes isolated through nested child loggers', async () => {
    const { log, lines } = captureLogs();
    const jobs = createJobObservation(createObserver([]));
    await Promise.all(
      ['payment_reconciliation', 'vip_expiry_reminders'].map((job) =>
        jobs.runObservedJob(job, async () => {
          await Promise.resolve();
          log
            .child({ module: 'db' })
            .info({ event: 'operation.terminal', operation: 'db.supabase', outcome: 'succeeded' });
        })
      )
    );
    const rows = lines.map((line) => JSON.parse(line));
    expect(rows.map((row) => row.call_scene).sort()).toEqual([
      'job.payment_reconciliation',
      'job.vip_expiry_reminders',
    ]);
    expect(new Set(rows.map((row) => row.trace_id)).size).toBe(2);
    expect(rows.some((row) => row.msg.includes('支付订单对账'))).toBe(true);
    expect(rows.some((row) => row.msg.includes('会员到期提醒'))).toBe(true);
  });
  it('shows Chinese module/scenario/result and keeps original machine fields and precise duration', () => {
    const { log, lines } = captureLogs();
    withContext({ ...newContext('summary-request'), call_scene: 'GET:/api/vip/status' }, () => {
      bindBusinessContext({ business_module: 'vip' });
      log.child({ module: 'db' }).info(
        {
          event: 'operation.terminal',
          operation: 'db.supabase',
          outcome: 'succeeded',
          resource: 'runtime_config',
          upstream_status: 200,
          duration_ms: 29.581,
          module_name: 'private-module',
          scenario: 'private-scenario',
          error_message: 'private-error',
        },
        'private-message'
      );
    });
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({
      module_name: '会员权益·数据库',
      scenario: '读取会员状态 / 访问 Supabase',
      result: '成功',
      module: 'db',
      operation: 'db.supabase',
      event: 'operation.terminal',
      duration_ms: 29.581,
      call_scene: 'GET:/api/vip/status',
      request_id: 'summary-request',
      upstream_status: 200,
    });
    expect(row.msg).toContain('[会员权益·数据库]');
    expect(row.msg).toContain('30ms');
    expect(row).not.toHaveProperty('error_message');
    expect(lines[0]).not.toContain('private');
  });

  it('describes recognized causes without copying raw error text, stack paths or credentials', () => {
    const { log, lines } = captureLogs();
    const cause = Object.assign(new Error('private-token'), { code: 'ECONNRESET' });
    const err = new Error('private-sql', { cause });
    err.stack = 'Error: private-sql\n    at execute (D:/private/worker.ts:12:3)';
    log.error({
      event: 'payment.probe.failed',
      module: 'payment',
      public_error_code: 'INTERNAL_ERROR',
      err,
    });
    log.error({ event: 'operation.terminal', operation: 'db.supabase', error: safeError(err) });
    for (const line of lines) {
      const row = JSON.parse(line);
      expect(row.error_message).toBe('连接被对端重置');
      expect(row.msg).toContain('连接被对端重置');
      expect(line).not.toContain('private');
    }
    expect(JSON.parse(lines[0]!).err.stack).toContain('worker.ts:12:3');
  });

  it('shows probe and strategy results independently from an HTTP 200 transport result', () => {
    const { log, lines } = captureLogs();
    log.info({
      event: 'payment.probe.completed',
      module: 'payment-availability-probe',
      outcome: 'partial',
      probe_result: 'unavailable',
      paymentType: 'alipay',
      errorClass: 'timeout',
      strategy_failed_count: 1,
      strategy_success_count: 0,
      upstream_status: 200,
      duration_ms: 1200,
    });
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({
      result: '部分失败',
      error_message: '支付上游请求超时',
      probe_result: 'unavailable',
    });
    expect(row.msg).toContain('建单探测不可用');
    expect(row.msg).toContain('渠道：支付宝');
    expect(row.msg).toContain('策略失败:1');
    expect(row.msg).not.toContain('｜成功｜');
  });

  it('does not label generic info, SSE unknown or skipped checks as success', () => {
    const { log, lines } = captureLogs();
    log.info({ event: 'test.event', module: 'new-module' });
    log.info({
      event: 'operation.terminal',
      operation: 'http.request',
      outcome: 'unknown',
      http_status: 200,
    });
    log.info({ event: 'llm.balance.check_skipped', outcome: 'skipped', reason: 'free_round' });
    expect(lines.map((line) => JSON.parse(line).result)).toEqual([
      '已记录',
      '结果未确认',
      '已跳过',
    ]);
    expect(JSON.parse(lines[0]!).msg).toContain('test.event');
    expect(JSON.parse(lines[2]!).msg).toContain('免费轮无需查询钱包');
  });

  it('falls back to a stable event if a display adapter fails', () => {
    const { log, lines } = captureLogs();
    const original = Object.getOwnPropertyDescriptor(chineseLogCatalog, 'events')!;
    try {
      Object.defineProperty(chineseLogCatalog, 'events', {
        configurable: true,
        get() {
          throw new Error('private');
        },
      });
      expect(() => log.info({ event: 'test.fallback' })).not.toThrow();
    } finally {
      Object.defineProperty(chineseLogCatalog, 'events', original);
    }
    expect(JSON.parse(lines[0]!).msg).toBe('test.fallback');
    expect(lines[0]).not.toContain('private');
  });
});

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

it('keeps plaza delivery identity and safe terminal fields in actual Pino JSON', () => {
  const { log, lines } = captureLogs();
  const userId = '11111111-1111-4111-8111-111111111111';
  const attemptId = '22222222-2222-4222-8222-222222222222';
  withContext(newContext(), () => {
    bindBusinessContext({
      business_module: 'image',
      user_id: userId,
      attempt_id: attemptId,
      artifact_id: '33333333-3333-4333-8333-333333333333',
    });
    log.error({
      event: 'operation.terminal',
      operation: 'video.delivery.encode',
      provider: 'cloudflare',
      outcome: 'failed',
      stage: 'encoding',
      apiToken: 'fixture-private-token',
      play_url: 'https://fixture.invalid/private-playback',
      err: new Error('fixture-private-token'),
    });
  });
  const row = JSON.parse(lines[0]!);
  expect(row).toMatchObject({
    business_module: 'image',
    user_id: userId,
    attempt_id: attemptId,
    artifact_id: '33333333-3333-4333-8333-333333333333',
    provider: 'cloudflare',
    stage: 'encoding',
    outcome: 'failed',
  });
  expect(row.trace_id).toBeTruthy();
  expect(lines.join('')).not.toContain('fixture-private-token');
  expect(lines.join('')).not.toContain('private-playback');
});

it.each(['chathistory_sync.balance_rejected', 'chathistory.billing.balance_rejected'])(
  'shows %s as a distinct debit refusal without a wallet payload',
  (event) => {
    const { log, lines } = captureLogs();
    log.info(
      {
        event,
        outcome: 'rejected',
        error_code: 'INSUFFICIENT_BALANCE',
        balanceRejectedCount: 1,
        balance: { main_credits: 123 },
        token: 'private-balance-fixture',
      },
      'private content'
    );
    const record = JSON.parse(lines[0] ?? '{}');
    expect(record).toMatchObject({
      level: 30,
      error_code: 'INSUFFICIENT_BALANCE',
      outcome: 'rejected',
      result: '扣款失败',
      balanceRejectedCount: 1,
      error_message: '星尘余额不足',
    });
    expect(record).not.toHaveProperty('balance');
    expect(lines.join('')).not.toContain('private-balance-fixture');
    expect(lines.join('')).not.toContain('private content');
  }
);

it('keeps an unknown database failure separate from a balance debit refusal', () => {
  const { log, lines } = captureLogs();
  log.error({
    event: 'chathistory_sync.reconcile_failed',
    outcome: 'failed',
    err: new Error('private database detail', { cause: { code: 'P0001' } }),
  });
  const record = JSON.parse(lines[0] ?? '{}');
  expect(record).toMatchObject({ level: 50, result: '失败' });
  expect(record.msg).not.toContain('扣款失败');
  expect(lines.join('')).not.toContain('private database detail');
});
