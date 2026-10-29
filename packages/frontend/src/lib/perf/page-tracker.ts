'use client';

import * as Sentry from '@sentry/nextjs';

import { createLogger } from '@/lib/logger';

import { completePendingAction } from './action-tracker';
import { getMetricDimensions, getNetworkTags } from './env-tags';
import {
  isEngineeringTelemetryEnabled,
  recordEngineeringEvent,
  recordEngineeringMeasurement,
} from './grafana';
import { observeSettledRequests, snapshotInflight } from './inflight';
import { ENGINEERING_PAGE_ROUTES, toRouteTemplate } from './route-template';

const log = createLogger('perf');

/** 初值（PRD 决策 2026-10-21）：页面 4 秒仍不可用即记为卡住。 */
export const PAGE_STALL_MS = 4_000;
/** 「刚进去最慢」的验证窗口：统计进页后这段时间内的请求。 */
export const ENTRY_WINDOW_MS = 10_000;

/**
 * 每个页面都定义了「可用时刻」并开看门狗（design §3.2）。
 * key 为路由模板（不含动态段的具体值），与页面里 usePageReady 传入的值一一对应：
 * 对不上则该页只记路由耗时、不会告警，所以新增页面必须同时改这两处。
 */
export const WATCHED_PAGES = ENGINEERING_PAGE_ROUTES;

