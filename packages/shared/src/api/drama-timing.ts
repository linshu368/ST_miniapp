import { z } from 'zod';

export const DRAMA_TIMING_BODY_LIMIT = 32 * 1024;
export const DRAMA_TIMING_UPLOAD_TIMEOUT_MS = 5_000;
export const DRAMA_TIMING_MAX_MEDIA_EVENTS = 32;
export const DRAMA_TIMING_MAX_RESOURCES = 16;
export const DRAMA_TIMING_DEFINITION = 'drama_v3';

// 标识只用于串联日志；允许旧 WebView 的 web-* fallback，但不接受 URL 或任意正文。
const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const Duration = z.number().finite().nonnegative();
const Offset = z.number().finite();
const Label = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);

const ResourceSchema = z
  .object({
    startMs: Offset,
    fetchStartMs: Offset,
    requestStartMs: Offset.optional(),
    responseStartMs: Offset.optional(),
    responseEndMs: Offset,
    dnsMs: Duration.optional(),
    connectMs: Duration.optional(),
    tlsMs: Duration.optional(),
    ttfbMs: Duration.optional(),
    responseMs: Duration.optional(),
    encodedBodyBytes: z.number().int().nonnegative().max(1e12).optional(),
    transferBytes: z.number().int().nonnegative().max(1e12).optional(),
    protocol: z.enum(['h2', 'h3', 'http1', 'other']).optional(),
    visibility: z.enum(['detailed', 'limited']),
  })
  .strict();

const NetworkSchema = z
  .object({
    status: z.enum(['unsupported', 'no_entry', 'limited', 'available']),
    entries: z.array(ResourceSchema).max(DRAMA_TIMING_MAX_RESOURCES),
    truncated: z.boolean(),
    closed: z.enum(['deadline', 'terminal_tail', 'released']).optional(),
  })
  .strict();

