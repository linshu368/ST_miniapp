/** 非权威工程遥测；不注册全局 tracer，不替代生成/交付/计费数据库事实。 */
import { ROOT_CONTEXT, type Attributes } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type SdkLogRecord,
} from '@opentelemetry/sdk-logs';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

export interface EngineeringTelemetryConfig {
  enabled: boolean;
  endpoint: string;
  environment: string;
  version: string;
}

const MAX_LOG_QUEUE = 256;
const EXPORT_TIMEOUT_MS = 2_000;
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 10, 20, 40, 60, 120,
];
const LABEL_VALUES = new Map<string, Set<string>>();
const SAFE_KEY = /^[a-zA-Z0-9_./:*-]{1,120}$/;
type MetricAttributes = Record<string, string | number | boolean>;

/** 模板/模型来自应用目录，仍限制不同值数量，防止意外把 ID 当标签。 */
function boundedLabel(kind: string, value: string, limit: number): string {
  if (!SAFE_KEY.test(value) || /[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(value)) return 'unknown';
  let values = LABEL_VALUES.get(kind);
  if (!values) LABEL_VALUES.set(kind, (values = new Set()));
  if (values.has(value)) return value;
  if (values.size >= limit) return 'other';
  values.add(value);
  return value;
}

export function engineeringRoute(route: string): string {
  return route.startsWith('/api/') ? boundedLabel('route', route, 256) : 'unmatched';
}

function identity(input: { provider: string; model: string }): MetricAttributes {
  return {
    platform:
      input.provider === 'openrouter' || input.provider === 'venice' ? input.provider : 'unknown',
    model: boundedLabel('model', input.model, 64),
  };
}

let active: ReturnType<typeof createTelemetry> | undefined;
let users = 0;

/** 配置只在启动解析；未开启时不创建 exporter、队列或连接。 */
export function startEngineeringTelemetry(
  options?: EngineeringTelemetryConfig
): () => Promise<void> {
  if (!options?.enabled) return async () => {};
  try {
    active ??= createTelemetry(options);
    users++;
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      if (--users > 0) return;
      const previous = active;
      active = undefined;
      await previous?.shutdown();
    };
  } catch {
    // 配置已预校验；SDK 初始化故障也不能令应用不可用。
    return async () => {};
  }
}

