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
import { QUALITY_MIN_TURNS, QUALITY_WINDOW_HOURS } from '@miniapp/shared';
import type { FreeZoneEvent, FreeZoneModelState, QualityMetrics } from './lifecycle.js';

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
  pinned: boolean;
}

const STATE_COLUMNS = Prisma.sql`candidate_id, status, providers, provider_since, excluded_providers,
  consecutive_passes, cooldown_until, business_delists_at, last_reason, pinned`;

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
    pinned: row.pinned,
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

export interface ModelQuality extends QualityMetrics {
  /** 免费模型自己交付的轮次（中断率的分母）与其中中断的轮次 */
  primaryDeliveredTurns: number;
  interruptedTurns: number;
  /** 报错兜底：等待时间到之前就报错、空回复，立刻兜底（只显示，不判定） */
  errorFallbackPct: number | null;
}

interface QualityRow {
  model_id: string;
  turns: number;
  unusable_turns: number;
  error_fallback_turns: number;
  primary_delivered_turns: number;
  interrupted_turns: number;
}

/**
 * 在架模型的质量指标：只算这次上架（或换供应商）之后、过去 QUALITY_WINDOW_HOURS 小时的全部轮次。
 * 口径与 Grafana / free_zone_turn_facts 一致，兜底按起因拆开、超时优先：
 * - 不可用：免费模型没交付，且不是「等待时间到之前就报错/空回复、立刻兜底」，
 *   也不是出字前用户自己取消的——即超时兜底 + 超时；
 * - 中断：免费模型自己交付后没写完就断（不含用户点停、内容审核）。
 */
