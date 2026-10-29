'use client';

import { dramaTimingLogFields, dramaTimingStages } from '@miniapp/shared';
import { uploadDramaTiming } from '@/lib/api/telemetry';
import { createLogger } from '@/lib/logger';
import { createRequestId } from './request-timing';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';
import {
  dramaCdnAttributes,
  isEngineeringTelemetryEnabled,
  recordEngineeringEvent,
  recordEngineeringMeasurement,
} from './grafana';
import { markPageFailed, markPageReady } from './page-tracker';

const log = createLogger('drama-timing');

/** Diagnostics are a separate view of the same observation, never a second timer. */
function mirrorDiagnostics(
  report: DramaTimingReport,
  attributes: Record<string, string | undefined>
): void {
  if (report.type !== 'playback' || !['final', 'network'].includes(report.phase)) return;
  const diagnostics = report.diagnostics;
  const network = diagnostics?.network;
  const attrs = {
    ...attributes,
    report_kind: report.phase,
    stage: 'diagnostic',
    network_status: network?.status ?? 'unknown',
    network_closed: network?.closed ?? 'pending',
    longtask_support: diagnostics?.longTasks?.support ?? 'unknown',
    detail_truncated: String(
      Boolean(
        network?.truncated ||
        diagnostics?.longTasks?.truncated ||
        report.media?.eventsTruncated ||
        report.queryDetailsTruncated ||
        report.queries.some((query) => query.attemptsTruncated)
      )
    ),
    event_order: [
      [report.marks.source_set, report.marks.metadata],
      [report.marks.metadata, report.marks.loadeddata],
      [report.marks.loadeddata, report.marks.first_frame],
    ].some(([start, end]) => start !== undefined && end !== undefined && end < start)
      ? 'anomaly'
      : 'ordered_or_missing',
  };
  recordEngineeringEvent('drama.diagnostic', attrs);
  const entries = network?.entries ?? [];
  const first = entries
    .filter((entry) => entry.ttfbMs !== undefined)
    .sort((a, b) => a.startMs - b.startMs)[0];
  const max = (values: (number | undefined)[]): number | undefined => {
    const known = values.filter(
      (value): value is number => value !== undefined && Number.isFinite(value)
    );
    return known.length ? Math.max(...known) : undefined;
  };
  const durations = {
    network_ttfb_first: first?.ttfbMs,
    network_ttfb_max: max(entries.map((entry) => entry.ttfbMs)),
    network_connect_max: max(entries.map((entry) => entry.connectMs)),
    // Network tail reports carry a copy of other diagnostics. Only final owns them.
    ...(report.phase === 'final'
      ? {
          frame_processing: diagnostics?.frame?.processingMs,
          longtask_metadata_frame:
            diagnostics?.longTasks?.support === 'supported'
              ? diagnostics.longTasks.metadataToFrameMs
              : undefined,
        }
      : {}),
  };
  for (const [stage, duration] of Object.entries(durations))
    if (duration !== undefined)
      recordEngineeringMeasurement('drama.diagnostic', duration, { ...attrs, stage });
}

/** Stable observation-level sampling keeps slow/final/network decisions aligned.
 * Preserve every >=5s report for the backend Loki diagnostic stream.
 * Performance aggregates are always emitted; sampling applies only to detailed logs. */
