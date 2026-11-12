/**
 * 畅聊状态表与指标视图的读写。表结构见 migrations/20261112_free_zone.sql。
 *
 * 评估任务的写入：一个短事务内拿 xact advisory lock，并检查最近一次评估时间，
 * 多副本同时到点时只有一个真正落库；状态推进是覆盖写，重复执行不会把「连续达标」数多算。
 * 另一处写入是运营手动上架。评估在锁外读状态、推算要几十秒，所以每行按读到时的 updated_at
 * 做条件写：这期间被手动改过的行，本轮评估不覆盖、也不记事件，下一轮再按新状态推进。
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import type { BusinessMetrics, FreeZoneEvent, FreeZoneModelState } from './lifecycle.js';

const ADVISORY_LOCK_KEY = 740_112;
const METRICS_STATEMENT_TIMEOUT_MS = 20_000;

interface StateRow {
  candidate_id: string;
  status: FreeZoneModelState['status'];
  providers: string[];
  provider_since: Date | null;
  excluded_providers: Record<string, string> | null;
  consecutive_passes: number;
  cooldown_until: Date | null;
  business_delists_at: Date[];
  last_reason: string | null;
}

const STATE_COLUMNS = Prisma.sql`candidate_id, status, providers, provider_since, excluded_providers,
  consecutive_passes, cooldown_until, business_delists_at, last_reason`;

function toState(row: StateRow): FreeZoneModelState {
  return {
    candidateId: row.candidate_id,
    status: row.status,
    providers: row.providers,
    providerSince: row.provider_since?.toISOString() ?? null,
    excludedProviders: row.excluded_providers ?? {},
    consecutivePasses: row.consecutive_passes,
    cooldownUntil: row.cooldown_until?.toISOString() ?? null,
    businessDelistsAt: row.business_delists_at.map((at) => at.toISOString()),
    lastReason: row.last_reason,
  };
}

export interface VersionedStates {
  states: Map<string, FreeZoneModelState>;
  /** candidate_id → 读到时的 updated_at（文本，保留微秒，原样拿回去比较） */
  versions: Map<string, string>;
}

export async function loadFreeZoneStatesVersioned(): Promise<VersionedStates> {
  const rows = await prisma.$queryRaw<Array<StateRow & { version: string }>>`
    SELECT ${STATE_COLUMNS}, updated_at::text AS version
    FROM miniapp_features.free_zone_models`;
  return {
    states: new Map(rows.map((row) => [row.candidate_id, toState(row)])),
    versions: new Map(rows.map((row) => [row.candidate_id, row.version])),
  };
}

export async function loadFreeZoneStates(): Promise<Map<string, FreeZoneModelState>> {
  return (await loadFreeZoneStatesVersioned()).states;
}

export interface ModelMetrics extends BusinessMetrics {
  /** 每次成功出字调用的平均实际价格（美元），只观察不判定 */
  avgCostUsd: number | null;
  avgPromptTokens: number | null;
}

interface MetricsRow {
  model_id: string;
  turns: number;
  no_output_pct: number | null;
  fallback_delivered_pct: number | null;
  timeout_pct: number | null;
  ttft_p90_ms: number | null;
  refusal_pct: number | null;
  truncation_pct: number | null;
  avg_cost_usd: number | null;
  avg_prompt_tokens: number | null;
  dislikes: number;
}

/**
 * 在架模型最近窗口内的真实业务指标；口径与 Grafana 读的是同一个视图。
 * 每个模型只统计当前供应商开始用之后的轮次（since），换了供应商就重新累计，不和上一家混。
 */
