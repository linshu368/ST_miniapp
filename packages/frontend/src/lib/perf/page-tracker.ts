'use client';

import * as Sentry from '@sentry/nextjs';

import { createLogger } from '@/lib/logger';

import { completePendingAction } from './action-tracker';
import { getMetricDimensions, getNetworkTags } from './env-tags';
import { observeSettledRequests, snapshotInflight } from './inflight';
import { toRouteTemplate } from './route-template';

const log = createLogger('perf');

/** 初值（PRD 决策 2026-10-21）：页面 4 秒仍不可用即记为卡住。 */
export const PAGE_STALL_MS = 4_000;
/** 「刚进去最慢」的验证窗口：统计进页后这段时间内的请求。 */
export const ENTRY_WINDOW_MS = 10_000;

/**
 * 只对这几类页面定义「可用时刻」并开看门狗（design §3.2）；其余页面只记路由耗时。
 * key 为路由模板（不含动态段的具体值）。
 */
const WATCHED_PAGES = new Set(['/', '/chats', '/chat/:id', '/profile/recharge']);

interface ActivePage {
  route: string;
  startedAt: number;
  coldStart: boolean;
  ready: boolean;
  freshReported: boolean;
  /** 页面在后台的累计时长，不计入就绪耗时，避免用户切走造成误报。 */
  hiddenMs: number;
  hiddenSince: number | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  entryTimer: ReturnType<typeof setTimeout> | null;
  entryRequests: number;
  entrySlowRequests: number;
  unsubscribe: () => void;
}

let active: ActivePage | null = null;
let isFirstPage = true;
let visibilityBound = false;

function routeOf(pathname: string): string {
  // 与请求侧同一套归一规则，保证看板上 route 维度一致；聊天页的动态段统一成 :id。
  if (/^\/chat\/[^/]+\/?$/.test(pathname)) return '/chat/:id';
  return toRouteTemplate(pathname) || '/';
}

function elapsed(page: ActivePage, now: number): number {
  const hidden = page.hiddenMs + (page.hiddenSince !== null ? now - page.hiddenSince : 0);
  return Math.max(0, now - page.startedAt - hidden);
}

function safely(stage: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    log.warn(`page tracker ${stage} failed`, error);
    try {
      Sentry.metrics.count('perf.instrument_error', 1, {
        attributes: { side: 'frontend', stage },
      });
    } catch {
      // 放弃。
    }
  }
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    const page = active;
    if (!page) return;
    const now = performance.now();
    if (document.visibilityState === 'hidden') {
      page.hiddenSince = now;
      // 后台期间暂停看门狗；回到前台再按剩余时间重新计时。
      if (page.stallTimer) {
        clearTimeout(page.stallTimer);
        page.stallTimer = null;
      }
    } else if (page.hiddenSince !== null) {
      page.hiddenMs += now - page.hiddenSince;
      page.hiddenSince = null;
      if (!page.ready && WATCHED_PAGES.has(page.route)) armStallTimer(page);
    }
  });
}

function armStallTimer(page: ActivePage): void {
  const remaining = Math.max(0, PAGE_STALL_MS - elapsed(page, performance.now()));
  page.stallTimer = setTimeout(() => emitStall(page), remaining);
}

function emitStall(page: ActivePage): void {
  safely('page_stall', () => {
    if (page.ready || active !== page) return;
    const waitedMs = Math.round(elapsed(page, performance.now()));
    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setFingerprint(['page_stall', page.route]);
      scope.setTags({
        perf_event: 'page_stall',
        route: page.route,
        cold_start: String(page.coldStart),
        ...getNetworkTags(),
      });
      scope.setContext('page_stall', { waitedMs, inflight: snapshotInflight() });
      Sentry.captureMessage('page_stall');
    });
  });
}

function emitEntryWindow(page: ActivePage): void {
  safely('entry_window', () => {
    const attributes = { route: page.route, cold_start: String(page.coldStart) };
    Sentry.metrics.distribution('page.entry_window.requests', page.entryRequests, { attributes });
    Sentry.metrics.distribution('page.entry_window.slow_requests', page.entrySlowRequests, {
      attributes,
    });
  });
}

function endPage(page: ActivePage): void {
  if (page.stallTimer) clearTimeout(page.stallTimer);
  if (page.entryTimer) clearTimeout(page.entryTimer);
  page.unsubscribe();
}

/** 路由变化时调用（由 PagePerfTracker 驱动）。 */
export function beginPage(pathname: string): void {
  safely('begin_page', () => {
    bindVisibility();
    if (active) endPage(active);

    const route = routeOf(pathname);
    // 选角色的「反馈」就是进入会话页：路由已切换，用户不再对着大厅发呆。
    if (route === '/chat/:id') completePendingAction('select_character');
    const page: ActivePage = {
      route,
      startedAt: performance.now(),
      coldStart: isFirstPage,
      ready: false,
      freshReported: false,
      hiddenMs: 0,
      hiddenSince: typeof document !== 'undefined' && document.hidden ? performance.now() : null,
      stallTimer: null,
      entryTimer: null,
      entryRequests: 0,
      entrySlowRequests: 0,
      unsubscribe: () => undefined,
    };
    isFirstPage = false;
    active = page;

    page.unsubscribe = observeSettledRequests((settled) => {
      page.entryRequests += 1;
      if (settled.slow) page.entrySlowRequests += 1;
    });
    page.entryTimer = setTimeout(() => emitEntryWindow(page), ENTRY_WINDOW_MS);
    if (WATCHED_PAGES.has(route) && !page.hiddenSince) armStallTimer(page);
  });
}

/**
 * 页面宣告「用户已经能用了」。可重复调用，只有第一次生效。
 * `kind: 'fresh'` 表示拿到了最新网络数据（大厅有本地缓存秒开，必须另记，否则会掩盖后端慢）。
 */
export function markPageReady(route: string, kind: 'content' | 'fresh' = 'content'): void {
  safely('mark_ready', () => {
    const page = active;
    if (!page || page.route !== route) return;

    const durationMs = elapsed(page, performance.now());
    const attributes = {
      route,
      cold_start: String(page.coldStart),
      ...getMetricDimensions(),
    };

    if (kind === 'content' && !page.ready) {
      page.ready = true;
      if (page.stallTimer) {
        clearTimeout(page.stallTimer);
        page.stallTimer = null;
      }
      Sentry.metrics.distribution('page.ready.duration', durationMs, {
        unit: 'millisecond',
        attributes,
      });
    } else if (kind === 'fresh' && !page.freshReported) {
      page.freshReported = true;
      Sentry.metrics.distribution('page.data_fresh.duration', durationMs, {
        unit: 'millisecond',
        attributes,
      });
    }
  });
}

/** 仅测试使用：重置模块状态。 */
export function resetPageTrackerForTest(): void {
  if (active) endPage(active);
  active = null;
  isFirstPage = true;
}
