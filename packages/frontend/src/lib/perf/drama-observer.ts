'use client';

import * as Sentry from '@sentry/nextjs';
import { sendSentryLog } from '@/lib/sentry/client';
import { createRequestId } from './request-timing';
import { getMetricDimensions } from './env-tags';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';

function reportTiming(report: DramaTimingReport): void {
  const attributes = {
    type: report.type,
    entry: report.entry ?? 'list',
    outcome: report.outcome,
    ...getMetricDimensions(),
  };
  const summary = {
    observation_id: report.id,
    drama_id: report.dramaId,
    video_id: report.videoId,
    phase: report.phase,
    ...attributes,
    elapsed_ms: report.elapsedMs,
    address_source: report.addressSource,
    frame_method: report.frameMethod,
    ...Object.fromEntries(
      Object.entries(report.stages).map(([key, value]) => [`${key}_ms`, value])
    ),
    list_id: report.list?.id,
    list_ready_ms: report.list?.readyMs,
    browse_ms: report.list?.browseMs,
    since_list_entry_ms: report.list?.sinceEntryMs,
    list_start_kind: report.list?.startKind,
    cover_outcome: report.cover?.outcome,
    cover_load_ms: report.cover?.loadMs,
    request_ids: report.queries
      .flatMap((query) => query.attempts.map((attempt) => attempt.requestId))
      .join(','),
    query_runs: report.queries.length,
    query_details_truncated: report.queryDetailsTruncated,
  };
  sendSentryLog(report.phase === 'slow' ? 'warn' : 'info', 'drama.timing', summary);
  if (report.phase === 'final') {
    report.queries.forEach((query, queryIndex) => {
      const { attempts, ...querySummary } = query;
      sendSentryLog('info', 'drama.query_timing', {
        observation_id: report.id,
        query_index: queryIndex,
        ...querySummary,
      });
      attempts.forEach((attempt, attemptIndex) =>
        sendSentryLog('info', 'drama.request_timing', {
          observation_id: report.id,
          query_index: queryIndex,
          attempt_index: attemptIndex,
          ...attempt,
        })
      );
    });
    Sentry.metrics.distribution('drama.startup.duration', report.elapsedMs, {
      unit: 'millisecond',
      attributes,
    });
    for (const [stage, ms] of Object.entries(report.stages)) {
      Sentry.metrics.distribution('drama.stage.duration', ms, {
        unit: 'millisecond',
        attributes: { ...attributes, stage },
      });
    }
  }
  if (
    report.phase !== 'slow' &&
    report.elapsedMs < 10_000 &&
    ['playing', 'ready', 'switched', 'left', 'background'].includes(report.outcome)
  )
    return;
  Sentry.withScope((scope) => {
    scope.setLevel('warning');
    scope.setFingerprint(['drama_timing', report.type, report.phase, report.outcome]);
    scope.setTags({ perf_event: 'drama_timing', ...attributes });
    // 独立的扁平 context，避免 SDK 默认 normalizeDepth 把请求尝试截断成 [Object]。
    scope.setContext('drama_timing', summary);
    scope.setContext('drama_marks', report.marks);
    report.queries.forEach((query, index) => {
      const { attempts, ...querySummary } = query;
      scope.setContext(`drama_query_${index}`, querySummary);
      attempts.forEach((attempt, attemptIndex) =>
        scope.setContext(`drama_request_${index}_${attemptIndex}`, { ...attempt })
      );
    });
    Sentry.captureMessage('drama_timing');
  });
}

export const dramaTiming = new DramaTimingTracker(
  () => performance.now(),
  createRequestId,
  reportTiming
);
// 直接打开列表时包含文档加载与 hydration；站内入口由 click capture 起计。
if (typeof window !== 'undefined' && window.location.pathname === '/dramas') {
  dramaTiming.beginList('document_navigation', 0);
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
    if (
      link?.getAttribute('href') === '/dramas' &&
      link.getAttribute('target') !== '_blank' &&
      window.location.pathname !== '/dramas'
    )
      dramaTiming.beginList('navigation_click');
  };
  const hidden = () => {
    if (document.hidden) dramaTiming.background();
  };
  const pagehide = () => dramaTiming.background();
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
