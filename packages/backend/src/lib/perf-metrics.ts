/**
 * 体验监控的后端指标（design: .trellis/tasks/10-21-sentry-ux-monitoring/design.md §5）。
 *
 * 指标走 Sentry Metrics 而不是 span：trace 会按比例采样，p95/p99 必须全量。
 * 所有埋点失败都只计数、不抛——监控不能影响业务请求。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as Sentry from '@sentry/node';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { observeHttp, observeDb, observeRuntime } from './engineering-observability.js';

/** 初值，跑出基线后再调。 */
const SLOW_REQUEST_MS = 3_000;
const RUNTIME_SAMPLE_INTERVAL_MS = 10_000;

/**
 * 对话/语音/图片生成本身就是几十秒的大模型调用，和普通接口混在一起会把 p95 拉成噪声。
 * 以路由模板（而非 URL）精确匹配，避免新增接口被误归类。
 */
const GENERATION_ROUTES = new Set([
  'POST /api/v1/conversations/:id/messages',
  'POST /api/v1/conversations/:id/regenerate',
  'POST /api/v1/conversations/:sessionId/messages/:messageId/image',
  'POST /api/v1/conversations/:sessionId/messages/:messageId/image-description',
  'POST /api/v1/conversations/:sessionId/messages/:messageId/voice',
  'POST /api/image-plaza/conversations/:conversationId/attempts',
]);

const sentryFirstTokenReplies = new WeakSet<FastifyReply>();

export type RequestKind = 'standard' | 'generation';

export function classifyRequest(method: string, routeTemplate: string): RequestKind {
  return GENERATION_ROUTES.has(`${method} ${routeTemplate}`) ? 'generation' : 'standard';
}

export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

function countInstrumentError(stage: string): void {
  try {
    Sentry.metrics.count('perf.instrument_error', 1, { attributes: { side: 'backend', stage } });
  } catch {
    // 连计数都失败就放弃，不能让监控反过来影响业务。
  }
}

function recordSentryDuration(
  metric: 'http.server.duration' | 'sse.stream.duration',
  input: {
    route: string;
    method: string;
    status: number;
    durationMs: number;
    responseMilestone?: 'first_visible_token' | 'terminal_without_visible_token';
  }
): void {
  try {
    Sentry.metrics.distribution(metric, input.durationMs, {
      unit: 'millisecond',
      attributes: {
        route: input.route,
        method: input.method,
        status_class: statusClass(input.status),
        kind: classifyRequest(input.method, input.route),
        ...(input.responseMilestone ? { response_milestone: input.responseMilestone } : {}),
      },
    });
  } catch {
    countInstrumentError(
      metric === 'sse.stream.duration' ? 'sse_stream_duration' : 'http_server_duration'
    );
  }
}

/**
 * Sentry 的通用 onResponse 会等 SSE 完整结束；聊天接口的“响应”改以首个成功写出的
 * 可见 token 为准。终态兜底确保上游拒绝、超时和断连请求不会从样本中消失。
 */
export function startSseResponseMetric(
  reply: FastifyReply,
  route: string,
  startedAt = performance.now()
): { firstVisibleToken(): void; finish(status: number): void } {
  sentryFirstTokenReplies.add(reply);
  let recorded = false;

  const record = (
    responseMilestone: 'first_visible_token' | 'terminal_without_visible_token',
    status: number
  ): void => {
    if (recorded) return;
    recorded = true;
    recordSentryDuration('http.server.duration', {
      route,
      method: 'POST',
      status,
      durationMs: performance.now() - startedAt,
      responseMilestone,
    });
  };

  return {
    firstVisibleToken: () => record('first_visible_token', 200),
    finish: (status) => record('terminal_without_visible_token', status),
  };
}

export function registerRequestPerf(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    // 复用同一次测量，Grafana 与 Sentry 故障隔离，不新增请求 hook。
    const route = request.routeOptions?.url ?? 'unmatched';
    if (route === '/health') return;
    const method = request.method;
    const durationMs = reply.elapsedTime;
    const kind = classifyRequest(method, route);
    observeHttp({ route, method, durationMs, kind, statusClass: statusClass(reply.statusCode) });
    try {
      // 聊天 SSE 的接口响应已在首字处记账，这里只保留完整流耗时供生成长尾诊断。
      recordSentryDuration(
        sentryFirstTokenReplies.has(reply) ? 'sse.stream.duration' : 'http.server.duration',
        { route, method, status: reply.statusCode, durationMs }
      );

      // 与 Railway 日志对照用：只写允许的字段，不含 body/header/token。
      if (kind === 'standard' && durationMs >= SLOW_REQUEST_MS) {
        request.log.warn(
          { route, method, status: reply.statusCode, durationMs: Math.round(durationMs) },
          'slow request'
        );
      }
    } catch {
      // recordSentryDuration 已隔离 SDK 错误；保留边界，防止后续日志逻辑影响响应。
      countInstrumentError('request_perf_hook');
    }
  });
}

/**
 * 事件循环延迟 + 内存：用来区分「请求慢是在排队/被阻塞，还是下游慢」。
 * 返回停止函数，供 onClose 调用。
 */
export function startRuntimeMetrics(): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    const loopDelayMs = histogram.percentile(99) / 1e6;
    const rss = process.memoryUsage().rss;
    observeRuntime(loopDelayMs, rss);
    try {
      // histogram 单位是纳秒。
      Sentry.metrics.gauge('runtime.event_loop_delay_p99', loopDelayMs, {
        unit: 'millisecond',
      });
      Sentry.metrics.gauge('runtime.rss', rss, { unit: 'byte' });
    } catch {
      countInstrumentError('runtime');
    } finally {
      histogram.reset();
    }
  }, RUNTIME_SAMPLE_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

/**
 * Prisma 操作耗时：测的是「调用方等了多久」，包含等连接池的时间，
 * 所以连接池排队会直接体现在这里；查询本身慢则看 DB span。
 * 连接池超时（P2024）单独标成 pool_timeout，是定位卡顿的关键信号。
 */
export async function measureDbOperation<T>(
  model: string,
  operation: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  let outcome = 'ok';
  try {
    return await run();
  } catch (err) {
    outcome = (err as { code?: string } | null)?.code === 'P2024' ? 'pool_timeout' : 'error';
    throw err;
  } finally {
    const durationMs = performance.now() - startedAt;
    observeDb({ model, operation, outcome, durationMs });
    try {
      Sentry.metrics.distribution('db.client.operation.duration', durationMs, {
        unit: 'millisecond',
        attributes: { model, operation, outcome },
      });
    } catch {
      countInstrumentError('db_operation');
    }
  }
}
