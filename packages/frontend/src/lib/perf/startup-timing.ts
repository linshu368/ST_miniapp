'use client';

import * as Sentry from '@sentry/nextjs';

import { notifyTelegramReady } from '@/lib/telegram/init';
import { getMetricDimensions } from './env-tags';
import { routeOf, WATCHED_PAGES } from './page-tracker';
import { collectStartupDetails, resetStartupPhasesForTest } from './startup-phases';

let completed = false;
let outcomeRecorded = false;

/** 独立于 SPA 页面计时；performance.now() 的零点是本次文档导航，包含下载与 hydration。 */
export function observeStartupShell(pathname: string): () => void {
  if (typeof window === 'undefined' || completed) return () => {};
  const committedAt = performance.now();

  // 未识别入口统一归类，禁止把短 ID、query 或 Telegram 启动参数变成指标维度。
  const template = pathname.startsWith('/dramas/') ? '/dramas/:id' : routeOf(pathname);
  const route =
    WATCHED_PAGES.has(template) || template === '/dramas' || template === '/dramas/:id'
      ? template
      : '/other';
  const attributes = { route, ...getMetricDimensions(), measurement: 'post_render_frame' };
  let firstFrame = 0;
  let secondFrame = 0;

  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      // 指标上报异常不能影响框架展示或 Telegram ready 通知。
    }
  };
  const outcome = (value: 'shell_ready' | 'background' | 'left' | 'missing_shell') => {
    if (outcomeRecorded) return;
    outcomeRecorded = true;
    safely(() =>
      Sentry.metrics.count('startup.outcome', 1, {
        attributes: { ...attributes, outcome: value },
      })
    );
  };
  const onHidden = () => {
    if (document.hidden) outcome('background');
  };
  const cleanup = () => {
    window.cancelAnimationFrame(firstFrame);
    window.cancelAnimationFrame(secondFrame);
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onPageHide);
  };
  const onPageHide = () => {
    outcome('left');
    completed = true;
    cleanup();
  };

  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  onHidden();
  // 两个 RAF 之间给浏览器一次绘制机会；这是可展示时间的保守近似，不冒充原生遮罩消失时刻。
  firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(() => {
      const shell = document.querySelector('[data-startup-shell]');
      if (!shell || shell.getBoundingClientRect().height <= 0) {
        outcome('missing_shell');
        completed = true;
        cleanup();
        return;
      }
      onHidden();
      const shellMs = performance.now();
      // readiness 与采集资格分离：后台样本不进 P95，恢复后仍必须撤下 Telegram 启动占位。
      const status = notifyTelegramReady();
      const readyMs = performance.now();
      if (!outcomeRecorded) {
        outcome('shell_ready');
        safely(() =>
          Sentry.metrics.distribution('startup.shell_ready.duration', shellMs, {
            unit: 'millisecond',
            attributes: { ...attributes, telegram_ready: status },
          })
        );
        if (status === 'sent') {
          safely(() =>
            Sentry.metrics.distribution('startup.telegram_ready.duration', readyMs, {
              unit: 'millisecond',
              attributes,
            })
          );
        }
        // 不把资源枚举、分段指标或慢样本组装放在 ready 之前，也不等待上报成功。
        safely(() =>
          setTimeout(() => {
            safely(() => {
              const { stages, details } = collectStartupDetails(committedAt, shellMs, readyMs);
              const startupBucket = shellMs >= 5000 ? 'slow' : 'normal';
              const tags = {
                ...attributes,
                telegram_ready: status,
                startup_bucket: startupBucket,
                definition: 'startup_phases_v1',
              };
              for (const [stage, duration] of Object.entries(stages)) {
                safely(() =>
                  Sentry.metrics.distribution('startup.stage.duration', duration, {
                    unit: 'millisecond',
                    attributes: { ...tags, stage },
                  })
                );
              }
              if (startupBucket === 'slow') {
                // 单条事件携带同一次启动的完整数值，不能拿各阶段 P95 相加推断慢因。
                safely(() =>
                  Sentry.captureEvent({
                    message: 'miniapp_startup_slow',
                    level: 'info',
                    fingerprint: ['miniapp_startup_slow'],
                    tags,
                    contexts: { startup: details },
                  })
                );
              }
            });
          }, 0)
        );
      }
      completed = true;
      cleanup();
    });
  });
  // React StrictMode 的 effect 探测只清理监听，不把它当成真实离开或完成。
  return cleanup;
}

/** 仅测试。 */
export function resetStartupTimingForTest(): void {
  completed = false;
  outcomeRecorded = false;
  resetStartupPhasesForTest();
}
