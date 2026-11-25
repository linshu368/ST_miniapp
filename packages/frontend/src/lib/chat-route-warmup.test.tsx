// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prefetch: vi.fn(),
  quiet: false,
  background: () => Promise.resolve(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch: state.prefetch }) }));
vi.mock('./entry-phase', () => ({ afterEntryBackground: () => state.background() }));
vi.mock('./navigation-quiet-window', () => ({
  isNavigationBackgroundAllowed: () => !state.quiet,
  afterNavigationQuietWindow: () => Promise.resolve(),
}));
import {
  warmChatRoute,
  resetChatRouteWarmupForTest,
  useChatRouteWarmup,
} from './chat-route-warmup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let visible = 'visible';
let connection = { saveData: false, effectiveType: '4g' };
function Probe({ href, ready = true }: { href: string | null; ready?: boolean }) {
  useChatRouteWarmup(href, ready);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  visible = 'visible';
  connection = { saveData: false, effectiveType: '4g' };
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visible as DocumentVisibilityState
  );
  Object.defineProperty(navigator, 'connection', { configurable: true, get: () => connection });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  state.prefetch.mockReset();
  state.quiet = false;
  state.background = () => Promise.resolve();
  resetChatRouteWarmupForTest();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded route-only warming', () => {
  it('shares one warmup across repeated pointer/focus intent without a private GET', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const href = '/chat/fixture-character?session=fixture-session&from=conversations';
    expect(warmChatRoute(href, state.prefetch)).toBe(true);
    expect(warmChatRoute(href, state.prefetch)).toBe(false);
    expect(state.prefetch).toHaveBeenCalledExactlyOnceWith(href);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caps a pointer sweep and allows another window without retaining an unbounded cache', () => {
    for (let i = 0; i < 20; i++) warmChatRoute('/chat/fixture-' + i, state.prefetch);
    expect(state.prefetch).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(30_001);
    expect(warmChatRoute('/chat/fixture-0', state.prefetch)).toBe(true);
  });
  it('keeps hidden, constrained, quiet and external targets on ordinary navigation', () => {
    visible = 'hidden';
    expect(warmChatRoute('/chat/a', state.prefetch)).toBe(false);
    visible = 'visible';
    connection.saveData = true;
    expect(warmChatRoute('/chat/a', state.prefetch)).toBe(false);
    connection.saveData = false;
    state.quiet = true;
    expect(warmChatRoute('/chat/a', state.prefetch)).toBe(false);
    state.quiet = false;
    for (const href of [
      'https://outside.test/chat/a',
      '/profile',
      '/chat/a/voice/b',
      'http://[bad',
    ])
      expect(warmChatRoute(href, state.prefetch)).toBe(false);
    expect(state.prefetch).not.toHaveBeenCalled();
  });
  it('does not let a failed prefetch prevent the real navigation or poison the cache', async () => {
    state.prefetch.mockRejectedValueOnce(new Error('synthetic warmup failure'));
    warmChatRoute('/chat/a', state.prefetch);
    await Promise.resolve();
    await Promise.resolve();
    expect(warmChatRoute('/chat/a', state.prefetch)).toBe(true);
  });
  it('warms only the latest candidate after source readiness', async () => {
    act(() => root.render(createElement(Probe, { href: '/chat/a', ready: false })));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(state.prefetch).not.toHaveBeenCalled();
    act(() => root.render(createElement(Probe, { href: '/chat/a' })));
    act(() => root.render(createElement(Probe, { href: '/chat/b' })));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(state.prefetch).toHaveBeenCalledExactlyOnceWith('/chat/b');
  });
  it('discards deferred work after leaving or hiding the source', async () => {
    let release!: () => void;
    state.background = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    act(() => root.render(createElement(Probe, { href: '/chat/a' })));
    visible = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    release();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(state.prefetch).not.toHaveBeenCalled();
  });
});
