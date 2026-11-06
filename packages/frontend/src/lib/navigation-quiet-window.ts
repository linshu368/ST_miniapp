'use client';

import { useEffect, useState } from 'react';

import { getTelegramPlatform } from '@/lib/perf/env-tags';
import { mobilePlatformGroup } from '@/lib/mobile-performance';

export const NAVIGATION_QUIET_FALLBACK_MS = 4_000;
const NAVIGATION_IDLE_TIMEOUT_MS = 500;
const NAVIGATION_TIMER_RELEASE_MS = 50;

const PRIMARY_ROUTE_PATHS = new Set([
  '/watch',
  '/dramas',
  '/characters',
  '/chats',
  '/creation',
  '/profile',
]);

let quiet = false;
let targetPathname: string | null = null;
let generation = 0;
let settlingGeneration: number | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let firstFrame: number | undefined;
let secondFrame: number | undefined;
let idleHandle: number | undefined;

const listeners = new Set<() => void>();

function normalizedPathname(value: string): string {
  return (value.split(/[?#]/, 1)[0] || '/').replace(/(.)\/$/, '$1');
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function clearReleaseSchedule(): void {
  if (releaseTimer !== undefined) {
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
  }
  if (firstFrame !== undefined && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(firstFrame);
    firstFrame = undefined;
  }
  if (secondFrame !== undefined && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(secondFrame);
    secondFrame = undefined;
  }
  if (idleHandle !== undefined && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(idleHandle);
    idleHandle = undefined;
  }
  settlingGeneration = null;
}

function release(expectedGeneration: number): void {
  if (!quiet || generation !== expectedGeneration) return;
  clearReleaseSchedule();
  if (fallbackTimer !== undefined) {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }
  quiet = false;
  targetPathname = null;
  notify();
}

function releaseAfterPaint(expectedGeneration: number): void {
  if (!quiet || generation !== expectedGeneration || settlingGeneration === expectedGeneration)
    return;
  settlingGeneration = expectedGeneration;

  const releaseWhenIdle = () => {
    firstFrame = undefined;
    secondFrame = undefined;
    if (typeof requestIdleCallback === 'function') {
      idleHandle = requestIdleCallback(
        () => {
          idleHandle = undefined;
          release(expectedGeneration);
        },
        { timeout: NAVIGATION_IDLE_TIMEOUT_MS }
      );
      return;
    }
    releaseTimer = setTimeout(() => release(expectedGeneration), NAVIGATION_TIMER_RELEASE_MS);
  };

  if (typeof requestAnimationFrame !== 'function') {
    releaseTimer = setTimeout(() => release(expectedGeneration), NAVIGATION_TIMER_RELEASE_MS);
    return;
  }
  firstFrame = requestAnimationFrame(() => {
    firstFrame = undefined;
    if (!quiet || generation !== expectedGeneration) return;
    secondFrame = requestAnimationFrame(releaseWhenIdle);
  });
}

/**
 * Android touch intent has almost no lead time. Keep non-critical work quiet until the
 * destination has committed and painted; other platforms retain the existing schedule.
 */
export function beginNavigationQuietWindow(
  href: string,
  platform = getTelegramPlatform()
): boolean {
  const pathname = normalizedPathname(href);
  if (mobilePlatformGroup(platform) !== 'android' || !PRIMARY_ROUTE_PATHS.has(pathname)) {
    return false;
  }
  if (quiet && targetPathname === pathname) return true;

  clearReleaseSchedule();
  if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
  generation += 1;
  const currentGeneration = generation;
  targetPathname = pathname;
  const changed = !quiet;
  quiet = true;
  fallbackTimer = setTimeout(() => release(currentGeneration), NAVIGATION_QUIET_FALLBACK_MS);
  if (changed) notify();
  return true;
}

/** Content-ready/error has committed. Background work resumes after paint plus an idle chance. */
export function settleNavigationQuietWindow(pathname: string): void {
  if (!quiet || normalizedPathname(pathname) !== targetPathname) return;
  releaseAfterPaint(generation);
}

export function isNavigationBackgroundAllowed(): boolean {
  return !quiet;
}

export function afterNavigationQuietWindow(): Promise<void> {
  if (!quiet) return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (quiet) return;
      listeners.delete(onChange);
      resolve();
    };
    listeners.add(onChange);
  });
}

export function useNavigationBackgroundAllowed(): boolean {
  const [allowed, setAllowed] = useState(!quiet);
  useEffect(() => {
    const onChange = () => setAllowed(!quiet);
    listeners.add(onChange);
    onChange();
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return allowed;
}

/** Test-only reset. */
export function __resetNavigationQuietWindowForTests(): void {
  generation += 1;
  clearReleaseSchedule();
  if (fallbackTimer !== undefined) {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }
  quiet = false;
  targetPathname = null;
  listeners.clear();
}
