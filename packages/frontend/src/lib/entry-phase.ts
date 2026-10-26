'use client';

import { useEffect, useState } from 'react';

/** 关键路径一直不结算时，仍放行 enrich，避免角标等永久饿死。 */
const CRITICAL_FALLBACK_MS = 8_000;
/** enrich 放行后再等一会开 background，避免与收藏/会话史齐射。 */
const BACKGROUND_AFTER_ENRICH_MS = 1_500;

let criticalSettled = false;
let enrichReady = false;
let backgroundReady = false;
let criticalFallbackTimer: ReturnType<typeof setTimeout> | undefined;
let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
let watching = false;

const enrichListeners = new Set<() => void>();
const backgroundListeners = new Set<() => void>();

function notify(listeners: Set<() => void>): void {
  for (const listener of [...listeners]) listener();
}

function scheduleBackground(): void {
  if (backgroundReady || backgroundTimer !== undefined) return;
  // 用全局 setTimeout，便于 vitest fake timers，也避免 SSR 同步放行。
  backgroundTimer = setTimeout(() => {
    backgroundTimer = undefined;
    if (backgroundReady) return;
    backgroundReady = true;
    notify(backgroundListeners);
  }, BACKGROUND_AFTER_ENRICH_MS);
}

/**
 * 启动关键路径超时兜底。Providers / 各页 hook 挂载时调用即可；
 * 多次调用只生效一次。
 */
export function ensureEntryPhaseWatching(): void {
  if (watching || criticalSettled) return;
  watching = true;
  criticalFallbackTimer = setTimeout(() => {
    criticalFallbackTimer = undefined;
    markCriticalSettled();
  }, CRITICAL_FALLBACK_MS);
}

/**
 * 当前路由的 P0（大厅列表 / 会话详情 / 广场 feed 等）已成功、失败或有可展示缓存时调用。
 * 放行 enrich；再经短延迟放行 background。
 */
export function markCriticalSettled(): void {
  if (criticalSettled) return;
  criticalSettled = true;
  enrichReady = true;
  if (criticalFallbackTimer !== undefined) {
    clearTimeout(criticalFallbackTimer);
    criticalFallbackTimer = undefined;
  }
  notify(enrichListeners);
  scheduleBackground();
}

export function afterEntryEnrich(): Promise<void> {
  if (enrichReady) return Promise.resolve();
  ensureEntryPhaseWatching();
  return new Promise((resolve) => {
    const onReady = () => {
      enrichListeners.delete(onReady);
      resolve();
    };
    enrichListeners.add(onReady);
  });
}

export function afterEntryBackground(): Promise<void> {
  if (backgroundReady) return Promise.resolve();
  ensureEntryPhaseWatching();
  return new Promise((resolve) => {
    const onReady = () => {
      backgroundListeners.delete(onReady);
      resolve();
    };
    backgroundListeners.add(onReady);
  });
}

/** React Query `enabled`：收藏、会话史、角标、模型目录等。 */
export function useEntryEnrichReady(): boolean {
  const [ready, setReady] = useState(enrichReady);
  useEffect(() => {
    ensureEntryPhaseWatching();
    if (enrichReady) {
      setReady(true);
      return;
    }
    const onReady = () => setReady(true);
    enrichListeners.add(onReady);
    return () => {
      enrichListeners.delete(onReady);
    };
  }, []);
  return ready;
}

/** React Query `enabled`：未读红点、settings、广场预取、增长/邀请等。 */
export function useEntryBackgroundReady(): boolean {
  const [ready, setReady] = useState(backgroundReady);
  useEffect(() => {
    ensureEntryPhaseWatching();
    if (backgroundReady) {
      setReady(true);
      return;
    }
    const onReady = () => setReady(true);
    backgroundListeners.add(onReady);
    return () => {
      backgroundListeners.delete(onReady);
    };
  }, []);
  return ready;
}

/** 仅测试。 */
export function __resetEntryPhaseForTests(): void {
  criticalSettled = false;
  enrichReady = false;
  backgroundReady = false;
  watching = false;
  if (criticalFallbackTimer !== undefined) {
    clearTimeout(criticalFallbackTimer);
    criticalFallbackTimer = undefined;
  }
  if (backgroundTimer !== undefined) {
    clearTimeout(backgroundTimer);
    backgroundTimer = undefined;
  }
  enrichListeners.clear();
  backgroundListeners.clear();
}
