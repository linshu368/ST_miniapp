'use client';

import type { BrowserConfig, Faro, TransportItem } from '@grafana/faro-web-sdk';

import { engineeringRoute } from './route-template';

type Attributes = Readonly<Record<string, string | number | boolean | null | undefined>>;
type Sdk = typeof import('@grafana/faro-web-sdk');
type Signal = {
  kind: 'measurement' | 'event';
  name: string;
  durationMs?: number;
  attributes: Record<string, string>;
  timestamp: number;
};
type Configuration = { url: string; environment: 'test' | 'production'; release: string };

export const ENGINEERING_MEASUREMENT_VERSION = 'engineering_v1';
const MEASUREMENTS = new Set([
  'page.ready',
  'page.fresh',
  'page.navigation',
  'page.launch',
  'roleplay.enter',
  'roleplay.first_token',
  'roleplay.full_reply',
  'roleplay.render',
  'roleplay.recovery',
  'roleplay.action',
  'drama.catalog',
  'drama.startup',
  'drama.first_frame',
  'drama.stage',
  'drama.rebuffer',
  'api.queue',
  'api.headers',
  'api.body',
  'api.total',
]);
const EVENTS = new Set([
  'page.started',
  'page.terminal',
  'page.stall',
  'roleplay.started',
  'roleplay.terminal',
  'roleplay.action',
  'drama.started',
  'drama.terminal',
  'drama.stall',
  'api.terminal',
  'telemetry.health',
]);
const ENUMS: Readonly<Record<string, readonly string[]>> = {
  outcome: [
    'started',
    'ready',
    'fresh',
    'observed',
    'timed_out',
    'not_observed',
    'cancelled',
    'superseded',
    'page_left',
    'upstream_error',
    'server_timeout',
    'fallback_timeout',
    'primary_timeout',
    'complete',
    'failed',
    'interrupted',
    'rejected',
    'recovering',
    'feedback',
    'discarded',
    'stalled',
    'waiting',
    'playing',
    'error',
    'unplayable',
    'autoplay_blocked',
    'switched',
    'left',
    'background',
    'seek',
    'paused',
    'ended',
    'disposed',
    'success',
    'ok',
    'http_error',
    'network_error',
    'aborted',
    'timeout',
    'unknown',
  ],
  stage: [
    'ready',
    'fresh',
    'launch',
    'navigation',
    'first_token',
    'full_reply',
    'render',
    'recovery',
    'feedback',
    'rebuffer',
    'catalog',
    'startup',
    'address_wait',
    'address_to_source',
    'source_to_metadata',
    'metadata_to_frame',
    'source_to_frame',
    'source_to_playing',
    'queue',
    'headers',
    'body',
    'total',
  ],
  action: [
    'send',
    'regenerate',
    'select_character',
    'send_message',
    'create_conversation',
    'image_generate',
    'voice_generate',
  ],
  playback_mode: ['cover', 'switch', 'episode', 'retry', 'direct'],
  report_kind: ['list', 'playback', 'start', 'slow', 'final', 'network'],
  first_frame_method: ['video_frame_callback', 'playing_and_timeupdate'],
  source_measurement_version: [
    'page_mount_v1',
    'page_navigation_v1',
    'page_launch_v1',
    'client_committed_v4',
    'client_committed_reply_v1',
    'action_foreground_v1',
    'drama_v1',
    'drama_v2',
    'drama_rebuffer_v1',
    'api_attempt_v1',
    'api_logical_v1',
  ],
  cache: ['fetch', 'inflight', 'cache', 'unknown'],
  navigation_type: ['document', 'spa', 'mount'],
  visibility: ['foreground', 'background', 'mixed'],
  cold_start: ['true', 'false'],
  net_type: ['slow-2g', '2g', '3g', '4g', 'unknown'],
  net_rtt_bucket: ['lt100', '100-300', '300-1000', 'gte1000', 'unknown'],
  tg_platform: [
    'android',
    'android_x',
    'ios',
    'macos',
    'tdesktop',
    'web',
    'weba',
    'webk',
    'unigram',
    'unknown',
  ],
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  status_class: ['2xx', '3xx', '4xx', '5xx', 'network', 'unknown'],
  attempt: ['1', '2'],
  attempts: ['1', '2'],
  api_route: [
    'characters',
    'character_detail',
    'conversations',
    'conversation_detail',
    'conversation_turn',
    'dramas',
    'drama_detail',
    'drama_playback',
    'drama_social',
    'images',
    'voice',
    'image_plaza',
    'models',
    'settings',
    'wallet',
    'payment',
    'vip',
    'notifications',
    'support',
    'community',
    'invite',
    'growth',
    'text_postprocess',
    'other',
  ],
  state: ['ready', 'queue_full', 'load_failed', 'load_timeout', 'disabled'],
};
const HEALTH_FIELDS = new Set([
  'source_accepted',
  'source_dropped',
  'source_invalid',
  'source_disabled',
  'source_queued',
  'source_transport_failures',
]);
const MAX_QUEUE = 64;
const MAX_PAYLOAD_BYTES = 2_048;
const LOAD_TIMEOUT_MS = 3_000;
const MAX_DURATION_MS = 86_400_000;

