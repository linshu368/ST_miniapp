'use client';

import * as Sentry from '@sentry/nextjs';

import { createLogger } from '@/lib/logger';

import { getMetricDimensions, getNetworkTags } from './env-tags';
import { notifySettled, snapshotInflight, trackRequestEnd, trackRequestStart } from './inflight';
import { toRouteTemplate } from './route-template';

const log = createLogger('perf');

/** 初值（design §3.1），跑出基线后再调。 */
export const SLOW_REQUEST_MS = 3_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** 同一 route+结果 每分钟最多上报一条事件，防止弱网下刷屏；指标不受限。 */
const EVENT_MIN_INTERVAL_MS = 60_000;

export type RequestOutcome =
  | 'ok'
  | 'http_4xx'
  | 'http_5xx'
  | 'timeout'
  | 'network'
  | 'invalid_response';

export class RequestTimeoutError extends Error {
  constructor(
    readonly route: string,
    readonly timeoutMs: number
  ) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function outcomeForStatus(status: number): RequestOutcome {
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'ok';
}

const lastEventAt = new Map<string, number>();

function shouldEmitEvent(key: string, now: number): boolean {
  const last = lastEventAt.get(key);
  if (last !== undefined && now - last < EVENT_MIN_INTERVAL_MS) return false;
  lastEventAt.set(key, now);
  return true;
}

interface TimingReport {
  requestId: string;
  route: string;
  method: string;
  outcome: RequestOutcome;
  durationMs: number;
  status?: number;
}

function reportHeaders(route: string, method: string, durationMs: number, status: number): void {
  try {
    Sentry.metrics.distribution('api.headers.duration', durationMs, {
      unit: 'millisecond',
      attributes: {
        route,
        method,
        outcome: outcomeForStatus(status),
        ...getMetricDimensions(),
      },
    });
  } catch (error) {
    log.warn('request headers timing report failed', error);
    try {
      Sentry.metrics.count('perf.instrument_error', 1, {
        attributes: { side: 'frontend', stage: 'request_headers_timing' },
      });
    } catch {
      // 放弃。
    }
  }
}

function reportRequest(report: TimingReport): void {
  try {
    const { requestId, route, method, outcome, durationMs, status } = report;
    const slow = durationMs >= SLOW_REQUEST_MS;

    Sentry.metrics.distribution('api.request.duration', durationMs, {
      unit: 'millisecond',
      attributes: { route, method, outcome, ...getMetricDimensions() },
    });
    notifySettled({ route, durationMs, slow, outcome });

    if (!slow && outcome === 'ok') return;
    // 4xx 是业务拒绝（未登录、余额不足…），不算「卡」，只靠指标看。
    if (!slow && outcome === 'http_4xx') return;
    if (!shouldEmitEvent(`${route}:${outcome}`, Date.now())) return;

    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setFingerprint(['slow_request', route, outcome]);
      scope.setTags({ perf_event: 'slow_request', route, outcome, ...getNetworkTags() });
      scope.setContext('request_timing', {
        requestId,
        durationMs: Math.round(durationMs),
        status,
        inflightCount: snapshotInflight().length,
      });
      Sentry.captureMessage('slow_request');
    });
  } catch (error) {
    // 监控自己出错不能影响请求；计数以便发现「监控静默失效」。
    log.warn('request timing report failed', error);
    try {
      Sentry.metrics.count('perf.instrument_error', 1, {
        attributes: { side: 'frontend', stage: 'request_timing' },
      });
    } catch {
      // 放弃。
    }
  }
}

export interface TimedFetchMeta {
  requestId: string;
  timeoutMs?: number;
}

/**
 * 统一覆盖 fetch 与响应消费的超时/耗时边界。consumer 必须完成 body 读取、解析和
 * envelope 校验；在它 settle 前 timeout 与 inflight 都保持有效。调用方主动取消不算失败。
 */
export async function timedFetch<T>(
  url: string,
  init: RequestInit,
  meta: TimedFetchMeta,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const route = toRouteTemplate(url.replace(/^https?:\/\/[^/]+/, ''));
  const method = (init.method ?? 'GET').toUpperCase();
  const timeoutMs = meta.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const controller = new AbortController();
  const external = init.signal;
  const abortFromCaller = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) abortFromCaller();
    else external.addEventListener('abort', abortFromCaller, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const startedAt = performance.now();
  let responseStatus: number | undefined;
  trackRequestStart(meta.requestId, route);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    responseStatus = response.status;
    reportHeaders(route, method, performance.now() - startedAt, response.status);
    const result = await consume(response);
    reportRequest({
      requestId: meta.requestId,
      route,
      method,
      outcome: outcomeForStatus(response.status),
      durationMs: performance.now() - startedAt,
      status: response.status,
    });
    return result;
  } catch (error) {
    if (timedOut) {
      reportRequest({
        requestId: meta.requestId,
        route,
        method,
        outcome: 'timeout',
        durationMs: performance.now() - startedAt,
      });
      throw new RequestTimeoutError(route, timeoutMs);
    }
    if (!external?.aborted) {
      reportRequest({
        requestId: meta.requestId,
        route,
        method,
        outcome:
          responseStatus === undefined
            ? 'network'
            : responseStatus >= 400
              ? outcomeForStatus(responseStatus)
              : 'invalid_response',
        durationMs: performance.now() - startedAt,
        status: responseStatus,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abortFromCaller);
    trackRequestEnd(meta.requestId);
  }
}