interface ActivePage {
  pathname: string;
  cache: 'cache' | 'fetch' | 'unknown';
  route: string;
  startedAt: number;
  coldStart: boolean;
  ready: boolean;
  criticalVisualReported: boolean;
  failed: boolean;
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

interface EngineeringVisit {
  pathname: string;
  route: string;
  startedAt: number;
  navigationType: 'document' | 'spa' | 'mount';
  hiddenMs: number;
  hiddenSince: number | null;
  wasHidden: boolean;
  terminal: boolean;
  stalled: boolean;
  pendingReady: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
let visit: EngineeringVisit | null = null;
let pageHideBound = false;
let navigationBound = false;

function visitElapsed(current: EngineeringVisit): number {
  const now = performance.now();
  return Math.max(
    0,
    now -
      current.startedAt -
      current.hiddenMs -
      (current.hiddenSince === null ? 0 : now - current.hiddenSince)
  );
}

function visitAttributes(current: EngineeringVisit) {
  return {
    route: current.route,
    navigation_type: current.navigationType,
    visibility:
      current.hiddenSince !== null ? 'background' : current.wasHidden ? 'mixed' : 'foreground',
    source_measurement_version:
      current.navigationType === 'document'
        ? 'page_launch_v1'
        : current.navigationType === 'spa'
          ? 'page_navigation_v1'
          : 'page_mount_v1',
    ...getMetricDimensions(),
  };
}

function finishVisit(current: EngineeringVisit, outcome: string): void {
  if (current.terminal) return;
  current.terminal = true;
  if (current.timer) clearTimeout(current.timer);
  recordEngineeringEvent('page.terminal', { ...visitAttributes(current), stage: 'ready', outcome });
}

function armVisitStall(current: EngineeringVisit): void {
  if (current.terminal || current.stalled || current.hiddenSince !== null) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(
    () => {
      if (visit !== current || current.terminal || current.stalled) return;
      current.stalled = true;
      recordEngineeringEvent('page.stall', {
        ...visitAttributes(current),
        stage: 'ready',
        outcome: 'stalled',
      });
    },
    Math.max(0, PAGE_STALL_MS - visitElapsed(current))
  );
}

function startVisit(
  pathname: string,
  navigationType: EngineeringVisit['navigationType'],
  startedAt = performance.now()
): void {
  if (!isEngineeringTelemetryEnabled()) return;
  if (visit) finishVisit(visit, 'page_left');
  const route = routeOf(pathname);
  if (!WATCHED_PAGES.has(route)) {
    visit = null;
    return;
  }
  const hidden = typeof document !== 'undefined' && document.hidden;
  visit = {
    pathname,
    route,
    startedAt,
    navigationType,
    hiddenMs: 0,
    hiddenSince: hidden ? performance.now() : null,
    wasHidden: hidden,
    terminal: false,
    stalled: false,
    pendingReady: false,
    timer: null,
  };
  recordEngineeringEvent('page.started', {
    ...visitAttributes(visit),
    stage: 'ready',
    outcome: 'started',
  });
  armVisitStall(visit);
}

/** 在根 Providers 之前登记打开：包含 Telegram 启动等待，保留旧 Sentry mount 时钟不变。 */
export function initializePageExperience(): void {
  safely('initialize_page_experience', () => {
    if (typeof window === 'undefined' || !isEngineeringTelemetryEnabled()) return;
    bindVisibility();
    if (!visit && isFirstPage) startVisit(window.location.pathname, 'document', 0);
    if (!pageHideBound) {
      pageHideBound = true;
      window.addEventListener('pagehide', () => {
        if (visit) finishVisit(visit, 'page_left');
      });
    }
    if (!navigationBound) {
      navigationBound = true;
      // Next 14 未必调用 instrumentation-client 的导航 hook；Link 点击仍需保留真实起点。
      document.addEventListener(
        'click',
        (event) => {
          const mouse = event as MouseEvent;
          if (
            mouse.button !== 0 ||
            mouse.metaKey ||
            mouse.ctrlKey ||
            mouse.shiftKey ||
            mouse.altKey
          )
            return;
          const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
          if (
            !(link instanceof HTMLAnchorElement) ||
            link.download ||
            (link.target && link.target !== '_self')
          )
            return;
          markPageNavigationStart(link.href);
        },
        { capture: true }
      );
      window.addEventListener('popstate', () => {
        if (visit?.pathname !== window.location.pathname)
          startVisit(window.location.pathname, 'spa');
      });
    }
  });
}

/** Next 的 navigation 回调覆盖 Link、router.push/replace 和返回；不记录 href/query。 */
export function markPageNavigationStart(href: string): void {
  safely('navigation_start', () => {
    if (typeof window === 'undefined' || !isEngineeringTelemetryEnabled()) return;
    const target = new URL(href, window.location.href);
    if (target.origin !== window.location.origin || target.pathname === window.location.pathname)
      return;
    if (visit?.pathname === target.pathname && visit.navigationType === 'spa' && !visit.terminal)
      return;
    bindVisibility();
    startVisit(target.pathname, 'spa');
  });
}

function engineeringReady(page: ActivePage): void {
  const current = visit;
  if (!current || current.pathname !== page.pathname || current.terminal) return;
  if (current.hiddenSince !== null) {
    current.pendingReady = true;
    return;
  }
  const attributes = {
    ...visitAttributes(current),
    stage: 'ready',
    outcome: 'ready',
    cache: page.cache,
  };
  recordEngineeringMeasurement('page.ready', elapsed(page, performance.now()), {
    ...attributes,
    source_measurement_version: 'page_mount_v1',
  });
  if (current.navigationType === 'document')
    recordEngineeringMeasurement('page.launch', visitElapsed(current), attributes);
  if (current.navigationType === 'spa')
    recordEngineeringMeasurement('page.navigation', visitElapsed(current), attributes);
  finishVisit(current, 'ready');
}

/** 错误 UI 可交互不等于业务内容就绪；失败只进终态，不进入成功耗时分布。 */
export function markPageFailed(route: string, pathname?: string): void {
  safely('mark_failed', () => {
    if (visit?.route === route && (!pathname || visit.pathname === pathname))
      finishVisit(visit, 'error');
    // 即使 Grafana 关闭，明确的错误页也不应被旧 Sentry 看门狗继续误报为等待。
    if (active?.route === route && (!pathname || active.pathname === pathname)) {
      active.failed = true;
      if (active.stallTimer) {
        clearTimeout(active.stallTimer);
        active.stallTimer = null;
      }
    }
  });
}

export function routeOf(pathname: string): string {
  // 与请求侧同一套归一规则，保证看板上 route 维度一致。
  // characterId 不一定是 uuid/数字，通用归一规则认不出来，单独处理。
  if (/^\/chat\/[^/]+\/?$/.test(pathname)) return '/chat/:id';
  if (/^\/chat\/[^/]+\/voice\/[^/]+\/?$/.test(pathname)) return '/chat/:id/voice/:id';
  if (/^\/dramas\/[^/]+\/?$/.test(pathname)) return '/dramas/:id';
  return toRouteTemplate(pathname.replace(/(.)\/$/, '$1')) || '/';
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
    const current = visit;
    const now = performance.now();
    if (current) {
      if (document.visibilityState === 'hidden' && current.hiddenSince === null) {
        current.hiddenSince = now;
        current.wasHidden = true;
        if (current.timer) clearTimeout(current.timer);
      } else if (document.visibilityState !== 'hidden' && current.hiddenSince !== null) {
        current.hiddenMs += now - current.hiddenSince;
        current.hiddenSince = null;
        armVisitStall(current);
      }
    }
    const page = active;
    if (!page) return;
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
      if (!page.ready && !page.failed && WATCHED_PAGES.has(page.route)) armStallTimer(page);
    }
    if (current?.pendingReady && active?.ready) engineeringReady(active);
  });
}

