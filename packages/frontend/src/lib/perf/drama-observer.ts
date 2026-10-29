'use client';

import { dramaTimingLogFields } from '@miniapp/shared';
import { uploadDramaTiming } from '@/lib/api/telemetry';
import { createLogger } from '@/lib/logger';
import { createRequestId } from './request-timing';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';
import { recordEngineeringEvent, recordEngineeringMeasurement } from './grafana';
import { markPageFailed, markPageReady } from './page-tracker';

const log = createLogger('drama-timing');

const PLAYBACK_STAGES = [
  'navigation',
  'address_wait',
  'address_to_source',
  'source_to_metadata',
  'metadata_to_frame',
  'source_to_frame',
  'source_to_playing',
] as const;

/** Project the existing timing owner; never copy IDs, query details or media URLs. */
function mirrorEngineeringTiming(report: DramaTimingReport): void {
  try {
    const attributes = {
      route: report.type === 'list' ? '/dramas' : '/dramas/:id',
      report_kind: report.type,
      stage: report.type === 'list' ? 'catalog' : 'startup',
      outcome:
        report.type === 'list' &&
        report.outcome === 'left' &&
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
          ? 'background'
          : report.outcome,
      playback_mode: report.entry,
      cache: report.addressSource ?? 'unknown',
      first_frame_method: report.frameMethod,
      source_measurement_version: report.version === 2 ? 'drama_v2' : 'drama_v1',
    };
    if (report.phase === 'start') {
      recordEngineeringEvent('drama.started', attributes);
    } else if (report.phase === 'slow') {
      recordEngineeringEvent('drama.stall', attributes);
    } else if (report.phase === 'final') {
      if (report.type === 'playback' && report.dramaId) {
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
        for (const stage of PLAYBACK_STAGES) {
          const duration = report.stages[stage];
          if (duration !== undefined) {
            recordEngineeringMeasurement('drama.stage', duration, { ...attributes, stage });
          }
        }
      }
    }
    // Late network supplements must not duplicate an already final startup sample.
  } catch {
    // Keep the old logging/upload path working even if the mirror is unavailable.
  }
}

function reportTiming(report: DramaTimingReport): void {
  mirrorEngineeringTiming(report);
  const fields = dramaTimingLogFields(report);
  if (report.phase === 'slow') log.warn(fields);
  else log.info(fields);
  // 上报不参与播放状态机；失败保留本地诊断，不递归记录成新的播放样本。
  const upload = () => {
    void uploadDramaTiming(report).catch(() => {
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
  const rawRelease = process.env.NEXT_PUBLIC_DRAMA_RELEASE || 'unknown';
  return {
    release: /^[a-zA-Z0-9_.-]{1,128}$/.test(rawRelease) ? rawRelease : 'unknown',
    sessionId: createRequestId(),
    platform: /iPad|iPhone|iPod/.test(ua)
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
    const href = link?.getAttribute('href');
    if (
      (href === '/' || href === '/dramas') &&
      link?.getAttribute('target') !== '_blank' &&
      window.location.pathname !== href
    )
      dramaTiming.beginList('navigation_click');
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
