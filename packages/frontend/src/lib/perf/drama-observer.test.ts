import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(async () => {}),
  info: vi.fn(),
  warn: vi.fn(),
  api: vi.fn(),
}));
vi.mock('@/lib/api/telemetry', () => ({ uploadDramaTiming: mocks.upload }));
vi.mock('@/lib/api/client', () => ({ apiClient: mocks.api }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: mocks.info, warn: mocks.warn }) }));
vi.mock('./request-timing', () => ({ createRequestId: () => 'observation' }));
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
  it('reports the actual lifecycle reason once and removes lifecycle listeners', () => {
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
    handlers.get('pagehide')?.();
    expect(mocks.upload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'background',
        media: expect.objectContaining({ events: [expect.objectContaining({ name: 'pagehide' })] }),
      })
    );
    documentState.hidden = true;
    handlers.get('visibilitychange')?.();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
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
