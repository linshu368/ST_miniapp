/**
 * 畅聊状态表的读写。表结构见 migrations/20261112_free_zone.sql。
 *
 * 写入：运营手动上架 / 下架 / 保上，真实请求连续拒单自动下架。上下架都锁住这一行、确认当前状态再写，并记一条事件。
 * 表里的 cooldown_until、excluded_providers、consecutive_passes、business_delists_at、evaluated_at
 * 是已删除的评估机制留下的列，不再读写（cooldown_until 上架时清空），等收缩迁移删除；pinned 11-26 起重新使用。
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/db.js';
import type { FreeZoneEvent, FreeZoneModelState } from './lifecycle.js';
import type { MarketDirectPrice } from './surplus-market.js';

interface StateRow {
  candidate_id: string;
  /** cooling 是旧机制的状态，按未上架处理 */
  status: 'unlisted' | 'listed' | 'cooling';
  providers: string[];
  provider_since: Date | null;
  last_reason: string | null;
  pinned: boolean;
}

const STATE_COLUMNS = Prisma.sql`candidate_id, status, providers, provider_since, last_reason, pinned`;

function toState(row: StateRow): FreeZoneModelState {
  return {
    candidateId: row.candidate_id,
    status: row.status === 'listed' ? 'listed' : 'unlisted',
    providers: row.providers,
    providerSince: row.provider_since?.toISOString() ?? null,
    lastReason: row.last_reason,
    pinned: row.pinned,
  };
}

export async function loadFreeZoneStates(): Promise<Map<string, FreeZoneModelState>> {
  const rows = await prisma.$queryRaw<StateRow[]>`
    SELECT ${STATE_COLUMNS} FROM features.free_zone_models`;
  return new Map(rows.map((row) => [row.candidate_id, toState(row)]));
}

function eventRow(event: FreeZoneEvent): { cause: string | null; reason: string | null } {
  return event.type === 'listed'
    ? { cause: null, reason: '运营手动上架' }
    : { cause: event.cause, reason: event.reasons.join('；').slice(0, 2000) };
}

/** 选供应商时看到的原价，运营平台据此定折扣底线；没选（指定了供应商）就不动旧值 */
function metricsJson(directPrice: MarketDirectPrice | null): string | null {
  if (!directPrice) return null;
  return JSON.stringify({
    direct_price: {
      input_per_1m: directPrice.inputPer1m,
      output_per_1m: directPrice.outputPer1m,
      source: directPrice.source,
    },
  });
}

export type ManualListingOutcome =
  | { kind: 'saved'; previous: FreeZoneModelState | null; state: FreeZoneModelState }
  | { kind: 'already_listed'; providers: string[] };

