import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  distribution,
  count,
  captureMessage,
  withScope,
  telegramReady,
  telegramReadyAvailable,
  isTelegram,
} = vi.hoisted(() => ({
  telegramReady: vi.fn(),
  telegramReadyAvailable: vi.fn(() => true),
  isTelegram: vi.fn(() => true),
  distribution: vi.fn(),
  count: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setLevel: vi.fn(), setFingerprint: vi.fn(), setTags: vi.fn(), setContext: vi.fn() })
  ),
}));
const engineering = vi.hoisted(() => ({ measurement: vi.fn(), event: vi.fn(), enabled: true }));
vi.mock('./grafana', () => ({
  isEngineeringTelemetryEnabled: () => engineering.enabled,
  recordEngineeringMeasurement: engineering.measurement,
  recordEngineeringEvent: engineering.event,
}));

vi.mock('@sentry/nextjs', () => ({
  metrics: { distribution, count },
  captureMessage,
  withScope,
}));
vi.mock('@telegram-apps/sdk-react', () => ({
  retrieveLaunchParams: () => ({}),
  isTMA: isTelegram,
  miniApp: { ready: Object.assign(telegramReady, { isAvailable: telegramReadyAvailable }) },
}));

import { notifySettled } from './inflight';
import { observeStartupShell, resetStartupTimingForTest } from './startup-timing';
import {
  beginPage,
  ENTRY_WINDOW_MS,
  markPageCriticalVisual,
  markPageReady,
  markPageFailed,
  markPageNavigationStart,
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
    engineering.measurement.mockClear();
    engineering.event.mockClear();
    engineering.enabled = true;
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

  it('measures each dynamic ID visit and rejects late readiness from the previous ID', () => {
    beginPage('/dramas/first');
    markPageReady('/dramas/:id', 'content', '/dramas/first');
    beginPage('/dramas/second');
    markPageReady('/dramas/:id', 'content', '/dramas/first');
    expect(
      engineering.measurement.mock.calls.filter(([name]) => name === 'page.ready')
    ).toHaveLength(1);
    markPageReady('/dramas/:id', 'content', '/dramas/second');
    expect(
      engineering.measurement.mock.calls.filter(([name]) => name === 'page.ready')
    ).toHaveLength(2);
    expect(engineering.event.mock.calls.filter(([name]) => name === 'page.started')).toHaveLength(
      2
    );
  });

  it('keeps an explicit error out of successful engineering durations', () => {
    beginPage('/profile/messages/123');
    markPageFailed('/profile/messages/:id', '/profile/messages/123');
    markPageReady('/profile/messages/:id');
    expect(engineering.measurement).not.toHaveBeenCalled();
    expect(engineering.event).toHaveBeenCalledWith(
      'page.terminal',
      expect.objectContaining({ outcome: 'error' })
    );
  });

  it('stops the old watchdog for known errors even when the new exporter is disabled', () => {
    engineering.enabled = false;
    beginPage('/characters');
    markPageFailed('/characters');
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(PAGE_STALL_MS * 2);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(engineering.event).not.toHaveBeenCalled();
  });

  it('separates cached content readiness from fresh network data', () => {
    beginPage('/characters');
    markPageReady('/characters', 'content', undefined, 'cache');
    expect(engineering.measurement).toHaveBeenCalledWith(
      'page.ready',
      expect.any(Number),
      expect.objectContaining({ cache: 'cache' })
    );
    expect(
      engineering.measurement.mock.calls.filter(([name]) => name === 'page.fresh')
    ).toHaveLength(0);
    vi.advanceTimersByTime(700);
    markPageReady('/characters', 'fresh');
    expect(engineering.measurement).toHaveBeenCalledWith(
      'page.fresh',
      700,
      expect.objectContaining({ cache: 'fetch' })
    );
  });

  it('records critical visual once with navigation duration and terminal outcome', () => {
    beginPage('/characters');
    vi.advanceTimersByTime(850);
    markPageCriticalVisual('/characters', 'loaded', undefined, 'cache');
    markPageCriticalVisual('/characters', 'error', undefined, 'cache');

    expect(engineering.measurement).toHaveBeenCalledWith(
      'page.critical_visual',
      850,
      expect.objectContaining({
        route: '/characters',
        stage: 'critical_visual',
        outcome: 'loaded',
        cache: 'cache',
      })
    );
    expect(
      engineering.measurement.mock.calls.filter(([name]) => name === 'page.critical_visual')
    ).toHaveLength(1);
    expect(engineering.event).toHaveBeenCalledWith(
      'page.critical_visual_terminal',
      expect.objectContaining({ outcome: 'loaded' })
    );
  });

  it('does not count background-ready as visible success until foreground resumes', () => {
    beginPage('/characters');
    setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    markPageReady('/characters');
    expect(engineering.measurement).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(engineering.measurement).toHaveBeenCalledWith(
      'page.ready',
      expect.any(Number),
      expect.objectContaining({ visibility: 'mixed' })
    );
    expect(engineering.event.mock.calls.filter(([name]) => name === 'page.terminal')).toHaveLength(
      1
    );
  });

  it('records a single latched stall and an explicit leave terminal', () => {
    beginPage('/characters');
    vi.advanceTimersByTime(PAGE_STALL_MS + 100);
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(PAGE_STALL_MS + 100);
    expect(engineering.event.mock.calls.filter(([name]) => name === 'page.stall')).toHaveLength(1);
    beginPage('/chats');
    expect(engineering.event).toHaveBeenCalledWith(
      'page.terminal',
      expect.objectContaining({ route: '/characters', outcome: 'page_left' })
    );
  });

  it('keeps navigation-start and old mount duration as separate clocks', () => {
    vi.stubGlobal('window', {
      location: { href: 'https://app.test/', origin: 'https://app.test', pathname: '/' },
    });
    beginPage('/');
    markPageReady('/');
    markPageNavigationStart('/characters?private=1');
    vi.advanceTimersByTime(1200);
    beginPage('/characters');
    vi.advanceTimersByTime(300);
    markPageReady('/characters');
    expect(engineering.measurement).toHaveBeenCalledWith(
      'page.navigation',
      1500,
      expect.objectContaining({ navigation_type: 'spa' })
    );
    expect(engineering.measurement).toHaveBeenCalledWith(
      'page.ready',
      300,
      expect.objectContaining({ source_measurement_version: 'page_mount_v1' })
    );
    expect(JSON.stringify(engineering.event.mock.calls)).not.toContain('private');
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

describe('document startup timing', () => {
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  let startupDocument: EventTarget & { hidden: boolean; querySelector: ReturnType<typeof vi.fn> };
  let startupWindow: EventTarget;
  let cleanup: (() => void) | undefined;

  const paint = () => {
    vi.advanceTimersByTime(16);
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.clearAllMocks();
    telegramReady.mockReset();
    distribution.mockReset();
    telegramReadyAvailable.mockReturnValue(true);
    isTelegram.mockReturnValue(true);
    resetStartupTimingForTest();
    frames = new Map();
    frameId = 0;
    startupDocument = Object.assign(new EventTarget(), {
      hidden: false,
      querySelector: vi.fn(() => ({ getBoundingClientRect: () => ({ height: 800 }) })),
    });
    startupWindow = Object.assign(new EventTarget(), {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    });
    vi.stubGlobal('document', startupDocument);
    vi.stubGlobal('window', startupWindow);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.stubGlobal('document', fakeDocument);
  });

  it('includes document loading before hydration and notifies Telegram after a paint opportunity', () => {
    vi.advanceTimersByTime(2500);
    cleanup = observeStartupShell('/dramas');
    paint();
    expect(telegramReady).not.toHaveBeenCalled();
    paint();
    expect(telegramReady).toHaveBeenCalledOnce();
    expect(distribution).toHaveBeenCalledWith(
      'startup.shell_ready.duration',
      2532,
      expect.objectContaining({ attributes: expect.objectContaining({ route: '/dramas' }) })
    );
    expect(distribution).toHaveBeenCalledWith(
      'startup.telegram_ready.duration',
      2532,
      expect.objectContaining({ unit: 'millisecond' })
    );
    observeStartupShell('/profile');
    paint();
    paint();
    expect(telegramReady).toHaveBeenCalledOnce();
    expect(distribution).toHaveBeenCalledTimes(2);
  });

  it('survives StrictMode cleanup without reporting a false departure or duplicate sample', () => {
    observeStartupShell('/')();
    paint();
    expect(telegramReady).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    cleanup = observeStartupShell('/');
    paint();
    paint();
    expect(telegramReady).toHaveBeenCalledOnce();
    expect(distribution).toHaveBeenCalledTimes(2);
  });

  it('excludes background time from startup P95 but still releases the native placeholder on return', () => {
    cleanup = observeStartupShell('/');
    startupDocument.hidden = true;
    startupDocument.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(60_000);
    startupDocument.hidden = false;
    paint();
    paint();
    expect(telegramReady).toHaveBeenCalledOnce();
    expect(distribution).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith(
      'startup.outcome',
      1,
      expect.objectContaining({ attributes: expect.objectContaining({ outcome: 'background' }) })
    );
  });

  it('records departure without treating an incomplete startup as fast or successful', () => {
    cleanup = observeStartupShell('/dramas');
    startupWindow.dispatchEvent(new Event('pagehide'));
    paint();
    paint();
    expect(telegramReady).not.toHaveBeenCalled();
    expect(distribution).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith(
      'startup.outcome',
      1,
      expect.objectContaining({ attributes: expect.objectContaining({ outcome: 'left' }) })
    );
  });

  it('does not invent a successful native-ready duration in an ordinary browser', () => {
    isTelegram.mockReturnValue(false);
    cleanup = observeStartupShell('/');
    paint();
    paint();
    expect(telegramReady).not.toHaveBeenCalled();
    expect(distribution).toHaveBeenCalledTimes(1);
    expect(distribution).toHaveBeenCalledWith(
      'startup.shell_ready.duration',
      32,
      expect.objectContaining({
        attributes: expect.objectContaining({ telegram_ready: 'unavailable' }),
      })
    );
  });

  it('keeps the shell measurement when the native bridge fails and never exports route IDs', () => {
    telegramReady.mockImplementation(() => {
      throw new Error('bridge failed');
    });
    cleanup = observeStartupShell('/dramas/private-short-id?tgWebAppData=sensitive');
    paint();
    paint();
    expect(distribution).toHaveBeenCalledTimes(1);
    expect(distribution).toHaveBeenCalledWith(
      'startup.shell_ready.duration',
      32,
      expect.objectContaining({
        attributes: expect.objectContaining({ route: '/dramas/:id', telegram_ready: 'failed' }),
      })
    );
    expect(JSON.stringify(distribution.mock.calls)).not.toContain('sensitive');
    expect(JSON.stringify(distribution.mock.calls)).not.toContain('private-short-id');
  });

  it('releases Telegram even when Sentry throws', () => {
    distribution.mockImplementation(() => {
      throw new Error('telemetry failed');
    });
    cleanup = observeStartupShell('/');
    paint();
    expect(paint).not.toThrow();
    expect(telegramReady).toHaveBeenCalledOnce();
  });
});
