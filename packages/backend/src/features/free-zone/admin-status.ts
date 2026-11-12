/**
 * 运营平台「线上状态」：评估任务落库的当前状态 + 最近的上下架记录。只读。
 * 候选按已发布配置的顺序排；已从候选池删掉、表里还留着记录的排在最后。
 */
import type {
  AdminFreeZoneEvent,
  AdminFreeZoneStatusModel,
  AdminFreeZoneStatusResponse,
  FreeZoneConfig,
} from '@miniapp/shared';
import { prisma } from '../../lib/db.js';

const EVENT_LIMIT = 30;

interface StatusRow {
  candidate_id: string;
  surplus_model: string;
  status: 'unlisted' | 'listed' | 'cooling';
  providers: string[];
  provider_since: Date | null;
  excluded_providers: Record<string, string> | null;
  consecutive_passes: number;
  cooldown_until: Date | null;
  last_reason: string | null;
  evaluated_at: Date | null;
}

interface EventRow {
  candidate_id: string;
  event_type: AdminFreeZoneEvent['event_type'];
  cause: 'official' | 'business' | null;
  providers: string[] | null;
  reason: string | null;
  created_at: Date;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function buildFreeZoneStatus(
  config: FreeZoneConfig,
  rows: StatusRow[],
  events: EventRow[]
): AdminFreeZoneStatusResponse {
  const byId = new Map(rows.map((row) => [row.candidate_id, row]));
  const fromRow = (row: StatusRow | undefined) => ({
    status: row?.status ?? null,
    providers: row?.providers ?? [],
    provider_since: iso(row?.provider_since ?? null),
    consecutive_passes: row?.consecutive_passes ?? 0,
    cooldown_until: iso(row?.cooldown_until ?? null),
    excluded_providers: row?.excluded_providers ?? {},
    last_reason: row?.last_reason ?? null,
    evaluated_at: iso(row?.evaluated_at ?? null),
  });
  const configured: AdminFreeZoneStatusModel[] = config.candidates.map((candidate) => ({
    candidate_id: candidate.id,
    display_name: candidate.display_name,
    surplus_model: candidate.surplus_model,
    in_config: true,
    ...fromRow(byId.get(candidate.id)),
  }));
  const ids = new Set(config.candidates.map((candidate) => candidate.id));
  const removed: AdminFreeZoneStatusModel[] = rows
    .filter((row) => !ids.has(row.candidate_id))
    .map((row) => ({
      candidate_id: row.candidate_id,
      display_name: null,
      surplus_model: row.surplus_model,
      in_config: false,
      ...fromRow(row),
    }));
  const evaluated = rows.flatMap((row) => (row.evaluated_at ? [row.evaluated_at.getTime()] : []));
  return {
    enabled: config.enabled,
    required_passes: config.relist.required_passes,
    last_evaluated_at: evaluated.length ? new Date(Math.max(...evaluated)).toISOString() : null,
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
  const [rows, events] = await Promise.all([
    prisma.$queryRaw<StatusRow[]>`
      SELECT candidate_id, surplus_model, status, providers, provider_since, excluded_providers,
        consecutive_passes, cooldown_until, last_reason, evaluated_at
      FROM miniapp_features.free_zone_models`,
    prisma.$queryRaw<EventRow[]>`
      SELECT candidate_id, event_type, cause, providers, reason, created_at
      FROM miniapp_features.free_zone_events
      ORDER BY created_at DESC
      LIMIT ${EVENT_LIMIT}`,
  ]);
  return buildFreeZoneStatus(config, rows, events);
}
