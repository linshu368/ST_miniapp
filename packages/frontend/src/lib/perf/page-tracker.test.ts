import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { distribution, count, captureMessage, withScope } = vi.hoisted(() => ({
  distribution: vi.fn(),
  count: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setLevel: vi.fn(), setFingerprint: vi.fn(), setTags: vi.fn(), setContext: vi.fn() })
  ),
}));

vi.mock('@sentry/nextjs', () => ({
  metrics: { distribution, count },
  captureMessage,
  withScope,
}));
vi.mock('@telegram-apps/sdk-react', () => ({ retrieveLaunchParams: () => ({}) }));

import { notifySettled } from './inflight';
import {
  beginPage,
  ENTRY_WINDOW_MS,
  markPageReady,
  PAGE_STALL_MS,
  resetPageTrackerForTest,
  routeOf,
  WATCHED_PAGES,
} from './page-tracker';

// 前端测试跑在 node 环境（项目暂无 jsdom），这里只需要 visibility 相关的最小 document。
const fakeDocument = Object.assign(new EventTarget(), {
  visibilityState: 'visible' as 'visible' | 'hidden',
  hidden: false,
});
vi.stubGlobal('document', fakeDocument);

function setVisibility(state: 'visible' | 'hidden'): void {
  fakeDocument.visibilityState = state;
  fakeDocument.hidden = state === 'hidden';
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
}

describe('page tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    distribution.mockClear();
    captureMessage.mockClear();
    resetPageTrackerForTest();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records ready duration and stays silent when the page becomes ready in time', () => {
    beginPage('/');
    vi.advanceTimersByTime(1500);
    markPageReady('/');
    vi.advanceTimersByTime(PAGE_STALL_MS * 2);

    expect(distribution).toHaveBeenCalledWith(
      'page.ready.duration',
      expect.any(Number),
      expect.objectContaining({ attributes: expect.objectContaining({ route: '/' }) })
    );
    expect(captureMessage).not.toHaveBeenCalledWith('page_stall');
  });

  it('raises page_stall when a watched page is not ready within the threshold', () => {
    beginPage('/chats');
    vi.advanceTimersByTime(PAGE_STALL_MS + 100);
    expect(captureMessage).toHaveBeenCalledWith('page_stall');
  });

  it('does not watch routes that never report readiness', () => {
    // 未知/新增但还没接 usePageReady 的路由只记路由耗时，不应该凭空告警。
    beginPage('/some/unknown/route');
    vi.advanceTimersByTime(PAGE_STALL_MS * 3);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('pauses the watchdog while the page is in the background', () => {
    beginPage('/');
    vi.advanceTimersByTime(1000);
    setVisibility('hidden');
    vi.advanceTimersByTime(PAGE_STALL_MS * 5);
    expect(captureMessage).not.toHaveBeenCalled();

    setVisibility('visible');
    vi.advanceTimersByTime(PAGE_STALL_MS - 1000 + 100);
    expect(captureMessage).toHaveBeenCalledWith('page_stall');
  });

  it('ignores readiness reported for a route that is no longer active', () => {
    beginPage('/chats');
    markPageReady('/');
    expect(distribution).not.toHaveBeenCalled();
  });

  it('summarises requests made in the entry window by cold start', () => {
    beginPage('/');
    notifySettled({ route: '/api/characters', durationMs: 5000, slow: true, outcome: 'ok' });
    notifySettled({ route: '/api/vip/status', durationMs: 100, slow: false, outcome: 'ok' });
    vi.advanceTimersByTime(ENTRY_WINDOW_MS + 10);

    expect(distribution).toHaveBeenCalledWith(
      'page.entry_window.requests',
      2,
      expect.objectContaining({ attributes: { route: '/', cold_start: 'true' } })
    );
    expect(distribution).toHaveBeenCalledWith(
      'page.entry_window.slow_requests',
      1,
      expect.objectContaining({ attributes: { route: '/', cold_start: 'true' } })
    );
  });
});

describe('route templates', () => {
  it('normalises real paths to the templates pages report', () => {
    expect(routeOf('/')).toBe('/');
    expect(routeOf('/chat/a5ea7a8d-9a4a-462f-af64-d304173b24c5')).toBe('/chat/:id');
    expect(routeOf('/chat/some-character/voice/msg-123456789012345678')).toBe(
      '/chat/:id/voice/:id'
    );
    expect(routeOf('/profile/recharge/550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/profile/recharge/:id'
    );
    expect(routeOf('/profile/messages/4821')).toBe('/profile/messages/:id');
    expect(routeOf('/profile/orders/')).toBe('/profile/orders');
  });

  it('watches every page that reports readiness', async () => {
    // 看门狗只认 WATCHED_PAGES 里的模板：页面报了而这里没列，就会静默不告警。
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    const pages: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tsx')) pages.push(full);
      }
    };
    walk(join(process.cwd(), 'src/app'));
    walk(join(process.cwd(), 'src/components'));

    const reported = new Set<string>();
    for (const file of pages) {
      for (const match of readFileSync(file, 'utf8').matchAll(/usePageReady\(\s*'([^']+)'/g)) {
        reported.add(match[1]!);
      }
    }

    expect(reported.size).toBeGreaterThan(0);
    expect([...reported].filter((route) => !WATCHED_PAGES.has(route))).toEqual([]);
  });
});
