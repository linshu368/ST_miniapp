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
  void uploadDramaTiming(report).catch(() => {
    log.warn({
      event: 'drama.timing_upload_failed',
      observation_id: report.id,
      phase: report.phase,
    });
  });
}

export const dramaTiming = new DramaTimingTracker(
  () => performance.now(),
  createRequestId,
  reportTiming
);
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