function configuration(): Configuration | null {
  // Next 必须静态读取公开变量；这里从不接受 Cloud 写入 token。
  if (process.env.NEXT_PUBLIC_GRAFANA_ENABLED !== 'true') return null;
  const environment = process.env.NEXT_PUBLIC_GRAFANA_ENVIRONMENT;
  const release = process.env.NEXT_PUBLIC_GRAFANA_RELEASE?.trim();
  const rawUrl = process.env.NEXT_PUBLIC_GRAFANA_COLLECTOR_URL?.trim();
  if (!rawUrl || !release || !/^[a-zA-Z0-9._-]{1,64}$/.test(release)) return null;
  if (environment !== 'test' && environment !== 'production') return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return { url: url.href, environment, release };
  } catch {
    return null;
  }
}

export function isEngineeringTelemetryEnabled(): boolean {
  return configuration() !== null && typeof window !== 'undefined';
}

function safeAttributes(attributes: Attributes = {}): Record<string, string> {
  const result: Record<string, string> = {
    schema_version: '1',
    measurement_version: ENGINEERING_MEASUREMENT_VERSION,
  };
  for (const [key, value] of Object.entries(attributes).slice(0, 32)) {
    if (value === null || value === undefined) continue;
    if (key === 'route') result.route = engineeringRoute(String(value));
    else if (HEALTH_FIELDS.has(key)) {
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^\d{1,10}$/.test(value)
            ? Number(value)
            : NaN;
      if (Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000_000)
        result[key] = String(number);
    } else if (ENUMS[key])
      result[key] = ENUMS[key].includes(String(value)) ? String(value) : 'other';
  }
  return result;
}

function metricName(name: string): string {
  return `st_${name.replaceAll('.', '_')}`;
}
const METRIC_NAMES = new Set([...MEASUREMENTS].map(metricName));
const EVENT_NAMES = new Set([...EVENTS].map(metricName));

/** 最后一层重建 payload/meta；只留 app 与公开 SDK 协议信息，身份/URL 等自动 meta 不能穿透。 */
function beforeSend(
  config: Configuration,
  sdkVersion: string,
  item: TransportItem
): TransportItem | null {
  const meta = {
    app: { name: 'st-miniapp', environment: config.environment, version: config.release },
    sdk: { name: '@grafana/faro-web-sdk', version: sdkVersion },
  };
  const payload = item.payload;
  if (
    item.type === 'measurement' &&
    'type' in payload &&
    METRIC_NAMES.has(payload.type) &&
    'values' in payload
  ) {
    const duration = payload.values.duration_ms;
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > MAX_DURATION_MS
    )
      return null;
    return {
      type: item.type,
      meta,
      payload: {
        type: payload.type,
        timestamp: payload.timestamp,
        values: { duration_ms: duration },
        context: safeAttributes(payload.context),
      },
    };
  }
  if (item.type === 'event' && 'name' in payload && EVENT_NAMES.has(payload.name)) {
    return {
      type: item.type,
      meta,
      payload: {
        name: payload.name,
        timestamp: payload.timestamp,
        domain: 'st.engineering',
        attributes: safeAttributes(payload.attributes),
      },
    };
  }
  return null;
}

