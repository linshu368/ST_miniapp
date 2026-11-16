import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetNavigationQuietWindowForTests,
  afterNavigationQuietWindow,
  bindNavigationQuietWindow,
  beginNavigationQuietWindow,
  isNavigationBackgroundAllowed,
  NAVIGATION_QUIET_FALLBACK_MS,
  settleNavigationQuietWindow,
} from './navigation-quiet-window';

vi.mock('./perf/env-tags', () => ({ getTelegramPlatform: () => 'android' }));

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

  it('keeps iOS and unregistered routes on the existing schedule', () => {
    expect(beginNavigationQuietWindow('/profile', 'ios')).toBe(false);
    expect(beginNavigationQuietWindow('/unregistered', 'android')).toBe(false);
    expect(isNavigationBackgroundAllowed()).toBe(true);
  });

  it.each([
    '/chat/11111111-1111-4111-8111-111111111111',
    '/profile/messages',
    '/profile/messages/11111111-1111-4111-8111-111111111111',
    '/profile/support',
    '/create',
    '/creation/data',
    '/wishes',
    '/creation/characters/11111111-1111-4111-8111-111111111111/edit',
  ])('protects the Android body request while entering %s', async (pathname) => {
    expect(beginNavigationQuietWindow(pathname, 'android')).toBe(true);
    expect(isNavigationBackgroundAllowed()).toBe(false);
    settleNavigationQuietWindow(pathname);
    await vi.advanceTimersByTimeAsync(33);
    expect(isNavigationBackgroundAllowed()).toBe(true);
  });

  it('captures only in-app navigation and removes its listeners on cleanup', async () => {
    const location = new URL('https://example.test/profile');
    const documentAdd = vi.fn();
    const windowAdd = vi.fn();
    const documentRemove = vi.fn();
    const windowRemove = vi.fn();
    vi.stubGlobal('window', {
      location,
      addEventListener: windowAdd,
      removeEventListener: windowRemove,
    });
    vi.stubGlobal('document', {
      addEventListener: documentAdd,
      removeEventListener: documentRemove,
    });
    class ElementFixture {
      closest() {
        return this;
      }
    }
    class LinkFixture extends ElementFixture {
      href = 'https://example.test/profile/messages';
      target = '';
      download: string | null = null;
      hasAttribute(name: string) {
        return name === 'download' && this.download !== null;
      }
    }
    vi.stubGlobal('Element', ElementFixture);
    vi.stubGlobal('HTMLAnchorElement', LinkFixture);
    const cleanup = bindNavigationQuietWindow();
    const onClick = documentAdd.mock.calls[0]![1] as (event: MouseEvent) => void;
    const click = (link: LinkFixture, extra: Partial<MouseEvent> = {}) =>
      onClick({
        target: link,
        button: 0,
        ...extra,
      } as unknown as MouseEvent);
    const link = new LinkFixture();
    click(link, { ctrlKey: true });
    click(link, { defaultPrevented: true });
    link.target = '_blank';
    click(link);
    link.target = '';
    link.download = 'file';
    click(link);
    link.download = '';
    click(link);
    link.download = null;
    link.href = 'https://external.test/profile/messages';
    click(link);
    link.href = 'https://example.test/profile#section';
    click(link);
    expect(isNavigationBackgroundAllowed()).toBe(true);
    link.href = 'https://example.test/profile/messages';
    click(link);
    expect(isNavigationBackgroundAllowed()).toBe(false);
    settleNavigationQuietWindow('/profile/messages');
    await vi.advanceTimersByTimeAsync(33);
    location.pathname = '/profile/support';
    const onBack = windowAdd.mock.calls[0]![1] as () => void;
    onBack();
    expect(isNavigationBackgroundAllowed()).toBe(false);
    cleanup();
    expect(documentRemove).toHaveBeenCalledWith('click', onClick, { capture: true });
    expect(windowRemove).toHaveBeenCalledWith('popstate', onBack);
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