function armStallTimer(page: ActivePage): void {
  const remaining = Math.max(0, PAGE_STALL_MS - elapsed(page, performance.now()));
  page.stallTimer = setTimeout(() => emitStall(page), remaining);
}

function emitStall(page: ActivePage): void {
  safely('page_stall', () => {
    if (page.ready || page.failed || active !== page) return;
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

    // 同模板不同 ID 是新的访问。已有 navigation/document 起点则沿用，不从 mount 偷偷重计。
    if (!visit || visit.pathname !== pathname || visit.terminal)
      startVisit(pathname, isFirstPage ? 'document' : 'mount', isFirstPage ? 0 : performance.now());

    const route = routeOf(pathname);
    // 选角色的「反馈」就是进入会话页：路由已切换，用户不再对着大厅发呆。
    if (route === '/chat/:id') completePendingAction('select_character');
    if (route === '/create/studio/:id') completePendingAction('create_conversation');
    const page: ActivePage = {
      pathname,
      cache: 'unknown',
      route,
      startedAt: performance.now(),
      coldStart: isFirstPage,
      ready: false,
      criticalVisualReported: false,
      failed: false,
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
export function markPageReady(
  route: string,
  kind: 'content' | 'fresh' = 'content',
  pathname?: string,
  cache: ActivePage['cache'] = 'unknown'
): void {
  safely('mark_ready', () => {
    const page = active;
    if (!page || page.route !== route || (pathname && page.pathname !== pathname)) return;

    const durationMs = elapsed(page, performance.now());
    const attributes = {
      route,
      cold_start: String(page.coldStart),
      ...getMetricDimensions(),
    };

    if (kind === 'content' && !page.ready) {
      page.cache = cache;
      page.ready = true;
      if (page.stallTimer) {
        clearTimeout(page.stallTimer);
        page.stallTimer = null;
      }
      Sentry.metrics.distribution('page.ready.duration', durationMs, {
        unit: 'millisecond',
        attributes,
      });
      engineeringReady(page);
    } else if (kind === 'fresh' && !page.freshReported) {
      page.freshReported = true;
      Sentry.metrics.distribution('page.data_fresh.duration', durationMs, {
        unit: 'millisecond',
        attributes,
      });
      recordEngineeringMeasurement('page.fresh', durationMs, {
        ...getMetricDimensions(),
        route,
        stage: 'fresh',
        outcome: 'fresh',
        cache: 'fetch',
        visibility:
          page.hiddenSince !== null ? 'background' : page.hiddenMs > 0 ? 'mixed' : 'foreground',
        source_measurement_version: 'page_mount_v1',
      });
    }
  });
}

export function markPageCriticalVisual(
  route: string,
  outcome: 'loaded' | 'error' | 'absent' | 'timeout',
  pathname?: string,
  cache: ActivePage['cache'] = 'unknown'
): void {
  safely('mark_critical_visual', () => {
    const page = active;
    const current = visit;
    if (
      !page ||
      page.criticalVisualReported ||
      page.route !== route ||
      (pathname && page.pathname !== pathname) ||
      !current ||
      current.pathname !== page.pathname
    )
      return;

    page.criticalVisualReported = true;
    const durationMs = visitElapsed(current);
    const attributes = {
      ...visitAttributes(current),
      stage: 'critical_visual',
      outcome,
      cache,
      source_measurement_version: 'critical_visual_v1',
    };
    recordEngineeringMeasurement('page.critical_visual', durationMs, attributes);
    recordEngineeringEvent('page.critical_visual_terminal', attributes);
    Sentry.metrics.distribution('page.critical_visual.duration', durationMs, {
      unit: 'millisecond',
      attributes: { route, outcome, cache, ...getMetricDimensions() },
    });
  });
}

/** 仅测试使用：重置模块状态。 */
export function resetPageTrackerForTest(): void {
  if (active) endPage(active);
  active = null;
  isFirstPage = true;
  if (visit?.timer) clearTimeout(visit.timer);
  visit = null;
}
