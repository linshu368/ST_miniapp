import {
  boundedLabel,
  createTelemetry,
  type EngineeringTelemetryConfig,
} from './engineering-telemetry-exporter.js';
import { observation } from '../platform/observability/runtime.js';
import { observationOutcome } from '../platform/observability/outcomes.js';
export type { EngineeringTelemetryConfig } from './engineering-telemetry-exporter.js';

import type { UpstreamTiming } from '../features/generation/upstream-timing.js';
import {
  DRAMA_TIMING_BODY_LIMIT,
  DramaTimingReportSchema,
  type DramaTimingReport,
} from '@miniapp/shared';
const LLM_PROVIDERS = new Set(['openrouter', 'venice', 'surplus']);
type MetricAttributes = Record<string, string | number | boolean>;

export function engineeringRoute(route: string): string {
  return route.startsWith('/api/') ? boundedLabel('route', route, 256) : 'unmatched';
}

function identity(input: { provider: string; model: string }): MetricAttributes {
  return {
    platform: LLM_PROVIDERS.has(input.provider) ? input.provider : 'unknown',
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

export type BackgroundJobOutcome = 'success' | 'partial' | 'error' | 'skipped' | 'cancelled';

/** Process and scheduler jobs use fixed names only; business IDs never become labels. */
export function observeBackgroundJob(input: {
  job: string;
  outcome: BackgroundJobOutcome;
  durationMs: number;
}): void {
  observation.emit('job.terminal', `job.${input.job}`, {
    outcome: observationOutcome(input.outcome),
    outcome_known: input.outcome !== 'error',
    duration_ms: input.durationMs,
  });
  if (!active) return;
  const attrs = {
    job: boundedLabel('background_job', input.job, 64),
    outcome: input.outcome,
  };
  active.duration('st_background_job_duration', input.durationMs, attrs);
  active.count('st_background_job_runs', attrs);
  active.event('background_job.terminal', {
    ...attrs,
    duration_ms: Math.round(input.durationMs),
  });
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
  timing?: UpstreamTiming;
  dispatched: boolean;
  phase?: 'first_token' | 'generation';
}) {
  observation.emit('generation.attempt', `generation.attempt.${input.role}`, {
    outcome: observationOutcome(input.outcome),
    outcome_known: !['timeout', 'stream_interrupted', 'observation_deadline'].includes(
      input.outcome
    ),
    provider: input.provider,
    stage: input.outcome,
    duration_ms: input.durationMs,
  });
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
  const t = input.timing;
  const difference = (end?: number, start?: number) =>
    end !== undefined && start !== undefined && end >= start ? end - start : undefined;
  const stages = {
    request_create: t?.requestCreatedMs,
    connection_wait: difference(t?.sendHeadersMs, t?.requestCreatedMs),
    request_send: difference(t?.bodySentMs, t?.sendHeadersMs),
    response_wait: difference(t?.responseHeadersMs, t?.bodySentMs),
    response_to_token: difference(input.firstTokenMs, t?.responseHeadersMs),
  };
  const details: Record<string, number | string> = {};
  if (t && input.dispatched) {
    details.network_stage =
      t.responseHeadersMs !== undefined
        ? 'headers_received'
        : t.bodySentMs !== undefined
          ? 'awaiting_headers'
          : t.sendHeadersMs !== undefined
            ? 'sending_body'
            : t.requestCreatedMs !== undefined
              ? 'awaiting_connection'
              : 'unobserved';
    for (const [stage, duration] of Object.entries(stages)) {
      if (duration === undefined) continue;
      // One fixed stage label, no request IDs or vendor names as metric dimensions.
      active.duration('st_generation_network_stage', duration, {
        ...identity(input),
        role: input.role,
        stage,
      });
      details[`${stage}_ms`] = Math.round(duration);
    }
  }
  active.event('generation.attempt_terminal', {
    ...attrs,
    ...(input.durationMs === undefined ? {} : { duration_ms: Math.round(input.durationMs) }),
    ...details,
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

export type GenerationPreparationStage =
  | 'route_setup'
  | 'settings'
  | 'turn_open'
  | 'context'
  | 'dispatch_gate';

export function observeGenerationPreparationStages(input: {
  provider: string;
  model: string;
  stages?: Partial<Record<GenerationPreparationStage, number>>;
  log?: MetricAttributes;
}) {
  if (!active) return;
  const attrs = identity(input);
  if (input.stages)
    for (const [stage, duration] of Object.entries(input.stages))
      active.duration('st_generation_pre_dispatch_stage', duration, { ...attrs, stage });
  if (input.log) active.event('generation.pre_dispatch', { ...attrs, ...input.log });
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
  manifestCache?: string;
  stages: Partial<Record<'auth' | 'db_read' | 'assemble' | 'sign' | 'manifest', number>>;
  durationMs: number;
}) {
  if (!active) return;
  const attrs = {
    route: engineeringRoute(input.route),
    outcome: input.outcome,
    sign_cache: ['hit', 'miss', 'inflight', 'unused'].includes(input.signCache)
      ? input.signCache
      : 'unknown',
    manifest_cache:
      input.manifestCache && ['hit', 'miss', 'inflight', 'unused'].includes(input.manifestCache)
        ? input.manifestCache
        : 'unused',
  };
  const detail: MetricAttributes = { ...attrs, total_ms: Math.round(input.durationMs) };
  for (const stage of ['auth', 'db_read', 'assemble', 'sign', 'manifest'] as const) {
    const ms = input.stages[stage];
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) {
      active.duration('st_drama_server_stage', ms, { ...attrs, stage });
      detail[`${stage}_ms`] = Math.round(ms);
    }
  }
  active.event('drama.request_timing', detail);
}

/** Log bodies retain bounded diagnostics; IDs/arrays must never become metric or stream labels. */
export function observeDramaStartupDiagnostic(report: DramaTimingReport): void {
  if (
    !active ||
    (report.type !== 'playback' && !(report.type === 'seek' && report.seek?.definition)) ||
    // CDN 实验组要解释中位数，快样本也全量保留；其余流量只留慢样本。
    (!report.delivery && report.elapsedMs < (report.type === 'seek' ? 3_000 : 5_000)) ||
    (report.phase !== 'final' && report.phase !== 'network')
  )
    return;
  // Revalidate at the external sink boundary, even when the caller already parsed the request.
  const parsed = DramaTimingReportSchema.safeParse(report);
  if (!parsed.success) return;
  const payload = JSON.stringify(parsed.data);
  if (Buffer.byteLength(payload, 'utf8') > DRAMA_TIMING_BODY_LIMIT) return;
  const event = report.type === 'seek' ? 'drama.seek_diagnostic' : 'drama.startup_diagnostic';
  active.event(
    event,
    {
      kind: report.type === 'seek' ? 'drama_seek_diagnostic' : 'drama_startup_diagnostic',
      phase: parsed.data.phase,
      outcome: parsed.data.outcome,
      total_ms: parsed.data.elapsedMs,
      engine: parsed.data.engine ?? 'unknown',
    },
    JSON.stringify({ event, ...parsed.data })
  );
}

/** Once-per-business-milestone projection; never reads the DB or waits for export. */
export function observeChatFirstToken(input: {
  requestedModel: string;
  stage: 'accepted' | 'fallback_dispatched' | 'selected' | 'timeout';
  winner?: 'primary' | 'fallback';
  fallbackDispatched?: boolean;
  elapsedMs?: number;
  deadlineMs?: number;
  triggerMs?: number;
}) {
  if (!active) return;
  const attrs: MetricAttributes = {
    requested_model: boundedLabel('requested_model', input.requestedModel, 64),
  };
  if (input.stage === 'selected' && input.winner) {
    attrs.winner = input.winner;
    if (input.fallbackDispatched !== undefined) attrs.fallback_started = input.fallbackDispatched;
  }
  const metrics = {
    accepted: 'st_chat_requests',
    fallback_dispatched: 'st_chat_fallback_dispatches',
    selected: 'st_chat_first_token_selections',
    timeout: 'st_chat_first_token_timeouts',
  } as const;
  active.count(metrics[input.stage], attrs);
  if (input.stage === 'selected' && input.elapsedMs !== undefined)
    active.duration('st_chat_server_first_token', input.elapsedMs, attrs);
  const detail: MetricAttributes = { ...attrs, stage: input.stage };
  // Numeric policy values stay in log fields, never a new dimension of time series.
  for (const [key, value] of [
    ['elapsed_ms', input.elapsedMs],
    ['deadline_ms', input.deadlineMs],
    ['trigger_ms', input.triggerMs],
  ] as const) {
    if (value !== undefined && Number.isFinite(value) && value >= 0 && value <= 110_000)
      detail[key] = Math.round(value);
  }
  active.event('chat.first_token', detail);
}