/** 工程遥测可丢，业务不可被它阻塞。队列和 SDK 等待均有界，失败后本次页面不重试加载。 */
export function createEngineeringExporter(
  loadSdk: () => Promise<Sdk> = () => import('@grafana/faro-web-sdk')
) {
  let sdk: Faro | undefined;
  let loading: Promise<void> | undefined;
  let stopped = false;
  const queue: Signal[] = [];
  const health = {
    source_accepted: 0,
    source_dropped: 0,
    source_invalid: 0,
    source_disabled: 0,
    source_queued: 0,
    source_transport_failures: 0,
  };

  function send(signal: Signal): void {
    try {
      if (!sdk) return;
      if (signal.kind === 'measurement')
        sdk.api.pushMeasurement(
          { type: metricName(signal.name), values: { duration_ms: signal.durationMs! } },
          { skipDedupe: true, context: signal.attributes, timestampOverwriteMs: signal.timestamp }
        );
      else
        sdk.api.pushEvent(metricName(signal.name), signal.attributes, 'st.engineering', {
          skipDedupe: true,
          timestampOverwriteMs: signal.timestamp,
        });
    } catch {
      health.source_dropped += 1;
    }
  }

  function healthSignal(): void {
    send({
      kind: 'event',
      name: 'telemetry.health',
      attributes: safeAttributes({ ...health, source_queued: queue.length, state: 'ready' }),
      timestamp: Date.now(),
    });
  }

  function initialize(): Promise<void> {
    if (loading) return loading;
    const config = configuration();
    if (!config || typeof window === 'undefined' || stopped) return Promise.resolve();
    loading = new Promise<void>((resolve) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        stopped = true;
        health.source_dropped += queue.length;
        queue.length = 0;
        resolve();
      };
      const timeout = setTimeout(fail, LOAD_TIMEOUT_MS);
      // Promise 包装也隔离同步 loader 异常；超时后的 import 不再初始化或发送旧队列。
      void Promise.resolve()
        .then(loadSdk)
        .then((module) => {
          if (settled) return;
          // Cloud intake 要求此协议头；仅本 exporter 内存期复用，不恢复 SDK session 或写入身份字段。
          const transportSessionId = module.genShortID(32);
          const transport = new module.FetchTransport({
            url: config.url,
            bufferSize: 20,
            concurrency: 1,
            requestTimeoutMs: 3_000,
            retry: { maxAttempts: 1 },
            requestOptions: {
              credentials: 'omit',
              referrerPolicy: 'no-referrer',
              headers: { 'X-Faro-Session-Id': transportSessionId },
            },
          });
          // 2.13 默认 send 强加 Idempotency-Key，当前托管 intake 的 CORS 不接受该头。
          // 只扩展公开 send/队列/格式接口：复用有界队列，单次发送且不改全局 fetch 或 SDK 私有实现。
          transport.send = async (items) => {
            try {
              await transport.promiseBuffer.add(async () => {
                const body = JSON.stringify(module.getTransportBody(items));
                const controller = new AbortController();
                // 排队不占网络预算；每个真正出队的 batch 各有三秒上限。
                const requestTimeout = setTimeout(() => controller.abort(), 3_000);
                try {
                  const response = await fetch(config.url, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'X-Faro-Session-Id': transportSessionId,
                    },
                    body,
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                    signal: controller.signal,
                  });
                  // 不读取或记录 collector 正文；尽早释放不需要的响应流。
                  void response.body?.cancel().catch(() => {});
                  if (!response.ok) throw new Error('Telemetry intake rejected batch');
                } finally {
                  clearTimeout(requestTimeout);
                }
              });
            } catch {
              // 失败批次不是逐条送达确认；只计数，不复制错误正文、URL 或 SDK 日志。
              health.source_transport_failures += 1;
            }
          };
          const options: BrowserConfig = {
            app: { name: 'st-miniapp', environment: config.environment, version: config.release },
            instrumentations: [],
            metas: [],
            sessionTracking: { enabled: false, persistent: false },
            trackGeolocation: false,
            isolate: true,
            preventGlobalExposure: true,
            internalLoggerLevel: module.InternalLoggerLevel.OFF,
            dedupe: false,
            batching: { enabled: true, itemLimit: 20, sendTimeout: 1_000 },
            transports: [transport],
            beforeSend: (item) => beforeSend(config, module.VERSION, item),
          };
          sdk = module.initializeFaro(options);
          settled = true;
          clearTimeout(timeout);
          for (const signal of queue.splice(0)) send(signal);
          healthSignal();
          resolve();
        })
        .catch(() => {
          clearTimeout(timeout);
          fail();
        });
    });
    return loading;
  }

  function record(
    kind: Signal['kind'],
    name: string,
    durationMs: number | undefined,
    attributes?: Attributes
  ): void {
    try {
      if (
        !(kind === 'measurement' ? MEASUREMENTS : EVENTS).has(name) ||
        (kind === 'measurement' &&
          (typeof durationMs !== 'number' ||
            !Number.isFinite(durationMs) ||
            durationMs < 0 ||
            durationMs > MAX_DURATION_MS))
      ) {
        health.source_invalid += 1;
        return;
      }
      if (!configuration() || typeof window === 'undefined') {
        health.source_disabled += 1;
        return;
      }
      const signal: Signal = {
        kind,
        name,
        durationMs,
        attributes: safeAttributes(attributes),
        timestamp: Date.now(),
      };
      if (JSON.stringify(signal).length > MAX_PAYLOAD_BYTES) {
        health.source_invalid += 1;
        return;
      }
      if (stopped || (!sdk && queue.length >= MAX_QUEUE)) {
        health.source_dropped += 1;
        return;
      }
      health.source_accepted += 1;
      if (sdk) {
        send(signal);
        if (health.source_accepted % 100 === 0) healthSignal();
      } else {
        queue.push(signal);
        void initialize();
      }
    } catch {
      health.source_invalid += 1;
    }
  }

  return {
    initialize,
    measurement: (name: string, durationMs: number, attributes?: Attributes) =>
      record('measurement', name, durationMs, attributes),
    event: (name: string, attributes?: Attributes) => record('event', name, undefined, attributes),
    health: () => ({ ...health, source_queued: queue.length }),
  };
}

const exporter = createEngineeringExporter();
export const initializeEngineeringTelemetry = exporter.initialize;
export const recordEngineeringMeasurement = exporter.measurement;
export const recordEngineeringEvent = exporter.event;
export const getEngineeringTelemetryHealth = exporter.health;
