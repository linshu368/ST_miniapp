/**
 * 把运维导出的 Railway 日志行解析回短剧计时报告，供 compare-drama-cdn 做 AB 分组对比。
 * 只读解析，不写任何数据库；sampled diagnostic 不计入对比总体。
 */
import { DramaTimingReportSchema, type DramaTimingReport } from '@miniapp/shared';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function railwayDramaReport(
  value: unknown,
  includeSeek = false
):
  | {
      report: DramaTimingReport;
      receivedAt: string;
      environment?: string;
      serverRelease?: string;
      experimentId?: string;
      experimentUser?: string;
      assignedGroup?: 'bunny' | 'supabase';
    }
  | undefined {
  const outer = object(value);
  if (!outer) return;
  let fields: Record<string, unknown> = { ...outer, ...object(decoded(outer.message)) };
  if (Array.isArray(outer.attributes)) {
    for (const item of outer.attributes) {
      const attribute = object(item);
      if (typeof attribute?.key === 'string') fields[attribute.key] = decoded(attribute.value);
    }
  } else if (object(outer.attributes)) {
    for (const [key, value] of Object.entries(object(outer.attributes)!))
      fields[key] = decoded(value);
  }
  if (
    fields.event !== 'drama.frontend_timing' ||
    (fields.type !== 'playback' && !(includeSeek && fields.type === 'seek'))
  )
    return;
  // Historical imports keep rejecting unified diagnostics; the comparison is read-only.
  if (fields.purpose === 'diagnostic' && !includeSeek) return;
  const stages = Object.fromEntries(
    [
      'navigation',
      'address_wait',
      'address_to_source',
      'source_to_metadata',
      'metadata_to_frame',
      'source_to_frame',
      'source_to_playing',
      'entry_to_source',
      'metadata_to_data',
      'data_to_frame',
      'frame_to_startup',
    ].flatMap((name) => (fields[`${name}_ms`] === undefined ? [] : [[name, fields[`${name}_ms`]]]))
  );
  // Rebuild an allowlist report, never pass the log envelope or arbitrary attributes to storage.
  const report = DramaTimingReportSchema.parse({
    type: fields.type,
    phase: fields.phase,
    id: fields.observation_id,
    version: fields.version,
    definition: fields.definition,
    purpose: fields.purpose,
    route: fields.route,
    context: decoded(fields.context),
    diagnostics: decoded(fields.diagnostics),
    delivery: decoded(fields.delivery),
    recovery: decoded(fields.recovery),
    entryElapsedMs: fields.entry_elapsed_ms,
    overFiveSeconds: fields.over_five_seconds,
    seek: decoded(fields.seek),
    entry: fields.entry,
    dramaId: fields.drama_id,
    videoId: fields.video_id,
    outcome: fields.outcome,
    elapsedMs: fields.elapsed_ms,
    marks: decoded(fields.marks),
    stages,
    addressSource: fields.address_source,
    frameMethod: fields.frame_method,
    queries: decoded(fields.queries),
    media: decoded(fields.media),
    queryDetailsTruncated: fields.query_details_truncated,
  });
  const time = fields.time ?? outer.timestamp;
  if (typeof time !== 'string' && typeof time !== 'number')
    throw new Error('missing_log_timestamp');
  const date = new Date(time);
  if (!Number.isFinite(date.valueOf())) throw new Error('invalid_log_timestamp');
  return {
    report,
    receivedAt: date.toISOString(),
    environment: typeof fields.environment === 'string' ? fields.environment : undefined,
    serverRelease: typeof fields.server_release === 'string' ? fields.server_release : undefined,
    experimentId: typeof fields.experiment_id === 'string' ? fields.experiment_id : undefined,
    experimentUser:
      typeof fields.experiment_user === 'string' && /^[a-f0-9]{64}$/.test(fields.experiment_user)
        ? fields.experiment_user
        : undefined,
    assignedGroup:
      fields.assigned_group === 'bunny' || fields.assigned_group === 'supabase'
        ? fields.assigned_group
        : undefined,
  };
}
