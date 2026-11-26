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

export function boundedLabel(kind: string, value: string, limit: number): string {
  if (!SAFE_KEY.test(value) || /[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(value)) return 'unknown';
  let values = LABEL_VALUES.get(kind);
  if (!values) LABEL_VALUES.set(kind, (values = new Set()));
  if (values.has(value)) return value;
  if (values.size >= limit) return 'other';
  values.add(value);
  return value;
}

export function createTelemetry(options: EngineeringTelemetryConfig) {
  const health = {
    logQueued: 0,
    logDropped: 0,
    logFailed: 0,
    metricFailed: 0,
    instrumentFailed: 0,
  };
  const { meterProvider, loggerProvider } = createProviders(options, health);
  const commonAttributes = {
    environment: options.environment,
    release: boundedLabel('version', options.version, 8),
  };
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
    /** value 默认 1；按项计数时一次加多个（只接受正整数，避免把耗时等误当计数）。 */
    count(name: string, attrs: Attributes, value = 1) {
      guarded(() => {
        if (!Number.isInteger(value) || value <= 0) return;
        let instrument = counters.get(name);
        if (!instrument) {
          instrument = meter.createCounter(name);
          counters.set(name, instrument);
        }
        instrument.add(value, { ...commonAttributes, ...attrs }, ROOT_CONTEXT);
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
    /** 每次导出时由 collect 交出当前全部条目；collect 必须同步、只读内存。 */
    observeGauge(name: string, collect: () => Array<{ value: number; attrs: Attributes }>) {
      guarded(() =>
        meter.createObservableGauge(name).addCallback((result) =>
          guarded(() => {
            for (const { value, attrs } of collect()) {
              result.observe(value, { ...commonAttributes, ...attrs });
            }
          })
        )
      );
    },
    event(event: string, attrs: MetricAttributes, body = event) {
      guarded(() =>
        logger.emit({
          body,
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
type MetricAttributes = Record<string, string | number | boolean>;

type ExportHealth = {
  logQueued: number;
  logDropped: number;
  logFailed: number;
  metricFailed: number;
  instrumentFailed: number;
};
function createProviders(options: EngineeringTelemetryConfig, health: ExportHealth) {
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
  return { meterProvider, loggerProvider };
}
