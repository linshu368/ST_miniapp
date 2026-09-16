/**
 * backend / infrastructure / telemetry / posthog-capture.ts
 *
 * Node 22 原生 fetch 调 PostHog capture。不为非关键事件引入 posthog-node。
 * 配置来自 platform/config.ts（进程环境密钥），不是 runtime_config 表。
 */
import {
  isForbiddenTelemetryPropertyKey,
  parseReplayTelemetryEvent,
  type ReplayTelemetryEvent,
} from '@miniapp/shared';
import { config } from '../../platform/config.js';

export type PosthogCaptureLogger = {
  biz: { info: (obj: object, msg?: string) => void };
  sys: {
    warn: (obj: object, msg?: string) => void;
    error: (obj: object, msg?: string) => void;
  };
};

export type PosthogCaptureConfig = {
  apiKey: string;
  host: string;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 3000;
const seenPaymentTerminalKeys = new Set<string>();

export function getPosthogCaptureConfig(): PosthogCaptureConfig {
  return config.posthog;
}

export function resetPosthogCaptureDedupeForTests(): void {
  seenPaymentTerminalKeys.clear();
}

export function resolvePosthogCaptureUrl(host: string): string | null {
  try {
    const url = new URL(host);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.pathname === '/' || url.pathname === '') {
      return `${url.origin}/i/v0/e/`;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function isPosthogCaptureConfigured(
  getConfig: () => PosthogCaptureConfig = getPosthogCaptureConfig
): boolean {
  const cfg = getConfig();
  return cfg.apiKey.trim().length > 0 && resolvePosthogCaptureUrl(cfg.host) !== null;
}

function paymentTerminalDedupe(
  event: ReplayTelemetryEvent
): { key: string; orderId: string } | null {
  if (event.event !== 'payment_order_settled' && event.event !== 'payment_order_failed') {
    return null;
  }
  return {
    key: `${event.order_id}:${event.order_status}:${event.settled_by ?? ''}`,
    orderId: event.order_id,
  };
}

function toPosthogProperties(event: ReplayTelemetryEvent): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...event };
  delete properties.event;
  for (const key of Object.keys(properties)) {
    if (isForbiddenTelemetryPropertyKey(key)) {
      throw new Error('telemetry event contains a forbidden property');
    }
  }
  return properties;
}

function resolveTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

export async function captureReplayTelemetryEvent(
  event: ReplayTelemetryEvent,
  log: PosthogCaptureLogger,
  deps: {
    fetchImpl?: typeof fetch;
    getConfig?: () => PosthogCaptureConfig;
  } = {}
): Promise<'sent' | 'skipped' | 'failed'> {
  const getConfig = deps.getConfig ?? getPosthogCaptureConfig;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cfg = getConfig();
  const apiKey = cfg.apiKey.trim();
  const captureUrl = resolvePosthogCaptureUrl(cfg.host);

  if (!apiKey || !captureUrl) {
    return 'skipped';
  }

  const parsed = parseReplayTelemetryEvent(event);
  if (!parsed.telegram_user_id) {
    log.sys.warn(
      { event: 'posthog.capture.missing_identity', telemetryEvent: parsed.event },
      'PostHog capture 缺少 telegram_user_id，跳过'
    );
    return 'skipped';
  }

  const dedupe = paymentTerminalDedupe(parsed);
  if (dedupe && seenPaymentTerminalKeys.has(dedupe.key)) {
    log.biz.info(
      {
        event: 'posthog.capture.deduped',
        telemetryEvent: parsed.event,
        orderId: dedupe.orderId,
      },
      'PostHog 终态事件已发送过，跳过'
    );
    return 'skipped';
  }

  const startedAt = Date.now();
  try {
    const response = await fetchImpl(captureUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: parsed.event,
        distinct_id: parsed.telegram_user_id,
        timestamp: parsed.occurred_at,
        properties: toPosthogProperties(parsed),
      }),
      signal: AbortSignal.timeout(resolveTimeoutMs(cfg.timeoutMs)),
    });
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      log.sys.warn(
        {
          event: 'posthog.capture.http_error',
          telemetryEvent: parsed.event,
          status: response.status,
          durationMs,
        },
        'PostHog capture 非 2xx'
      );
      return 'failed';
    }
    if (dedupe) seenPaymentTerminalKeys.add(dedupe.key);
    log.biz.info(
      {
        event: 'posthog.capture.sent',
        telemetryEvent: parsed.event,
        durationMs,
      },
      'PostHog capture 已发送'
    );
    return 'sent';
  } catch (err) {
    log.sys.error(
      {
        event: 'posthog.capture.failed',
        err,
        telemetryEvent: parsed.event,
        durationMs: Date.now() - startedAt,
      },
      'PostHog capture 失败'
    );
    return 'failed';
  }
}