export async function loadFreeZoneQuality(
  models: Array<{ id: string; since: string | null }>
): Promise<Map<string, ModelQuality>> {
  if (models.length === 0) return new Map();
  const modelIds = models.map((model) => model.id);
  const sinces = models.map((model) => model.since ?? '1970-01-01T00:00:00Z');
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${METRICS_STATEMENT_TIMEOUT_MS}`);
    return tx.$queryRaw<QualityRow[]>`
      WITH scope AS (
        SELECT * FROM unnest(${modelIds}::text[], ${sinces}::timestamptz[]) AS s(model_id, since)
      ), recent AS (
        SELECT c.*
        FROM miniapp_analytics.chat_first_token_facts c
        JOIN scope s ON s.model_id = c.requested_model_id
        WHERE c.request_received_at >= GREATEST(
          s.since, now() - make_interval(hours => ${QUALITY_WINDOW_HOURS}::int))
      ), classified AS (
        SELECT requested_model_id AS model_id,
          delivery_role = 'primary' AS primary_delivered,
          COALESCE(delivery_role = 'primary' AND business_status = 'stream_interrupted'
            AND COALESCE(business_finish_reason, '') NOT IN ('user_cancelled', 'content_filter'),
            false) AS interrupted,
          COALESCE(delivery_role IS DISTINCT FROM 'primary'
            AND primary_end_reason IN ('upstream_error', 'stream_interrupted')
            AND primary_wait_ms IS NOT NULL
            AND primary_wait_ms + 50 >= COALESCE(primary_observed_until_ms, 0), false) AS error_fallback,
          business_finish_reason IS NOT DISTINCT FROM 'user_cancelled'
            AND NOT COALESCE(server_first_token_timeout, false) AS user_cancelled
        FROM recent
      )
      SELECT model_id,
        count(*)::int AS turns,
        (count(*) FILTER (WHERE primary_delivered IS NOT TRUE AND NOT error_fallback
          AND NOT user_cancelled))::int AS unusable_turns,
        (count(*) FILTER (WHERE error_fallback))::int AS error_fallback_turns,
        (count(*) FILTER (WHERE primary_delivered))::int AS primary_delivered_turns,
        (count(*) FILTER (WHERE interrupted))::int AS interrupted_turns
      FROM classified GROUP BY model_id`;
  });
  const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);
  return new Map(
    rows.map((row) => [
      row.model_id,
      {
        turns: row.turns,
        unusablePct: pct(row.unusable_turns, row.turns),
        errorFallbackPct: pct(row.error_fallback_turns, row.turns),
        // 交付轮次太少时中断率波动太大，不判这一项
        interruptedPct:
          row.primary_delivered_turns >= QUALITY_MIN_TURNS
            ? pct(row.interrupted_turns, row.primary_delivered_turns)
            : null,
        primaryDeliveredTurns: row.primary_delivered_turns,
        interruptedTurns: row.interrupted_turns,
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
            last_reason, last_metrics, evaluated_at, updated_at, pinned)
          VALUES (${s.candidateId}, ${item.surplusModel}, ${s.status}, ${s.providers}::text[],
            ${s.providerSince}::timestamptz, ${JSON.stringify(s.excludedProviders)}::jsonb,
            ${s.consecutivePasses}, ${s.cooldownUntil}::timestamptz, ${s.businessDelistsAt}::timestamptz[],
            ${s.lastReason?.slice(0, 2000) ?? null}, ${JSON.stringify(item.metrics)}::jsonb, now(), now(), ${s.pinned})
          ON CONFLICT (candidate_id) DO UPDATE SET
            surplus_model = EXCLUDED.surplus_model, status = EXCLUDED.status,
            providers = EXCLUDED.providers, provider_since = EXCLUDED.provider_since,
            excluded_providers = EXCLUDED.excluded_providers,
            consecutive_passes = EXCLUDED.consecutive_passes,
            cooldown_until = EXCLUDED.cooldown_until, business_delists_at = EXCLUDED.business_delists_at,
            last_reason = EXCLUDED.last_reason, last_metrics = EXCLUDED.last_metrics,
            evaluated_at = EXCLUDED.evaluated_at, updated_at = EXCLUDED.updated_at,
            pinned = EXCLUDED.pinned
          WHERE miniapp_features.free_zone_models.updated_at = ${item.version}::timestamptz`;
        if (written === 0) {
          skipped.push(s.candidateId);
          continue;
        }
        for (const event of item.events) {
          const row = eventRow(event, s.providers);
          await tx.$executeRaw`
            INSERT INTO ops.free_zone_events (candidate_id, event_type, cause, providers, reason, metrics)
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
          last_reason, updated_at, pinned)
        VALUES (${s.candidateId}, ${input.surplusModel}, ${s.status}, ${s.providers}::text[],
          ${s.providerSince}::timestamptz, ${JSON.stringify(s.excludedProviders)}::jsonb,
          ${s.consecutivePasses}, ${s.cooldownUntil}::timestamptz, ${s.businessDelistsAt}::timestamptz[],
          ${s.lastReason}, now(), ${s.pinned})
        ON CONFLICT (candidate_id) DO UPDATE SET
          surplus_model = EXCLUDED.surplus_model, status = EXCLUDED.status,
          providers = EXCLUDED.providers, provider_since = EXCLUDED.provider_since,
          excluded_providers = EXCLUDED.excluded_providers,
          consecutive_passes = EXCLUDED.consecutive_passes,
          cooldown_until = EXCLUDED.cooldown_until, business_delists_at = EXCLUDED.business_delists_at,
          last_reason = EXCLUDED.last_reason, updated_at = EXCLUDED.updated_at,
          pinned = EXCLUDED.pinned`;
      const eventData = eventRow(event, s.providers);
      await tx.$executeRaw`
        INSERT INTO ops.free_zone_events (candidate_id, event_type, cause, providers, reason)
        VALUES (${s.candidateId}, ${event.type}, ${eventData.cause}, ${eventData.providers}::text[],
          ${eventData.reason})`;
      return { kind: 'saved', previous, state: s };
    },
    { timeout: 10_000, maxWait: 5_000 }
  );
}

export type DelistingOutcome =
  | { kind: 'saved'; previous: FreeZoneModelState; state: FreeZoneModelState }
  | { kind: 'not_listed' }
  /** build 判断不该下架（例如这期间供应商已经换了） */
  | { kind: 'unchanged' };

/**
 * 评估之外的下架落库（运营手动下架、真实请求派不出去）：锁住这一行，确认在架，
 * 按 build 算出新状态写回并记一条下架事件；build 返回 null 表示不动。
 * 只更新已有的行（在架必然有行），所以不需要 surplus_model，移出候选池的行也能收掉。
 * 写入会刷新 updated_at，正在推算的评估看到版本变了就不会覆盖。
 */