function createTelemetry(options: EngineeringTelemetryConfig) {
  const health = {
    logQueued: 0,
    logDropped: 0,
    logFailed: 0,
    metricFailed: 0,
    instrumentFailed: 0,
  };
  class MetricsExporter extends OTLPMetricExporter {
    override export(
      data: Parameters<OTLPMetricExporter['export']>[0],
      callback: Parameters<OTLPMetricExporter['export']>[1]
    ) {
      super.export(data, (result) => {
        if (result.code !== 0) health.metricFailed++;
        callback(result);
      });
    }
  }
  class LogsExporter extends OTLPLogExporter {
    override export(
      records: Parameters<OTLPLogExporter['export']>[0],
      callback: Parameters<OTLPLogExporter['export']>[1]
    ) {
      health.logQueued = Math.max(0, health.logQueued - records.length);
      super.export(records, (result) => {
        if (result.code !== 0) health.logFailed += records.length;
        callback(result);
      });
    }
  }
  // 与 SDK 队列同界限的入口计数，明确区分排队溢出与发送失败；不接管应用 Pino。
  class LogsProcessor extends BatchLogRecordProcessor {
    override onEmit(record: SdkLogRecord) {
      if (health.logQueued >= MAX_LOG_QUEUE) {
        health.logDropped++;
        return;
      }
      health.logQueued++;
      super.onEmit(record);
    }
  }
  const resource = resourceFromAttributes({
    'service.name': 'st-miniapp-backend',
    'service.namespace': 'st-miniapp',
    'deployment.environment.name': options.environment,
    'service.version': boundedLabel('version', options.version, 8),
  });
  const commonAttributes = {
    environment: options.environment,
    release: boundedLabel('version', options.version, 8),
  };
  const endpoint = options.endpoint.replace(/\/$/, '');
  const meterProvider = new MeterProvider({
    resource,
    views: [{ instrumentName: 'st_*', aggregationCardinalityLimit: 2_000 }],
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new MetricsExporter({
          url: `${endpoint}/v1/metrics`,
          timeoutMillis: EXPORT_TIMEOUT_MS,
          concurrencyLimit: 1,
        }),
        exportIntervalMillis: 15_000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    forceFlushTimeoutMillis: EXPORT_TIMEOUT_MS,
    logRecordLimits: { attributeCountLimit: 20, attributeValueLengthLimit: 120 },
    processors: [
      new LogsProcessor({
        exporter: new LogsExporter({
          url: `${endpoint}/v1/logs`,
          timeoutMillis: EXPORT_TIMEOUT_MS,
          concurrencyLimit: 1,
        }),
        maxQueueSize: MAX_LOG_QUEUE,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 1_000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });
  const meter = meterProvider.getMeter('st-miniapp-engineering', '1');
  const logger = loggerProvider.getLogger('st-miniapp-engineering', '1');
  const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();
  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();
  const healthMetric = meter.createObservableCounter('st_telemetry_failures', {
    description: 'Process-local failures, not a complete delivery guarantee',
  });
  healthMetric.addCallback((result) => {
    for (const [reason, count] of Object.entries(health)) {
      if (reason !== 'logQueued') result.observe(count, { ...commonAttributes, reason });
    }
  });
  meter
    .createObservableGauge('st_telemetry_log_queue')
    .addCallback((result) => result.observe(health.logQueued, commonAttributes));
  const guarded = (run: () => void) => {
    try {
      run();
    } catch {
      health.instrumentFailed++;
    }
  };
  return {
    duration(name: string, ms: number, attrs: Attributes) {
      guarded(() => {
        if (!Number.isFinite(ms) || ms < 0) return;
        let instrument = histograms.get(name);
        if (!instrument) {
          instrument = meter.createHistogram(name, {
            unit: 's',
            advice: { explicitBucketBoundaries: DURATION_BUCKETS },
          });
          histograms.set(name, instrument);
        }
        instrument.record(ms / 1_000, { ...commonAttributes, ...attrs }, ROOT_CONTEXT);
      });
    },
    count(name: string, attrs: Attributes) {
      guarded(() => {
        let instrument = counters.get(name);
        if (!instrument) {
          instrument = meter.createCounter(name);
          counters.set(name, instrument);
        }
        instrument.add(1, { ...commonAttributes, ...attrs }, ROOT_CONTEXT);
      });
    },
    gauge(name: string, value: number) {
      guarded(() => {
        if (!Number.isFinite(value) || value < 0) return;
        let instrument = gauges.get(name);
        if (!instrument) {
          instrument = meter.createGauge(name);
          gauges.set(name, instrument);
        }
        instrument.record(value, commonAttributes, ROOT_CONTEXT);
      });
    },
    event(event: string, attrs: MetricAttributes) {
      guarded(() =>
        logger.emit({
          body: event,
          eventName: event,
          severityNumber: 9,
          severityText: 'INFO',
          attributes: { ...commonAttributes, ...attrs },
          context: ROOT_CONTEXT,
        })
      );
    },
    async shutdown() {
      // SDK 自身短超时之外，再限制应用关闭等待；断网不阻塞发布/主交易退出。
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([
            meterProvider.shutdown({ timeoutMillis: EXPORT_TIMEOUT_MS }),
            loggerProvider.shutdown(),
          ]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_500);
            timer.unref();
          }),
        ]);
      } catch {
        // 关闭失败只丢遥测，不能让 Fastify 的业务资源关闭链失败。
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export function observeHttp(input: {
  route: string;
  method: string;
  statusClass: string;
  kind: 'standard' | 'generation';
  durationMs: number;
}) {
  if (!active) return;
  const attrs = {
    route: engineeringRoute(input.route),
    method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(input.method)
      ? input.method
      : 'OTHER',
    status_class: input.statusClass,
    kind: input.kind,
  };
  active.duration('st_http_server_duration', input.durationMs, attrs);
  active.count('st_http_server_requests', attrs);
}

export function observeDb(input: {
  model: string;
  operation: string;
  outcome: string;
  durationMs: number;
}) {
  if (!active) return;
  active.duration('st_prisma_operation_duration', input.durationMs, {
    model: boundedLabel('prisma_model', input.model, 64),
    operation: boundedLabel('prisma_operation', input.operation, 32),
    outcome: ['ok', 'error', 'pool_timeout'].includes(input.outcome) ? input.outcome : 'unknown',
  });
}

export function observeRuntime(loopDelayMs: number, rss: number) {
  active?.gauge('st_runtime_event_loop_delay_seconds', loopDelayMs / 1_000);
  active?.gauge('st_runtime_rss_bytes', rss);
}

export function observeGenerationDispatch(input: {
  provider: string;
  model: string;
  role: 'primary' | 'fallback';
  dispatchOffsetMs?: number;
  phase?: 'first_token' | 'generation';
}) {
  if (!active) return;
  const attrs = { ...identity(input), role: input.role, phase: input.phase ?? 'first_token' };
  active.count('st_generation_attempt_dispatches', attrs);
  if (input.dispatchOffsetMs !== undefined)
    active.duration('st_generation_dispatch_offset', input.dispatchOffsetMs, attrs);
}

export type AttemptOutcome =
  | 'first_token_observed'
  | 'first_token_deadline'
  | 'timeout'
  | 'filtered'
  | 'length'
  | 'user_cancelled'
  | 'upstream_error'
  | 'cancelled'
  | 'race_lost'
  | 'observation_deadline'
  | 'stream_interrupted'
  | 'budget_skipped'
  | 'completed';
export function observeGenerationAttempt(input: {
  provider: string;
  model: string;
  role: 'primary' | 'fallback';
  outcome: AttemptOutcome;
  durationMs?: number;
  headersMs?: number;
  firstTokenMs?: number;
  dispatched: boolean;
  phase?: 'first_token' | 'generation';
}) {
  if (!active) return;
  const attrs = {
    ...identity(input),
    role: input.role,
    outcome: input.outcome,
    dispatched: input.dispatched,
    phase: input.phase ?? 'first_token',
  };
  active.count('st_generation_attempt_terminals', attrs);
  if (input.durationMs !== undefined)
    active.duration('st_generation_attempt_observed', input.durationMs, attrs);
  if (input.headersMs !== undefined)
    active.duration('st_generation_headers', input.headersMs, attrs);
  if (input.firstTokenMs !== undefined)
    active.duration('st_generation_first_token', input.firstTokenMs, attrs);
  active.event('generation.attempt_terminal', {
    ...attrs,
    ...(input.durationMs === undefined ? {} : { duration_ms: Math.round(input.durationMs) }),
  });
}

export function observeGenerationPrepare(input: {
  provider: string;
  model: string;
  durationMs: number;
  outcome: 'ready' | 'rejected' | 'error';
}) {
  if (!active) return;
  active.duration('st_generation_prepare', input.durationMs, {
    ...identity(input),
    outcome: input.outcome,
  });
}

export type GenerationOutcome =
  | 'success'
  | 'insufficient_balance'
  | 'vip_required'
  | 'filtered'
  | 'length'
  | 'timeout'
  | 'user_cancelled'
  | 'cancelled'
  | 'upstream_error'
  | 'stream_interrupted'
  | 'error';
export function observeGenerationTerminal(input: {
  provider: string;
  model: string;
  stream: boolean;
  outcome: GenerationOutcome;
  durationMs: number;
}) {
  if (!active) return;
  const attrs = { ...identity(input), kind: input.stream ? 'sse' : 'json', outcome: input.outcome };
  active.count('st_generation_results', attrs);
  active.duration('st_generation_duration', input.durationMs, attrs);
  active.event('generation.terminal', { ...attrs, duration_ms: Math.round(input.durationMs) });
}

/** 复用短剧现有阶段计时，不输出签名 URL/object_path/request_id。 */
export function observeDramaRequest(input: {
  route: string;
  outcome: 'ok' | 'http_error' | 'unplayable';
  signCache: string;
  stages: Partial<Record<'auth' | 'db_read' | 'assemble' | 'sign', number>>;
  durationMs: number;
}) {
  if (!active) return;
  const attrs = {
    route: engineeringRoute(input.route),
    outcome: input.outcome,
    sign_cache: ['hit', 'miss', 'inflight', 'unused'].includes(input.signCache)
      ? input.signCache
      : 'unknown',
  };
  const detail: MetricAttributes = { ...attrs, total_ms: Math.round(input.durationMs) };
  for (const stage of ['auth', 'db_read', 'assemble', 'sign'] as const) {
    const ms = input.stages[stage];
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) {
      active.duration('st_drama_server_stage', ms, { ...attrs, stage });
      detail[`${stage}_ms`] = Math.round(ms);
    }
  }
  active.event('drama.request_timing', detail);
}