export async function loadFreeZoneMetrics(
  models: Array<{ id: string; since: string | null }>,
  windowHours: number
): Promise<Map<string, ModelMetrics>> {
  if (models.length === 0) return new Map();
  const modelIds = models.map((model) => model.id);
  const sinces = models.map((model) => model.since ?? '1970-01-01T00:00:00Z');
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${METRICS_STATEMENT_TIMEOUT_MS}`);
    return tx.$queryRaw<MetricsRow[]>`
      WITH scope AS (
        SELECT * FROM unnest(${modelIds}::text[], ${sinces}::timestamptz[]) AS s(model_id, since)
      ), turns AS (
        SELECT f.model_id,
          count(*)::int AS turns,
          (avg(CASE WHEN primary_output THEN 0 ELSE 100 END))::float8 AS no_output_pct,
          (avg(CASE WHEN fallback_delivered THEN 100 ELSE 0 END))::float8 AS fallback_delivered_pct,
          (avg(CASE WHEN timed_out THEN 100 ELSE 0 END))::float8 AS timeout_pct,
          (percentile_cont(0.9) WITHIN GROUP (ORDER BY primary_ttft_ms))::float8 AS ttft_p90_ms,
          (avg(CASE WHEN refused THEN 100 ELSE 0 END))::float8 AS refusal_pct,
          (avg(CASE WHEN truncated THEN 100 ELSE 0 END))::float8 AS truncation_pct,
          (avg(buyer_cost_usd) FILTER (WHERE primary_output))::float8 AS avg_cost_usd,
          (avg(prompt_tokens) FILTER (WHERE primary_output))::float8 AS avg_prompt_tokens
        FROM miniapp_analytics.free_zone_turn_facts f
        JOIN scope s ON s.model_id = f.model_id
        WHERE f.turn_at >= GREATEST(now() - make_interval(hours => ${windowHours}::int), s.since)
        GROUP BY f.model_id
      ), dislikes AS (
        SELECT d.model_id, count(*)::int AS dislikes
        FROM miniapp_analytics.free_zone_dislikes d
        JOIN scope s ON s.model_id = d.model_id
        WHERE d.created_at >= GREATEST(now() - make_interval(hours => ${windowHours}::int), s.since)
        GROUP BY d.model_id
      )
      SELECT t.*, COALESCE(d.dislikes, 0) AS dislikes
      FROM turns t LEFT JOIN dislikes d USING (model_id)`;
  });
  return new Map(
    rows.map((row) => [
      row.model_id,
      {
        turns: row.turns,
        noOutputPct: row.no_output_pct,
        fallbackDeliveredPct: row.fallback_delivered_pct,
        timeoutPct: row.timeout_pct,
        ttftP90Ms: row.ttft_p90_ms,
        refusalPct: row.refusal_pct,
        truncationPct: row.truncation_pct,
        dislikePct: row.turns > 0 ? (row.dislikes / row.turns) * 100 : null,
        avgCostUsd: row.avg_cost_usd,
        avgPromptTokens: row.avg_prompt_tokens,
      },
    ])
  );
}

export interface EvaluatedCandidate {
  surplusModel: string;
  state: FreeZoneModelState;
  events: FreeZoneEvent[];
  metrics: Record<string, unknown>;
  /** 推算所依据的那一行的 updated_at；null 表示当时还没有这一行 */
  version: string | null;
}

export type SaveOutcome = 'saved' | 'locked' | 'recent';

export interface SaveResult {
  outcome: SaveOutcome;
  /** 推算期间被别处（运营手动上架）改过、本轮没写的候选 */
  skipped: string[];
}

/**
 * 一次评估的全部结果在一个短事务里落库。另一个副本持锁，或最近 minIntervalMinutes 内
 * 已有人评估过，就放弃本次写入（状态读取发生在锁外，过期的推算不能覆盖别人的结果）。
 */
export async function saveFreeZoneEvaluation(
  evaluated: EvaluatedCandidate[],
  minIntervalMinutes: number
): Promise<SaveResult> {
  return prisma.$transaction(
    async (tx): Promise<SaveResult> => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}::bigint) AS locked`;
      if (!lock?.locked) return { outcome: 'locked', skipped: [] };
      const [recent] = await tx.$queryRaw<Array<{ recent: boolean }>>`
        SELECT COALESCE(max(evaluated_at) > now() - make_interval(mins => ${minIntervalMinutes}::int), false) AS recent
        FROM miniapp_features.free_zone_models`;
      if (recent?.recent) return { outcome: 'recent', skipped: [] };

      const skipped: string[] = [];
      for (const item of evaluated) {
        const s = item.state;
        // version 为 null 时比较结果是 NULL：读的时候没有这一行、现在却有了，同样不覆盖
        const written = await tx.$executeRaw`
          INSERT INTO miniapp_features.free_zone_models (candidate_id, surplus_model, status, providers,
            provider_since, excluded_providers, consecutive_passes, cooldown_until, business_delists_at,
            last_reason, last_metrics, evaluated_at, updated_at)
          VALUES (${s.candidateId}, ${item.surplusModel}, ${s.status}, ${s.providers}::text[],
            ${s.providerSince}::timestamptz, ${JSON.stringify(s.excludedProviders)}::jsonb,
            ${s.consecutivePasses}, ${s.cooldownUntil}::timestamptz, ${s.businessDelistsAt}::timestamptz[],
            ${s.lastReason?.slice(0, 2000) ?? null}, ${JSON.stringify(item.metrics)}::jsonb, now(), now())
          ON CONFLICT (candidate_id) DO UPDATE SET
            surplus_model = EXCLUDED.surplus_model, status = EXCLUDED.status,
            providers = EXCLUDED.providers, provider_since = EXCLUDED.provider_since,
            excluded_providers = EXCLUDED.excluded_providers,
            consecutive_passes = EXCLUDED.consecutive_passes,
            cooldown_until = EXCLUDED.cooldown_until, business_delists_at = EXCLUDED.business_delists_at,
            last_reason = EXCLUDED.last_reason, last_metrics = EXCLUDED.last_metrics,
            evaluated_at = EXCLUDED.evaluated_at, updated_at = EXCLUDED.updated_at
          WHERE miniapp_features.free_zone_models.updated_at = ${item.version}::timestamptz`;
        if (written === 0) {
          skipped.push(s.candidateId);
          continue;
        }
        for (const event of item.events) {
          const row = eventRow(event, s.providers);
          await tx.$executeRaw`
            INSERT INTO miniapp_features.free_zone_events (candidate_id, event_type, cause, providers, reason, metrics)
            VALUES (${s.candidateId}, ${event.type}, ${row.cause}, ${row.providers}::text[],
              ${row.reason}, ${JSON.stringify(item.metrics)}::jsonb)`;
        }
      }
      return { outcome: 'saved', skipped };
    },
    { timeout: 15_000, maxWait: 5_000 }
  );
}

