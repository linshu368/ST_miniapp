import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetNavigationQuietWindowForTests,
  afterNavigationQuietWindow,
  beginNavigationQuietWindow,
  isNavigationBackgroundAllowed,
  NAVIGATION_QUIET_FALLBACK_MS,
  settleNavigationQuietWindow,
} from './navigation-quiet-window';

describe('Android navigation quiet window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16)
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) =>
      setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 10 }), 1)
    );
    vi.stubGlobal('cancelIdleCallback', (handle: number) => clearTimeout(handle));
    __resetNavigationQuietWindowForTests();
  });

  afterEach(() => {
    __resetNavigationQuietWindowForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps iOS and non-primary routes on the existing schedule', () => {
    expect(beginNavigationQuietWindow('/profile', 'ios')).toBe(false);
    expect(beginNavigationQuietWindow('/profile/orders', 'android')).toBe(false);
    expect(isNavigationBackgroundAllowed()).toBe(true);
  });

  it('releases Android background work after destination paint and idle', async () => {
    expect(beginNavigationQuietWindow('/profile?from=nav', 'android_x')).toBe(true);
    expect(isNavigationBackgroundAllowed()).toBe(false);
    let released = false;
    void afterNavigationQuietWindow().then(() => {
      released = true;
    });

    settleNavigationQuietWindow('/profile');
    await vi.advanceTimersByTimeAsync(32);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    expect(isNavigationBackgroundAllowed()).toBe(true);
  });

  it('falls back after four seconds when the destination never settles', async () => {
    beginNavigationQuietWindow('/dramas', 'android');
    await vi.advanceTimersByTimeAsync(NAVIGATION_QUIET_FALLBACK_MS - 1);
    expect(isNavigationBackgroundAllowed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isNavigationBackgroundAllowed()).toBe(true);
  });

  it('does not let an old destination release a newer navigation', async () => {
    beginNavigationQuietWindow('/profile', 'android');
    settleNavigationQuietWindow('/profile');
    await vi.advanceTimersByTimeAsync(16);

    beginNavigationQuietWindow('/characters', 'android');
    await vi.advanceTimersByTimeAsync(100);
    expect(isNavigationBackgroundAllowed()).toBe(false);

    settleNavigationQuietWindow('/characters');
    await vi.advanceTimersByTimeAsync(33);
    expect(isNavigationBackgroundAllowed()).toBe(true);
  });
});