/** 运营手动上架落库：锁住这一行，确认不在架，按 build 算出新状态覆盖写并记一条上架事件。 */
export async function saveManualListing(input: {
  candidateId: string;
  surplusModel: string;
  directPrice: MarketDirectPrice | null;
  build: (current: FreeZoneModelState | null) => {
    state: FreeZoneModelState;
    event: FreeZoneEvent;
  };
}): Promise<ManualListingOutcome> {
  return prisma.$transaction(
    async (tx): Promise<ManualListingOutcome> => {
      const [row] = await tx.$queryRaw<StateRow[]>`
        SELECT ${STATE_COLUMNS} FROM features.free_zone_models
        WHERE candidate_id = ${input.candidateId} FOR UPDATE`;
      const previous = row ? toState(row) : null;
      if (previous?.status === 'listed') {
        return { kind: 'already_listed', providers: previous.providers };
      }
      const { state: s, event } = input.build(previous);
      const metrics = metricsJson(input.directPrice);
      await tx.$executeRaw`
        INSERT INTO features.free_zone_models (candidate_id, surplus_model, status, providers,
          provider_since, cooldown_until, last_reason, last_metrics, updated_at)
        VALUES (${s.candidateId}, ${input.surplusModel}, ${s.status}, ${s.providers}::text[],
          ${s.providerSince}::timestamptz, NULL, ${s.lastReason},
          COALESCE(${metrics}::jsonb, '{}'::jsonb), now())
        ON CONFLICT (candidate_id) DO UPDATE SET
          surplus_model = EXCLUDED.surplus_model, status = EXCLUDED.status,
          providers = EXCLUDED.providers, provider_since = EXCLUDED.provider_since,
          cooldown_until = NULL, last_reason = EXCLUDED.last_reason,
          last_metrics = COALESCE(${metrics}::jsonb, features.free_zone_models.last_metrics),
          updated_at = EXCLUDED.updated_at`;
      const eventData = eventRow(event);
      await tx.$executeRaw`
        INSERT INTO ops.free_zone_events (candidate_id, event_type, cause, providers, reason)
        VALUES (${s.candidateId}, ${event.type}, ${eventData.cause}, ${s.providers}::text[],
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
 * 下架落库（运营手动下架、连续拒单）：锁住这一行，确认在架，按 build 算出新状态写回并记一条下架事件；
 * build 返回 null 表示不动。只更新已有的行（在架必然有行），移出候选池的行也能收掉。
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
        SELECT ${STATE_COLUMNS} FROM features.free_zone_models
        WHERE candidate_id = ${input.candidateId} FOR UPDATE`;
      const previous = row ? toState(row) : null;
      if (previous?.status !== 'listed') return { kind: 'not_listed' };
      const built = input.build(previous);
      if (!built) return { kind: 'unchanged' };
      const { state: s, event } = built;
      await tx.$executeRaw`
        UPDATE features.free_zone_models SET
          status = ${s.status}, providers = ${s.providers}::text[],
          provider_since = ${s.providerSince}::timestamptz, cooldown_until = NULL,
          last_reason = ${s.lastReason}, pinned = ${s.pinned}, updated_at = now()
        WHERE candidate_id = ${s.candidateId}`;
      const eventData = eventRow(event);
      await tx.$executeRaw`
        INSERT INTO ops.free_zone_events (candidate_id, event_type, cause, providers, reason)
        VALUES (${s.candidateId}, ${event.type}, ${eventData.cause}, ${previous.providers}::text[],
          ${eventData.reason})`;
      return { kind: 'saved', previous, state: s };
    },
    { timeout: 10_000, maxWait: 5_000 }
  );
}

/** 运营保上 / 取消保上：只改标记，不动在架状态；没有行就建一行未上架的 */
export async function savePinned(input: {
  candidateId: string;
  surplusModel: string;
  pinned: boolean;
}): Promise<FreeZoneModelState> {
  const [row] = await prisma.$queryRaw<StateRow[]>`
    INSERT INTO features.free_zone_models (candidate_id, surplus_model, status, pinned, updated_at)
    VALUES (${input.candidateId}, ${input.surplusModel}, 'unlisted', ${input.pinned}, now())
    ON CONFLICT (candidate_id) DO UPDATE SET pinned = EXCLUDED.pinned, updated_at = now()
    RETURNING ${STATE_COLUMNS}`;
  if (!row) throw new Error('save pinned returned no row');
  return toState(row);
}

/**
 * 这个用户从 since 起在这些免费模型上各用了几轮：只数成功的轮次（含重新生成），
 * 按开轮时的模型算（兜底交付的也算这个免费模型的）。没用过的模型不在结果里。
 */
export async function loadFreeZoneTurnUsage(
  userId: string,
  modelIds: readonly string[],
  since: Date
): Promise<Map<string, number>> {
  if (modelIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ model_id: string; turns: number }>>`
    SELECT g.requested_model_id AS model_id, count(*)::int AS turns
    FROM experience.chat_history h
    JOIN experience.chat_generation_requests g ON g.chat_history_id = h.id
    WHERE h.user_id = ${userId}::uuid
      AND h.created_at >= ${since.toISOString()}::timestamptz
      AND h.status = 'success'
      AND g.requested_model_id = ANY(${[...modelIds]}::text[])
    GROUP BY g.requested_model_id`;
  return new Map(rows.map((row) => [row.model_id, row.turns]));
}