function eventRow(
  event: FreeZoneEvent,
  currentProviders: string[]
): { cause: string | null; providers: string[]; reason: string | null } {
  switch (event.type) {
    case 'listed':
      return {
        cause: null,
        providers: event.providers,
        reason: event.manual ? '运营手动上架' : null,
      };
    case 'provider_switched':
      return {
        cause: event.cause,
        providers: [event.to],
        reason: `${event.from} → ${event.to}：${event.reasons.join('；')}`.slice(0, 2000),
      };
    case 'delisted':
      return { cause: event.cause, providers: [], reason: event.reasons.join('；').slice(0, 2000) };
    case 'cooldown_ended':
      return { cause: null, providers: currentProviders, reason: null };
  }
}

export type ManualListingOutcome =
  | { kind: 'saved'; previous: FreeZoneModelState | null; state: FreeZoneModelState }
  | { kind: 'already_listed'; providers: string[] };

/**
 * 运营手动上架落库：锁住这一行，确认不在架，按 build 算出新状态覆盖写并记一条上架事件。
 * 不碰 last_metrics / evaluated_at：线上状态页仍显示上一轮评估的数据，也不影响评估节奏。
 */
export async function saveManualListing(input: {
  candidateId: string;
  surplusModel: string;
  build: (current: FreeZoneModelState | null) => {
    state: FreeZoneModelState;
    event: FreeZoneEvent;
  };
}): Promise<ManualListingOutcome> {
  return prisma.$transaction(
    async (tx): Promise<ManualListingOutcome> => {
      const [row] = await tx.$queryRaw<StateRow[]>`
        SELECT ${STATE_COLUMNS} FROM miniapp_features.free_zone_models
        WHERE candidate_id = ${input.candidateId} FOR UPDATE`;
      const previous = row ? toState(row) : null;
      if (previous?.status === 'listed') {
        return { kind: 'already_listed', providers: previous.providers };
      }
      const { state: s, event } = input.build(previous);
      await tx.$executeRaw`
        INSERT INTO miniapp_features.free_zone_models (candidate_id, surplus_model, status, providers,
          provider_since, excluded_providers, consecutive_passes, cooldown_until, business_delists_at,
          last_reason, updated_at)
        VALUES (${s.candidateId}, ${input.surplusModel}, ${s.status}, ${s.providers}::text[],
          ${s.providerSince}::timestamptz, ${JSON.stringify(s.excludedProviders)}::jsonb,
          ${s.consecutivePasses}, ${s.cooldownUntil}::timestamptz, ${s.businessDelistsAt}::timestamptz[],
          ${s.lastReason}, now())
        ON CONFLICT (candidate_id) DO UPDATE SET
          surplus_model = EXCLUDED.surplus_model, status = EXCLUDED.status,
          providers = EXCLUDED.providers, provider_since = EXCLUDED.provider_since,
          excluded_providers = EXCLUDED.excluded_providers,
          consecutive_passes = EXCLUDED.consecutive_passes,
          cooldown_until = EXCLUDED.cooldown_until, business_delists_at = EXCLUDED.business_delists_at,
          last_reason = EXCLUDED.last_reason, updated_at = EXCLUDED.updated_at`;
      const eventData = eventRow(event, s.providers);
      await tx.$executeRaw`
        INSERT INTO miniapp_features.free_zone_events (candidate_id, event_type, cause, providers, reason)
        VALUES (${s.candidateId}, ${event.type}, ${eventData.cause}, ${eventData.providers}::text[],
          ${eventData.reason})`;
      return { kind: 'saved', previous, state: s };
    },
    { timeout: 10_000, maxWait: 5_000 }
  );
}
