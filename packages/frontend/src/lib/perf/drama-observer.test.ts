import { afterEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => {
  const contexts = vi.fn();
  const logs = vi.fn();
  const metrics = vi.fn();
  const capture = vi.fn();
  return {
    contexts,
    logs,
    metrics,
    capture,
    scope: { setLevel: vi.fn(), setFingerprint: vi.fn(), setTags: vi.fn(), setContext: contexts },
  };
});
vi.mock('@sentry/nextjs', () => ({
  metrics: { distribution: sentry.metrics },
  captureMessage: sentry.capture,
  withScope: (run: (scope: typeof sentry.scope) => void) => run(sentry.scope),
}));
vi.mock('@/lib/sentry/client', () => ({ sendSentryLog: sentry.logs }));
vi.mock('./request-timing', () => ({ createRequestId: () => 'observation' }));
vi.mock('./env-tags', () => ({
  getMetricDimensions: () => ({ net_type: 'unknown', tg_platform: 'unknown' }),
}));
import { dramaTiming, installDramaTiming } from './drama-observer';

afterEach(() => {
  dramaTiming.background();
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('drama Sentry reporting', () => {
  it('keeps slow request details flat and never emits media URLs or response bodies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const flow = dramaTiming.beginPlayback('drama-id', 'cover');
    const data = await dramaTiming.query('playback', 'drama-id', undefined, async (observe) => {
      observe({
        requestId: 'api-request',
        queuedAt: performance.now(),
        dispatchedAt: performance.now(),
        endedAt: performance.now(),
        outcome: 'ok',
      });
      return {
        video_id: 'video-id',
        playable: true,
        play_url: 'https://example.invalid/private?token=never-record',
        expires_at: null,
      };
    });
    dramaTiming.playbackState(flow, data, false, false);
    flow.mark('source_set');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentry.capture).toHaveBeenCalledWith('drama_timing');
    expect(sentry.contexts).toHaveBeenCalledWith(
      'drama_request_0_0',
      expect.objectContaining({ requestId: 'api-request', outcome: 'ok' })
    );
    flow.finish('playing');
    expect(sentry.logs).toHaveBeenCalledWith(
      'info',
      'drama.request_timing',
      expect.objectContaining({ observation_id: 'observation', requestId: 'api-request' })
    );
    expect(sentry.logs).toHaveBeenCalledWith(
      'info',
      'drama.timing',
      expect.objectContaining({ video_id: 'video-id' })
    );
    const output = JSON.stringify([
      sentry.logs.mock.calls,
      sentry.contexts.mock.calls,
      sentry.metrics.mock.calls,
    ]);
    expect(output).not.toContain('never-record');
    expect(output).not.toContain('example.invalid');
    expect(JSON.stringify(sentry.metrics.mock.calls)).not.toContain('drama-id');
    expect(JSON.stringify(sentry.metrics.mock.calls)).not.toContain('api-request');
  });

  it('emits metrics and logs for normal cancellation without creating a warning issue', () => {
    dramaTiming.beginPlayback('a', 'cover').finish('switched');
    expect(sentry.logs).toHaveBeenCalled();
    expect(sentry.metrics).toHaveBeenCalled();
    expect(sentry.capture).not.toHaveBeenCalled();
  });
  it('does not start a false wait when clicking the already-active drama navigation tab', () => {
    vi.useFakeTimers();
    class Link {
      closest() {
        return this;
      }
      getAttribute(name: string) {
        return name === 'href' ? '/dramas' : null;
      }
    }
    const handlers = new Map<string, (event: MouseEvent) => void>();
    const location = { pathname: '/dramas' };
    vi.stubGlobal('Element', Link);
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: (name: string, callback: (event: MouseEvent) => void) =>
        handlers.set(name, callback),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', { location, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const begin = vi.spyOn(dramaTiming, 'beginList');
    const cleanup = installDramaTiming();
    const click = { target: new Link(), button: 0 } as unknown as MouseEvent;
    handlers.get('click')?.(click);
    expect(begin).not.toHaveBeenCalled();
    location.pathname = '/profile';
    handlers.get('click')?.(click);
    expect(begin).toHaveBeenCalledWith('navigation_click');
    cleanup();
  });
});
