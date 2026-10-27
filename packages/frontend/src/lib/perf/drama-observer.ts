'use client';

import { dramaTimingLogFields } from '@miniapp/shared';
import { uploadDramaTiming } from '@/lib/api/telemetry';
import { createLogger } from '@/lib/logger';
import { createRequestId } from './request-timing';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';

const log = createLogger('drama-timing');

function reportTiming(report: DramaTimingReport): void {
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