function diagnosticSample(report: DramaTimingReport): boolean {
  if (report.phase === 'start') return false;
  if (
    report.phase === 'slow' ||
    report.elapsedMs >= 5_000 ||
    !['playing', 'ready'].includes(report.outcome)
  )
    return true;
  let hash = 0;
  for (const character of report.id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return hash % 100 < 5;
}

/** Project the existing timing owner; never copy IDs, query details or media URLs. */
function mirrorEngineeringTiming(report: DramaTimingReport): void {
  // Seek has its own observation lifecycle and cannot enter startup denominators.
  if (report.type === 'seek') return;
  try {
    const attributes = {
      ...(report.type === 'playback' ? dramaCdnAttributes(report.delivery) : {}),
      // Budget and outcome travel together; an independently dropped measurement
      // cannot manufacture a faster rate. All final projections use the attempt clock.
      ...(report.type === 'playback' && report.phase === 'final'
        ? { cdn_budget: startupBudget(report) }
        : {}),
      route: report.route ?? (report.type === 'list' ? '/dramas' : '/dramas/:id'),
      list_start_kind: report.type === 'list' ? report.list?.startKind : undefined,
      report_kind: report.type,
      stage: report.type === 'list' ? 'catalog' : 'startup',
      outcome: report.outcome,
      playback_mode: report.entry,
      cache: report.addressSource ?? 'unknown',
      first_frame_method: report.frameMethod,
      source_measurement_version:
        report.definition ?? (report.version === 2 ? 'drama_v2' : 'drama_v1'),
    };
    if (report.phase === 'start') {
      recordEngineeringEvent('drama.started', attributes);
    } else if (report.phase === 'slow') {
      recordEngineeringEvent('drama.stall', attributes);
    } else if (report.phase === 'final') {
      if (report.type === 'playback' && report.route !== '/' && report.dramaId) {
        // Same media evidence as startup, not merely an available signed URL.
        // The pathname guard prevents an old video's terminal result from
        // completing a newly navigated drama page of the same route template.
        const pathname = `/dramas/${encodeURIComponent(report.dramaId)}`;
        queueMicrotask(() => {
          try {
            if (
              report.outcome === 'playing' &&
              report.marks.first_frame !== undefined &&
              report.marks.playing !== undefined
            ) {
              markPageReady('/dramas/:id', 'content', pathname);
            } else if (['error', 'unplayable', 'autoplay_blocked'].includes(report.outcome)) {
              markPageFailed('/dramas/:id', pathname);
            }
          } catch {
            // Generic readiness is another optional projection, never playback control.
          }
        });
      }
      recordEngineeringEvent('drama.terminal', attributes);
      recordEngineeringMeasurement(
        report.type === 'list' ? 'drama.catalog' : 'drama.startup',
        report.elapsedMs,
        attributes
      );
      if (report.type === 'playback') {
        const firstFrame = report.marks.first_frame;
        if (firstFrame !== undefined) {
          recordEngineeringMeasurement('drama.first_frame', firstFrame, attributes);
        }
        for (const [stage, duration] of Object.entries(dramaTimingStages(report.marks))) {
          if (duration !== undefined) {
            recordEngineeringMeasurement('drama.stage', duration, { ...attributes, stage });
          }
        }
      }
    }
    mirrorDiagnostics(report, attributes);
    // Late network supplements must not duplicate an already final startup sample.
  } catch {
    // Keep the old logging/upload path working even if the mirror is unavailable.
  }
}

function startupBudget(report: DramaTimingReport): string {
  if (report.outcome === 'background') return 'background';
  if (report.outcome !== 'playing') return 'not_started';
  if (
    !Number.isFinite(report.elapsedMs) ||
    report.elapsedMs < 0 ||
    !Number.isFinite(report.marks.first_frame) ||
    !Number.isFinite(report.marks.playing)
  )
    return 'unmeasured';
  return report.elapsedMs <= 5_000 ? 'within_5s' : 'over_5s';
}

function reportTiming(report: DramaTimingReport): void {
  mirrorEngineeringTiming(report);
  const fields = dramaTimingLogFields(report);
  if (report.phase === 'slow') log.warn(fields);
  else log.info(fields);
  // The explicit cutover is build-time and defaults to legacy. Invalid/disabled
  // Faro configuration cannot silently remove the existing diagnostic path.
  const unified =
    process.env.NEXT_PUBLIC_DRAMA_TIMING_MODE === 'unified' && isEngineeringTelemetryEnabled();
  // Experiment results need every outcome, including fast successes in either arm.
  if (unified && !report.delivery && report.type !== 'seek' && !diagnosticSample(report)) return;
  const uploadReport: DramaTimingReport = unified ? { ...report, purpose: 'diagnostic' } : report;
  const upload = () => {
    void uploadDramaTiming(uploadReport).catch(() => {
      log.warn({
        event: 'drama.timing_upload_failed',
        observation_id: report.id,
        phase: report.phase,
      });
    });
  };
  // Let the click handler enqueue /play before the new background start report takes a slot.
  if (report.phase === 'start') queueMicrotask(upload);
  else upload();
}

export const dramaTiming = new DramaTimingTracker(
  () => performance.now(),
  createRequestId,
  reportTiming,
  browserContext()
);

/** 只输出粗平台/大版本，不发送完整 UA 或持久用户标识。 */
function browserContext(): NonNullable<DramaTimingReport['context']> {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Firefox\//.test(ua)
    ? 'firefox'
    : /(?:Chrome|Chromium|CriOS)\//.test(ua)
      ? 'chromium'
      : /AppleWebKit\//.test(ua)
        ? 'webkit'
        : 'other';
  const version = /(?:Firefox|Chrome|Chromium|CriOS|Version)\/(\d+)/.exec(ua)?.[1];
  const rawRelease =
    process.env.NEXT_PUBLIC_GRAFANA_RELEASE || process.env.NEXT_PUBLIC_DRAMA_RELEASE || 'unknown';
  return {
    release: /^[a-zA-Z0-9_.-]{1,128}$/.test(rawRelease) ? rawRelease : 'unknown',
    sessionId: createRequestId(),
    platform:
      /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)
        ? 'ios'
        : /Android/.test(ua)
          ? 'android'
          : ua
            ? 'desktop'
            : 'unknown',
    browser,
    browserMajor: version && Number(version) <= 1000 ? Number(version) : undefined,
  };
}
// 直接打开列表时包含文档加载与 hydration；站内入口由 click capture 起计。
if (typeof window !== 'undefined' && ['/', '/dramas'].includes(window.location.pathname)) {
  dramaTiming.beginList('document_navigation', 0, window.location.pathname as '/' | '/dramas');
}

/** 根页面观察器持有监听，路由尚未挂载时也能记录点击与等待。 */
export function installDramaTiming(): () => void {
  const click = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    const href = link?.getAttribute('href');
    if (
      (href === '/' || href === '/dramas') &&
      link?.getAttribute('target') !== '_blank' &&
      window.location.pathname !== href
    )
      dramaTiming.beginList('navigation_click', undefined, href);
  };
  const hidden = () => {
    if (document.hidden) dramaTiming.background();
  };
  const pagehide = () => dramaTiming.background('pagehide');
  document.addEventListener('click', click, true);
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', pagehide);
  hidden();
  return () => {
    document.removeEventListener('click', click, true);
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', pagehide);
  };
}

/** 只读取封面的本地性能条目；URL 永远不进入计时状态或日志。 */
export function coverLoadMs(image: HTMLImageElement): number | undefined {
  const entries = performance.getEntriesByName(image.currentSrc || image.src, 'resource');
  const entry = entries.at(-1);
  return entry ? Math.round(entry.duration * 10) / 10 : undefined;
}
