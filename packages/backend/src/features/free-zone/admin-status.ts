/**
 * 运营平台「线上状态」：候选模型现在在不在架 + 最近的上下架记录。只读。
 * 候选按已发布配置的顺序排；已从候选池删掉、表里还留着记录的排在最后。
 */
import {
  FreeZoneDirectPriceSchema,
  type AdminFreeZoneEvent,
  type AdminFreeZoneStatusModel,
  type AdminFreeZoneStatusResponse,
  type FreeZoneConfig,
  type FreeZoneDirectPrice,
} from '@miniapp/shared';
import { prisma } from '../../lib/db.js';

const EVENT_LIMIT = 30;

interface StatusRow {
  candidate_id: string;
  surplus_model: string;
  /** cooling 是旧机制的状态，按未上架显示 */
  status: 'unlisted' | 'listed' | 'cooling';
  providers: string[];
  provider_since: Date | null;
  last_metrics: Record<string, unknown> | null;
  pinned: boolean;
}

/** 每个候选的上下架历史摘要：上过架没有、最近一次下架的原因 */
interface HistoryRow {
  candidate_id: string;
  ever_listed: boolean;
  last_delist_cause: 'official' | 'business' | null;
  last_delist_reason: string | null;
  last_delisted_at: Date | null;
}

interface EventRow {
  candidate_id: string;
  event_type: AdminFreeZoneEvent['event_type'];
  cause: 'official' | 'business' | null;
  providers: string[] | null;
  reason: string | null;
  created_at: Date;
}

/** last_metrics.direct_price：最近一次自动选供应商上架时 Surplus 标的原价 */
function directPrice(metrics: Record<string, unknown> | null): FreeZoneDirectPrice | null {
  const parsed = FreeZoneDirectPriceSchema.safeParse(metrics?.direct_price);
  return parsed.success ? parsed.data : null;
}

export function buildFreeZoneStatus(
  config: FreeZoneConfig,
  rows: StatusRow[],
  events: EventRow[],
  history: HistoryRow[] = []
): AdminFreeZoneStatusResponse {
  const byId = new Map(rows.map((row) => [row.candidate_id, row]));
  const historyById = new Map(history.map((row) => [row.candidate_id, row]));
  const details = (id: string) => {
    const row = byId.get(id);
    const item = historyById.get(id);
    const listed = row?.status === 'listed';
    return {
      status: listed ? ('listed' as const) : ('unlisted' as const),
      pinned: row?.pinned ?? false,
      providers: listed ? row.providers : [],
      provider_since: listed ? (row.provider_since?.toISOString() ?? null) : null,
      direct_price: directPrice(row?.last_metrics ?? null),
      ever_listed: item?.ever_listed ?? false,
      last_delist: item?.last_delisted_at
        ? {
            cause: item.last_delist_cause,
            at: item.last_delisted_at.toISOString(),
            reason: item.last_delist_reason,
          }
        : null,
    };
  };
  const configured: AdminFreeZoneStatusModel[] = config.candidates.map((candidate) => ({
    candidate_id: candidate.id,
    display_name: candidate.display_name,
    surplus_model: candidate.surplus_model,
    in_config: true,
    ...details(candidate.id),
  }));
  const ids = new Set(config.candidates.map((candidate) => candidate.id));
  const removed: AdminFreeZoneStatusModel[] = rows
    .filter((row) => !ids.has(row.candidate_id))
    .map((row) => ({
      candidate_id: row.candidate_id,
      display_name: null,
      surplus_model: row.surplus_model,
      in_config: false,
      ...details(row.candidate_id),
    }));
  return {
    enabled: config.enabled,
    models: [...configured, ...removed],
    events: events.map((event) => ({
      candidate_id: event.candidate_id,
      event_type: event.event_type,
      cause: event.cause,
      providers: event.providers ?? [],
      reason: event.reason,
      created_at: event.created_at.toISOString(),
    })),
  };
}

export async function loadFreeZoneStatus(
  config: FreeZoneConfig
): Promise<AdminFreeZoneStatusResponse> {
  const [rows, events, history] = await Promise.all([
    prisma.$queryRaw<StatusRow[]>`
      SELECT candidate_id, surplus_model, status, providers, provider_since, last_metrics, pinned
      FROM features.free_zone_models`,
    prisma.$queryRaw<EventRow[]>`
      SELECT candidate_id, event_type, cause, providers, reason, created_at
      FROM ops.free_zone_events
      ORDER BY created_at DESC
      LIMIT ${EVENT_LIMIT}`,
    prisma.$queryRaw<HistoryRow[]>`
      SELECT candidate_id,
        bool_or(event_type = 'listed') AS ever_listed,
        (array_agg(cause ORDER BY created_at DESC) FILTER (WHERE event_type = 'delisted'))[1]
          AS last_delist_cause,
        (array_agg(reason ORDER BY created_at DESC) FILTER (WHERE event_type = 'delisted'))[1]
          AS last_delist_reason,
        max(created_at) FILTER (WHERE event_type = 'delisted') AS last_delisted_at
      FROM ops.free_zone_events
      GROUP BY candidate_id`,
  ]);
  return buildFreeZoneStatus(config, rows, events, history);
}