export async function saveDelisting(input: {
  candidateId: string;
  build: (
    current: FreeZoneModelState
  ) => { state: FreeZoneModelState; event: FreeZoneEvent } | null;
}): Promise<DelistingOutcome> {
  return prisma.$transaction(
    async (tx): Promise<DelistingOutcome> => {
      const [row] = await tx.$queryRaw<StateRow[]>`
        SELECT ${STATE_COLUMNS} FROM miniapp_features.free_zone_models
        WHERE candidate_id = ${input.candidateId} FOR UPDATE`;
      const previous = row ? toState(row) : null;
      if (previous?.status !== 'listed') return { kind: 'not_listed' };
      const built = input.build(previous);
      if (!built) return { kind: 'unchanged' };
      const { state: s, event } = built;
      await tx.$executeRaw`
        UPDATE miniapp_features.free_zone_models SET
          status = ${s.status}, providers = ${s.providers}::text[],
          provider_since = ${s.providerSince}::timestamptz,
          consecutive_passes = ${s.consecutivePasses}, cooldown_until = ${s.cooldownUntil}::timestamptz,
          last_reason = ${s.lastReason}, pinned = ${s.pinned}, updated_at = now()
        WHERE candidate_id = ${s.candidateId}`;
      const eventData = eventRow(event, s.providers);
      await tx.$executeRaw`
        INSERT INTO ops.free_zone_events (candidate_id, event_type, cause, providers, reason)
        VALUES (${s.candidateId}, ${event.type}, ${eventData.cause}, ${previous.providers}::text[],
          ${eventData.reason})`;
      return { kind: 'saved', previous, state: s };
    },
    { timeout: 10_000, maxWait: 5_000 }
  );
}

/**
 * 这个用户过去 24 小时在每个有上限的免费模型上用了几轮：只数成功的轮次（含重新生成），
 * 按开轮时的模型算（兜底交付的也算这个免费模型的）。用满的同时给出恢复时间：
 * 还在算数的最早那一轮（倒数第 limit 轮）滑出 24 小时的时刻。
 */
export async function loadFreeZoneTurnUsage(
  userId: string,
  limits: ReadonlyArray<{ modelId: string; limit: number }>
): Promise<Map<string, { turns: number; resetsAt: string | null }>> {
  if (limits.length === 0) return new Map();
  const ids = limits.map((item) => item.modelId);
  const caps = limits.map((item) => item.limit);
  const rows = await prisma.$queryRaw<
    Array<{ model_id: string; turns: number; resets_at: Date | null }>
  >`
    WITH limits AS (
      SELECT * FROM unnest(${ids}::text[], ${caps}::int[]) AS l(model_id, max_turns)
    ), turns AS (
      SELECT g.requested_model_id AS model_id, h.created_at,
        row_number() OVER (PARTITION BY g.requested_model_id ORDER BY h.created_at DESC) AS rn
      FROM experience.chat_history h
      JOIN experience.chat_generation_requests g ON g.chat_history_id = h.id
      WHERE h.user_id = ${userId}::uuid
        AND h.created_at >= now() - interval '24 hours'
        AND h.status = 'success'
        AND g.requested_model_id = ANY(${ids}::text[])
    )
    SELECT t.model_id, count(*)::int AS turns,
      max(t.created_at) FILTER (WHERE t.rn = l.max_turns) + interval '24 hours' AS resets_at
    FROM turns t JOIN limits l USING (model_id)
    GROUP BY t.model_id`;
  return new Map(
    rows.map((row) => [
      row.model_id,
      { turns: row.turns, resetsAt: row.resets_at?.toISOString() ?? null },
    ])
  );
}

/**
 * 运营点「保上」/ 取消保上：只改 pinned 这一列，其余状态原样不动；还没有这一行就按初始状态建一行。
 * 写入刷新 updated_at，正在推算的评估看到版本变了就不会覆盖。返回写入后的状态。
 */
export async function savePinned(input: {
  candidateId: string;
  surplusModel: string;
  pinned: boolean;
}): Promise<FreeZoneModelState> {
  const [row] = await prisma.$queryRaw<StateRow[]>`
    INSERT INTO miniapp_features.free_zone_models (candidate_id, surplus_model, status, pinned, updated_at)
    VALUES (${input.candidateId}, ${input.surplusModel}, 'unlisted', ${input.pinned}, now())
    ON CONFLICT (candidate_id) DO UPDATE SET pinned = EXCLUDED.pinned, updated_at = now()
    RETURNING ${STATE_COLUMNS}`;
  if (!row) throw new Error('save pinned returned no row');
  return toState(row);
}
