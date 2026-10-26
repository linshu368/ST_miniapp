import { z } from 'zod';

export const DRAMA_TIMING_BODY_LIMIT = 32 * 1024;
export const DRAMA_TIMING_UPLOAD_TIMEOUT_MS = 5_000;

// 标识只用于串联日志；允许旧 WebView 的 web-* fallback，但不接受 URL 或任意正文。
const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const Duration = z.number().finite().nonnegative();
const Offset = z.number().finite();

export const DramaTimingReportSchema = z
  .object({
    type: z.enum(['list', 'playback']),
    phase: z.enum(['slow', 'final']),
    id: Id,
    entry: z.enum(['cover', 'switch', 'episode', 'retry', 'direct']).optional(),
    dramaId: Id.optional(),
    videoId: Id.optional(),
    outcome: z.enum([
      'playing',
      'error',
      'unplayable',
      'autoplay_blocked',
      'switched',
      'left',
      'background',
      'ready',
      'waiting',
    ]),
    elapsedMs: Duration,
    marks: z
      .object({
        player_ready: Duration.optional(),
        address_ready: Duration.optional(),
        source_set: Duration.optional(),
        metadata: Duration.optional(),
        first_frame: Duration.optional(),
        playing: Duration.optional(),
      })
      .strict(),
    stages: z
      .object({
        navigation: Duration.optional(),
        address_wait: Duration.optional(),
        address_to_source: Duration.optional(),
        source_to_metadata: Duration.optional(),
        metadata_to_frame: Duration.optional(),
        source_to_frame: Duration.optional(),
        source_to_playing: Duration.optional(),
      })
      .strict(),
    addressSource: z.enum(['fetch', 'inflight', 'cache', 'unknown']).optional(),
    frameMethod: z.enum(['video_frame_callback', 'playing_and_timeupdate']).optional(),
    list: z
      .object({
        id: Id,
        readyMs: Duration.optional(),
        browseMs: Duration.optional(),
        sinceEntryMs: Duration,
        startKind: z.enum([
          'navigation_click',
          'route_commit',
          'query_start',
          'document_navigation',
          'retry',
        ]),
      })
      .strict()
      .optional(),
    cover: z
      .object({
        outcome: z.enum(['loaded', 'error', 'pending', 'absent']),
        loadMs: Duration.optional(),
      })
      .strict()
      .optional(),
    queryDetailsTruncated: z.boolean().optional(),
    queries: z
      .array(
        z
          .object({
            kind: z.enum(['list', 'queue', 'detail', 'playback']),
            // 进入页面前已在途的请求具有负偏移，不能截断成零。
            startMs: Offset,
            durationMs: Duration,
            outcome: z.enum(['ok', 'error', 'unknown', 'pending']),
            attemptsTruncated: z.boolean().optional(),
            attempts: z
              .array(
                z
                  .object({
                    requestId: Id,
                    startMs: Offset,
                    queueMs: Duration.optional(),
                    headersMs: Duration.optional(),
                    bodyMs: Duration.optional(),
                    totalMs: Duration,
                    outcome: z.enum([
                      'ok',
                      'timeout',
                      'aborted',
                      'http_error',
                      'error',
                      'unknown',
                      'pending',
                    ]),
                    status: z.number().int().min(100).max(599).optional(),
                  })
                  .strict()
              )
              .max(4),
          })
          .strict()
      )
      .max(12),
  })
  .strict();

export type DramaTimingReport = z.infer<typeof DramaTimingReportSchema>;

export const PostDramaTimingDataSchema = z.object({ accepted: z.literal(true) }).strict();
export type PostDramaTimingData = z.infer<typeof PostDramaTimingDataSchema>;

/** 浏览器和 Railway 采用同一字段口径；只能传入允许字段的计时报告。 */
export function dramaTimingLogFields(report: DramaTimingReport) {
  return {
    event: 'drama.frontend_timing',
    source: 'frontend',
    observation_id: report.id,
    list_id: report.list?.id,
    drama_id: report.dramaId,
    video_id: report.videoId,
    type: report.type,
    phase: report.phase,
    entry: report.entry,
    outcome: report.outcome,
    elapsed_ms: report.elapsedMs,
    address_source: report.addressSource,
    frame_method: report.frameMethod,
    ...Object.fromEntries(
      Object.entries(report.stages).map(([key, value]) => [`${key}_ms`, value])
    ),
    list_ready_ms: report.list?.readyMs,
    browse_ms: report.list?.browseMs,
    since_list_entry_ms: report.list?.sinceEntryMs,
    list_start_kind: report.list?.startKind,
    cover_outcome: report.cover?.outcome,
    cover_load_ms: report.cover?.loadMs,
    request_ids: report.queries.flatMap((query) =>
      query.attempts.map((attempt) => attempt.requestId)
    ),
    marks: report.marks,
    queries: report.queries,
    query_details_truncated: report.queryDetailsTruncated,
  };
}
