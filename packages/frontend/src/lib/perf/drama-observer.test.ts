import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DramaTimingReport } from './drama-timing';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(async (_report: DramaTimingReport) => {}),
  info: vi.fn(),
  warn: vi.fn(),
  api: vi.fn(),
  measurement: vi.fn(),
  event: vi.fn(),
  pageReady: vi.fn(),
  pageFailed: vi.fn(),
}));
vi.mock('@/lib/api/telemetry', () => ({ uploadDramaTiming: mocks.upload }));
vi.mock('@/lib/api/client', () => ({ apiClient: mocks.api }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: mocks.info, warn: mocks.warn }) }));
vi.mock('./request-timing', () => ({ createRequestId: () => 'observation' }));
vi.mock('./grafana', () => ({
  recordEngineeringMeasurement: mocks.measurement,
  recordEngineeringEvent: mocks.event,
}));
vi.mock('./page-tracker', () => ({
  markPageReady: mocks.pageReady,
  markPageFailed: mocks.pageFailed,
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

describe('drama centralized logging', () => {
  it('adds catalog start/final engineering signals without an additional legacy start upload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    dramaTiming.beginList('navigation_click');
    expect(mocks.event).toHaveBeenCalledWith(
      'drama.started',
      expect.objectContaining({ stage: 'catalog', report_kind: 'list' })
    );
    expect(mocks.upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    dramaTiming.listReady({});
    expect(mocks.measurement).toHaveBeenCalledExactlyOnceWith(
      'drama.catalog',
      750,
      expect.objectContaining({ outcome: 'ready' })
    );
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it('projects first frame and independent stages once; supplements cannot duplicate startup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const flow = dramaTiming.beginPlayback('private-drama', 'switch');
    flow.mark('player_ready');
    flow.addressReady();
    await vi.advanceTimersByTimeAsync(20);
    flow.mark('source_set');
    await vi.advanceTimersByTimeAsync(100);
    flow.mark('metadata');
    await vi.advanceTimersByTimeAsync(300);
    flow.mark('first_frame');
    flow.frameMethod = 'video_frame_callback';
    await vi.advanceTimersByTimeAsync(50);
    flow.mark('playing');
    flow.finish('playing');
    await Promise.resolve();
    expect(mocks.measurement).toHaveBeenCalledWith(
      'drama.startup',
      470,
      expect.objectContaining({ outcome: 'playing', source_measurement_version: 'drama_v2' })
    );
    expect(mocks.measurement).toHaveBeenCalledWith(
      'drama.first_frame',
      420,
      expect.objectContaining({ first_frame_method: 'video_frame_callback' })
    );
    expect(mocks.measurement).toHaveBeenCalledWith(
      'drama.stage',
      300,
      expect.objectContaining({ stage: 'metadata_to_frame' })
    );
    expect(mocks.pageReady).toHaveBeenCalledExactlyOnceWith(
      '/dramas/:id',
      'content',
      '/dramas/private-drama'
    );
    const count = mocks.measurement.mock.calls.length;
    flow.networkTiming({ status: 'no_entry', entries: [], truncated: false }, true);
    expect(mocks.measurement).toHaveBeenCalledTimes(count);
    expect(JSON.stringify([mocks.measurement.mock.calls, mocks.event.mock.calls])).not.toContain(
      'private-drama'
    );
  });

  it('preserves logging/upload on mirror failure and keeps playback error distinct from page ready', async () => {
    mocks.measurement.mockImplementationOnce(() => {
      throw new Error('collector failed');
    });
    dramaTiming.beginPlayback('a', 'direct').finish('error');
    await Promise.resolve();
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'final', outcome: 'error' })
    );
    expect(mocks.pageReady).not.toHaveBeenCalled();
    expect(mocks.pageFailed).toHaveBeenCalledWith('/dramas/:id', '/dramas/a');
  });

  it('uploads slow and final snapshots with request details and no media credentials', async () => {
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
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'drama.frontend_timing',
        phase: 'slow',
        observation_id: 'observation',
      })
    );
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'slow',
        queries: [
          expect.objectContaining({
            attempts: [expect.objectContaining({ requestId: 'api-request', outcome: 'ok' })],
          }),
        ],
      })
    );
    flow.finish('playing');
    expect(mocks.upload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'final',
        videoId: 'video-id',
        outcome: 'playing',
      })
    );
    const output = JSON.stringify([
      mocks.info.mock.calls,
      mocks.warn.mock.calls,
      mocks.upload.mock.calls,
    ]);
    expect(output).not.toContain('never-record');
    expect(output).not.toContain('example.invalid');
  });

  it('uploads normal cancellation and keeps reporting after a delivery failure', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('network unavailable'));
    dramaTiming.beginPlayback('a', 'cover').finish('switched');
    await Promise.resolve();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'drama.timing_upload_failed',
        observation_id: 'observation',
      })
    );
    dramaTiming.beginPlayback('b', 'switch').finish('playing');
    expect(mocks.upload).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'playing' }));
  });
  it('reports the actual lifecycle reason once and removes lifecycle listeners', async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, () => void>();
    const documentState = {
      hidden: false,
      addEventListener: (name: string, callback: () => void) => handlers.set(name, callback),
      removeEventListener: (name: string) => handlers.delete(name),
    };
    vi.stubGlobal('document', documentState);
    vi.stubGlobal('window', {
      addEventListener: (name: string, callback: () => void) => handlers.set(name, callback),
      removeEventListener: (name: string) => handlers.delete(name),
    });
    const cleanup = installDramaTiming();
    dramaTiming.beginPlayback('a', 'cover');
    expect(mocks.upload).not.toHaveBeenCalled();
    await Promise.resolve();
    handlers.get('pagehide')?.();
    expect(mocks.upload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'background',
        media: expect.objectContaining({ events: [expect.objectContaining({ name: 'pagehide' })] }),
      })
    );
    documentState.hidden = true;
    handlers.get('visibilitychange')?.();
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.upload.mock.calls.map(([report]) => report.phase)).toEqual(['start', 'final']);
    cleanup();
    expect(handlers.size).toBe(0);
  });
  it.each(['/', '/dramas'])(
    'does not start a false wait when clicking the active drama entry %s',
    (targetPath) => {
      vi.useFakeTimers();
      class Link {
        closest() {
          return this;
        }
        getAttribute(name: string) {
          return name === 'href' ? targetPath : null;
        }
      }
      const handlers = new Map<string, (event: MouseEvent) => void>();
      const location = { pathname: targetPath };
      vi.stubGlobal('Element', Link);
      vi.stubGlobal('document', {
        hidden: false,
        addEventListener: (name: string, callback: (event: MouseEvent) => void) =>
          handlers.set(name, callback),
        removeEventListener: vi.fn(),
      });
      vi.stubGlobal('window', {
        location,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      const begin = vi.spyOn(dramaTiming, 'beginList');
      const cleanup = installDramaTiming();
      const click = { target: new Link(), button: 0 } as unknown as MouseEvent;
      handlers.get('click')?.(click);
      expect(begin).not.toHaveBeenCalled();
      location.pathname = '/profile';
      handlers.get('click')?.(click);
      expect(begin).toHaveBeenCalledWith('navigation_click');
      cleanup();
    }
  );
});

describe('drama upload transport', () => {
  const report = {
    type: 'playback' as const,
    phase: 'final' as const,
    id: 'observation',
    outcome: 'playing' as const,
    elapsedMs: 123,
    marks: {},
    stages: {},
    queries: [],
  };
  it('uses one authenticated API POST with keepalive and background priority', async () => {
    const { uploadDramaTiming } =
      await vi.importActual<typeof import('@/lib/api/telemetry')>('@/lib/api/telemetry');
    mocks.api.mockResolvedValueOnce({ accepted: true });
    await uploadDramaTiming(report);
    expect(mocks.api).toHaveBeenCalledWith(
      '/api/telemetry/drama-timing',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        queuePriority: 'background',
        timeoutMs: 5000,
        body: JSON.stringify(report),
        signal: expect.any(AbortSignal),
      })
    );
  });
  it('ends a hung upload within its total budget without retrying', async () => {
    vi.useFakeTimers();
    const { uploadDramaTiming } =
      await vi.importActual<typeof import('@/lib/api/telemetry')>('@/lib/api/telemetry');
    mocks.api.mockImplementationOnce(
      (_path: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    const checked = expect(uploadDramaTiming(report)).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await checked;
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});