const DiagnosticsSchema = z
  .object({
    network: NetworkSchema.optional(),
    frame: z
      .object({
        callbackAtMs: Duration,
        presentationAtMs: Offset.optional(),
        expectedDisplayAtMs: Offset.optional(),
        processingMs: Duration.optional(),
        width: z.number().int().min(1).max(32768).optional(),
        height: z.number().int().min(1).max(32768).optional(),
      })
      .strict()
      .optional(),
    longTasks: z
      .object({
        support: z.enum(['supported', 'unsupported']),
        count: z.number().int().nonnegative().max(100000),
        totalMs: Duration,
        maxMs: Duration,
        metadataToFrameMs: Duration.optional(),
        truncated: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MediaStateSchema = z
  .object({
    readyState: z.number().int().min(0).max(4),
    networkState: z.number().int().min(0).max(3),
    paused: z.boolean(),
    muted: z.boolean(),
    seeking: z.boolean(),
    currentTimeMs: Duration.optional(),
    bufferedAheadMs: Duration.optional(),
    visibility: z.enum(['visible', 'hidden', 'unknown']),
  })
  .strict();

const MediaEventSchema = z
  .object({
    name: z.enum([
      'play_called',
      'play_resolved',
      'play_rejected',
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'play',
      'playing',
      'first_frame',
      'waiting',
      'stalled',
      'suspend',
      'pause',
      'user_play',
      'user_pause',
      'user_retry',
      'visibility_hidden',
      'pagehide',
    ]),
    atMs: Duration,
    trigger: z.enum(['automatic', 'user']).optional(),
    error: z.enum(['not_allowed', 'aborted', 'not_supported', 'other']).optional(),
    state: MediaStateSchema.optional(),
  })
  .strict();

export const DramaTimingReportSchema = z
  .object({
    type: z.enum(['list', 'playback']),
    phase: z.enum(['start', 'slow', 'final', 'network']),
    version: z.literal(2).optional(),
    definition: z.literal(DRAMA_TIMING_DEFINITION).optional(),
    route: z.enum(['/', '/dramas', '/dramas/:id']).optional(),
    // Unified diagnostics remain logs; they must never re-enter analytics storage.
    purpose: z.literal('diagnostic').optional(),
    context: z
      .object({
        release: Label,
        sessionId: Id,
        platform: z.enum(['ios', 'android', 'desktop', 'unknown']),
        browser: z.enum(['webkit', 'chromium', 'firefox', 'other']),
        browserMajor: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
    diagnostics: DiagnosticsSchema.optional(),
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
        play_called: Duration.optional(),
        play_resolved: Duration.optional(),
        play_rejected: Duration.optional(),
        loadeddata: Duration.optional(),
        canplay: Duration.optional(),
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
        entry_to_source: Duration.optional(),
        metadata_to_data: Duration.optional(),
        data_to_frame: Duration.optional(),
        frame_to_startup: Duration.optional(),
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
    media: z
      .object({
        events: z.array(MediaEventSchema).max(DRAMA_TIMING_MAX_MEDIA_EVENTS),
        eventsTruncated: z.boolean(),
        snapshot: MediaStateSchema.optional(),
      })
      .strict()
      .optional(),
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
  .strict()
  .superRefine((report, ctx) => {
    if (
      (report.phase === 'start' || report.phase === 'network') &&
      (report.version !== 2 || report.type !== 'playback')
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Phase requires v2 playback' });
    }
    if (report.version === 2 && !report.context) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'v2 requires context' });
    }
    if (report.phase === 'start' && report.outcome !== 'waiting') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Start must be waiting' });
    }
  });

export type DramaTimingReport = z.infer<typeof DramaTimingReportSchema>;
export type DramaMediaState = z.infer<typeof MediaStateSchema>;
export type DramaMediaEvent = z.infer<typeof MediaEventSchema>;
export type DramaNetworkTiming = z.infer<typeof NetworkSchema>;
export type DramaResourceTiming = z.infer<typeof ResourceSchema>;
export type DramaStartupDiagnostics = z.infer<typeof DiagnosticsSchema>;

/** One definition for browser reports and server diagnostics. Missing/reversed
 * intervals stay absent: zero would incorrectly turn unknown timing into fast timing. */
export function dramaTimingStages(marks: DramaTimingReport['marks']): DramaTimingReport['stages'] {
  const stages: DramaTimingReport['stages'] = {};
  const between = (
    key: keyof DramaTimingReport['stages'],
    start: number | undefined,
    end: number | undefined
  ) => {
    if (
      start !== undefined &&
      end !== undefined &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end >= start
    )
      stages[key] = Math.round((end - start) * 10) / 10;
  };
  between('navigation', 0, marks.player_ready);
  between('address_wait', 0, marks.address_ready);
  between('address_to_source', marks.address_ready, marks.source_set);
  between('entry_to_source', 0, marks.source_set);
  between('source_to_metadata', marks.source_set, marks.metadata);
  between('metadata_to_frame', marks.metadata, marks.first_frame);
  between('metadata_to_data', marks.metadata, marks.loadeddata);
  between('data_to_frame', marks.loadeddata, marks.first_frame);
  between('source_to_frame', marks.source_set, marks.first_frame);
  between('source_to_playing', marks.source_set, marks.playing);
  if (marks.first_frame !== undefined && marks.playing !== undefined)
    between('frame_to_startup', marks.first_frame, Math.max(marks.first_frame, marks.playing));
  return stages;
}

export const PostDramaTimingDataSchema = z
  .object({
    accepted: z.literal(true),
    persisted: z.boolean().optional(),
  })
  .strict();
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
    version: report.version,
    definition: report.definition,
    route: report.route,
    purpose: report.purpose,
    context: report.context,
    diagnostics: report.diagnostics,
    entry: report.entry,
    outcome: report.outcome,
    elapsed_ms: report.elapsedMs,
    address_source: report.addressSource,
    frame_method: report.frameMethod,
    ...Object.fromEntries(
      Object.entries(report.definition ? dramaTimingStages(report.marks) : report.stages).map(
        ([key, value]) => [`${key}_ms`, value]
      )
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
    media: report.media,
  };
}
