import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DramaTimingTracker, type DramaTimingReport } from './drama-timing';

let reports: DramaTimingReport[];
let tracker: DramaTimingTracker;
let sequence: number;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const last = () => reports.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  reports = [];
  sequence = 0;
  tracker = new DramaTimingTracker(
    () => performance.now(),
    () => `observation-${++sequence}`,
    (report) => reports.push(report)
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('drama timeline', () => {
  it('retains the original failed attempt and cumulative wait after user retry', async () => {
    const original = tracker.beginPlayback('a', 'cover');
    await advance(6000);
    original.finish('error');
    const failed = structuredClone(last());
    await advance(1000);
    const retry = tracker.beginPlayback('a', 'retry');
    await advance(100);
    retry.finish('playing');
    expect(last()).toMatchObject({
      elapsedMs: 100,
      recovery: { rootId: original.id, parentId: original.id, cumulativeMs: 7100 },
    });
    expect(failed).toMatchObject({ outcome: 'error', elapsedMs: 6000, overFiveSeconds: true });
    expect(reports.find((report) => report.id === original.id && report.phase === 'final')).toEqual(
      failed
    );
  });
  it.each([4999, 5000, 5000.01, 30000])(
    'keeps the exact boundary and real elapsed at %s ms',
    (elapsed) => {
      let time = 0;
      const own = new DramaTimingTracker(
        () => time,
        () => 'boundary',
        (report) => reports.push(report)
      );
      const flow = own.beginPlayback('a', 'direct');
      time = elapsed;
      flow.finish('playing');
      expect(last().elapsedMs).toBe(elapsed);
      expect(last().overFiveSeconds).toBe(elapsed > 5000);
    }
  );
  it.each(['playing', 'background', 'left'] as const)(
    'does not count a completed/exited visit as recovery waiting: %s',
    async (outcome) => {
      const original = tracker.beginPlayback('a', 'direct');
      await advance(100);
      original.finish(outcome);
      await advance(30000);
      const retry = tracker.beginPlayback('a', 'retry');
      await advance(100);
      retry.finish('playing');
      expect(last().recovery).toEqual({ rootId: retry.id, cumulativeMs: 100 });
      expect(last().recovery?.rootId).not.toBe(original.id);
    }
  );
  it('includes initial MiniApp navigation in automatic homepage first-frame waiting', async () => {
    tracker.beginList('document_navigation', 0);
    await advance(4000);
    const flow = tracker.beginPlayback('a', 'direct');
    await advance(2000);
    flow.finish('playing');
    expect(last()).toMatchObject({ elapsedMs: 2000, entryElapsedMs: 6000, overFiveSeconds: true });
  });
  it('keeps browsing separate from startup and does not sum overlapping prefetch/navigation', async () => {
    tracker.beginList('navigation_click');
    await advance(200);
    tracker.listReady([]);
    await advance(5000);
    const flow = tracker.beginPlayback('drama-a', 'cover');
    await advance(100);
    flow.mark('player_ready');
    await advance(200);
    flow.addressReady();
    await advance(10);
    flow.mark('source_set');
    await advance(400);
    flow.mark('metadata');
    await advance(600);
    flow.mark('first_frame');
    flow.mark('playing');
    flow.finish('playing');
    expect(last()).toMatchObject({
      elapsedMs: 1310,
      stages: {
        navigation: 100,
        address_wait: 300,
        address_to_source: 10,
        source_to_metadata: 400,
        source_to_frame: 1000,
      },
      list: { readyMs: 200, browseMs: 5000, sinceEntryMs: 6510 },
    });
  });

  it('binds home catalog route and preserves its document origin across root effects', async () => {
    tracker.beginList('document_navigation', 0, '/');
    tracker.route('/');
    await advance(200);
    tracker.listReady([], '/');
    expect(last()).toMatchObject({
      route: '/',
      definition: 'drama_v3',
      elapsedMs: 200,
      list: { startKind: 'document_navigation' },
    });
    tracker.route('/dramas');
    await advance(100);
    tracker.listReady([]);
    expect(last()).toMatchObject({ route: '/dramas', elapsedMs: 100 });
  });
  it('records catalog background in the owner once, before any transport projection', () => {
    tracker.beginList('navigation_click');
    tracker.background();
    tracker.background();
    expect(reports).toHaveLength(1);
    expect(last()).toMatchObject({ type: 'list', phase: 'final', outcome: 'background' });
  });
  it('omits reversed stage intervals instead of manufacturing zero duration', async () => {
    const flow = tracker.beginPlayback('a', 'direct');
    flow.mark('loadeddata');
    await advance(100);
    flow.mark('metadata');
    flow.finish('playing');
    expect(last().stages.metadata_to_data).toBeUndefined();
  });
  it('cached data does not count the original request as a new wait', async () => {
    const data = await tracker.query('playback', 'a', undefined, async () => {
      await advance(900);
      return {};
    });
    await advance(5000);
    const flow = tracker.beginPlayback('a', 'cover');
    flow.addressReady(tracker.dataQuery(data));
    flow.finish('playing');
    expect(last()).toMatchObject({
      elapsedMs: 0,
      addressSource: 'cache',
      queries: [],
      stages: { address_wait: 0 },
    });
  });

  it('reuses an in-flight request with its true negative start offset', async () => {
    let resolve!: (data: object) => void;
    const pending = tracker.query(
      'playback',
      'a',
      undefined,
      () =>
        new Promise<object>((done) => {
          resolve = done;
        })
    );
    await advance(200);
    const flow = tracker.beginPlayback('a', 'cover');
    await advance(300);
    resolve({});
    const data = await pending;
    flow.addressReady(tracker.dataQuery(data));
    flow.finish('playing');
    expect(last()).toMatchObject({
      elapsedMs: 300,
      addressSource: 'inflight',
      queries: [{ startMs: -200, durationMs: 500 }],
    });
  });

  it('records transport attempts, body time and React Query retry gaps across a minute', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 1000, structuralSharing: false } },
    });
    const flow = tracker.beginPlayback('a', 'cover');
    let queryCalls = 0;
    const request = client.fetchQuery({
      queryKey: ['a'],
      queryFn: () =>
        tracker.query('playback', 'a', undefined, async (observe) => {
          queryCalls++;
          const attemptCount = queryCalls === 1 ? 2 : 1;
          for (let attemptIndex = 0; attemptIndex < attemptCount; attemptIndex++) {
            const attempt: import('@/lib/api/client').ApiAttemptTiming = {
              requestId: `${queryCalls}-${attemptIndex}`,
              queuedAt: performance.now(),
              dispatchedAt: performance.now(),
            };
            observe(attempt);
            await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
            attempt.endedAt = performance.now();
            attempt.outcome = queryCalls === 1 ? 'timeout' : 'ok';
          }
          if (queryCalls === 1) throw new Error('network');
          return {};
        }),
    });
    await advance(61_000);
    const data = await request;
    flow.addressReady(tracker.dataQuery(data));
    flow.finish('playing');
    const report = last();
    expect(report.elapsedMs).toBe(61_000);
    expect(report.queries).toHaveLength(2);
    expect(report.queries[1]?.startMs).toBe(41_000);
    expect(report.queries[0]?.durationMs).toBe(40_000);
    expect(report.queries[1]?.durationMs).toBe(20_000);
    expect(report.queries[1]?.attempts[0]?.totalMs).toBe(20_000);
    expect(report.queries[0]?.attempts).toHaveLength(2);
    client.clear();
  });

  it('measures response body separately and freezes a slow snapshot before late completion', async () => {
    const flow = tracker.beginPlayback('a', 'cover');
    let resolve!: (value: object) => void;
    const pending = tracker.query('playback', 'a', undefined, (observe) => {
      const attempt = {
        requestId: 'req-1',
        queuedAt: 0,
        dispatchedAt: 200,
        headersAt: 500,
        endedAt: undefined as number | undefined,
        outcome: undefined as 'ok' | undefined,
      };
      observe(attempt);
      return new Promise<object>((done) => {
        resolve = (data) => {
          attempt.endedAt = performance.now();
          attempt.outcome = 'ok';
          done(data);
        };
      });
    });
    await advance(10_000);
    const snapshot = structuredClone(last());
    expect(snapshot).toMatchObject({
      phase: 'slow',
      outcome: 'waiting',
      queries: [{ attempts: [{ queueMs: 200, headersMs: 300, bodyMs: 4501, outcome: 'pending' }] }],
    });
    await advance(55_000);
    resolve({});
    const data = await pending;
    flow.addressReady(tracker.dataQuery(data));
    flow.finish('playing');
    expect(last()).toMatchObject({
      elapsedMs: 65_000,
      queries: [{ attempts: [{ bodyMs: 64_500, outcome: 'ok' }] }],
    });
    expect(reports[0]).toEqual(snapshot);
    expect(reports.filter((report) => report.phase === 'slow')).toHaveLength(1);
  });

  it('ignores old requests and old first frames after switching', async () => {
    const first = tracker.beginPlayback('a', 'cover');
    let resolve!: (value: object) => void;
    const oldRequest = tracker.query(
      'playback',
      'a',
      undefined,
      () =>
        new Promise<object>((done) => {
          resolve = done;
        })
    );
    await advance(100);
    const second = tracker.beginPlayback('b', 'switch');
    first.mark('first_frame');
    first.finish('playing');
    resolve({});
    await oldRequest;
    second.mark('source_set');
    await advance(300);
    second.finish('playing');
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ dramaId: 'a', outcome: 'switched', elapsedMs: 100 });
    expect(last()).toMatchObject({ dramaId: 'b', entry: 'switch', queries: [], elapsedMs: 300 });
  });

  it('does not restart on repeated mount/Strict Mode setup or finish twice', () => {
    const flow = tracker.beginPlayback('a', 'cover');
    expect(tracker.ensurePlayback('a')).toBe(flow);
    flow.mark('player_ready');
    tracker.route('/dramas/a');
    expect(tracker.ensurePlayback('a')).toBe(flow);
    flow.finish('error');
    flow.finish('playing');
    expect(tracker.ensurePlayback('a')).toBe(flow);
    expect(reports).toHaveLength(1);
    expect(last().outcome).toBe('error');
  });

  it('keeps an embedded startup alive when the root route effect runs after the player effect', () => {
    const flow = tracker.ensurePlayback('a', undefined, 'home');
    flow.mark('player_ready');
    tracker.route('/');
    expect(flow.outcome).toBeUndefined();
    expect(tracker.ensurePlayback('a', undefined, 'home')).toBe(flow);

    tracker.playbackState(
      flow,
      { video_id: 'v', playable: true, play_url: 'not-requested', expires_at: null },
      false,
      false
    );
    flow.mark('source_set');
    flow.mark('metadata');
    flow.mark('first_frame');
    flow.mark('playing');
    flow.finish('playing');
    expect(last()).toMatchObject({
      outcome: 'playing',
      marks: { player_ready: 0, source_set: 0, metadata: 0, first_frame: 0, playing: 0 },
    });
  });

  it('uses separate home/detail owners for the same drama without reviving either terminal', () => {
    const home = tracker.ensurePlayback('a', undefined, 'home');
    tracker.route('/');
    const detail = tracker.ensurePlayback('a', undefined, 'detail');
    expect(detail).not.toBe(home);
    expect(home.outcome).toBe('left');
    tracker.route('/dramas/a');
    expect(detail.outcome).toBeUndefined();
    expect(tracker.ensurePlayback('a', undefined, 'detail')).toBe(detail);

    const returnedHome = tracker.ensurePlayback('a', undefined, 'home');
    expect(returnedHome).not.toBe(detail);
    expect(detail.outcome).toBe('left');
    tracker.route('/');
    returnedHome.finish('playing');
    expect(tracker.ensurePlayback('a', undefined, 'home')).toBe(returnedHome);
    returnedHome.finish('error');
    expect(last().outcome).toBe('playing');
    expect(
      reports.filter((report) => report.type === 'playback').map((report) => report.outcome)
    ).toEqual(['left', 'left', 'playing']);
  });

  it('ends a home owner on real navigation away and creates a fresh visit on return', () => {
    const home = tracker.ensurePlayback('a', undefined, 'home');
    home.mark('player_ready');
    tracker.route('/');
    expect(home.outcome).toBeUndefined();
    tracker.route('/profile');
    expect(home.outcome).toBe('left');
    home.mark('first_frame');
    home.finish('playing');
    expect(home.marks.first_frame).toBeUndefined();

    const returned = tracker.ensurePlayback('a', undefined, 'home');
    expect(returned).not.toBe(home);
    tracker.route('/');
    expect(returned.outcome).toBeUndefined();
    returned.finish('playing');
    expect(
      reports.filter((report) => report.type === 'playback').map((report) => report.outcome)
    ).toEqual(['left', 'playing']);
  });

  it('keeps explicit same-owner switches distinct from cross-owner exits and stale updates', () => {
    const first = tracker.beginPlayback('a', 'direct', undefined, undefined, 'home');
    const next = tracker.beginPlayback('b', 'switch', undefined, undefined, 'home');
    expect(first.outcome).toBe('switched');
    tracker.playbackState(first, undefined, false, true);
    tracker.route('/');
    expect(tracker.ensurePlayback('b', undefined, 'home')).toBe(next);
    expect(next.outcome).toBeUndefined();

    const detail = tracker.beginPlayback('b', 'direct');
    expect(next.outcome).toBe('left');
    tracker.route('/dramas/b');
    const switchedDetail = tracker.beginPlayback('c', 'switch');
    expect(detail.outcome).toBe('switched');
    tracker.route('/dramas/c');
    expect(switchedDetail.outcome).toBeUndefined();
    tracker.route('/dramas/d');
    expect(switchedDetail.outcome).toBe('left');
  });

  it('closes waits on background and distinguishes a new retry', async () => {
    tracker.beginPlayback('a', 'cover');
    await advance(500);
    tracker.background();
    await advance(60_000);
    expect(reports).toHaveLength(1);
    expect(last()).toMatchObject({ outcome: 'background', elapsedMs: 500 });
    const retry = tracker.beginPlayback('a', 'retry');
    await advance(300);
    retry.finish('playing');
    expect(last()).toMatchObject({ entry: 'retry', elapsedMs: 300 });
  });

  it('starts a fresh list visit on return, without keeping old browse time', async () => {
    tracker.route('/dramas');
    await advance(100);
    tracker.listReady([]);
    const oldId = last().id;
    tracker.beginPlayback('a', 'cover');
    tracker.route('/dramas/a');
    await advance(5000);
    tracker.listReady([]);
    tracker.route('/dramas');
    const visit = reports.findLast((report) => report.type === 'list')!;
    expect(visit.id).not.toBe(oldId);
    expect(visit).toMatchObject({ type: 'list', outcome: 'ready', elapsedMs: 0 });
    await advance(10_000);
    expect(reports.filter((report) => report.type === 'list')).toHaveLength(2);
  });

  it('records query failure without closing startup prematurely during automatic retry', async () => {
    const flow = tracker.beginPlayback('a', 'cover');
    await expect(
      tracker.query('playback', 'a', undefined, async () => {
        throw new Error('failure');
      })
    ).rejects.toThrow('failure');
    expect(reports).toHaveLength(0);
    await advance(1000);
    const data = await tracker.query('playback', 'a', undefined, async () => ({}));
    flow.addressReady(tracker.dataQuery(data));
    flow.finish('playing');
    expect(last().queries.map((query) => query.outcome)).toEqual(['error', 'ok']);
  });

  it('keeps metadata failures as a parallel branch, separate from a successful playback', async () => {
    const flow = tracker.beginPlayback('a', 'direct');
    await expect(
      tracker.query('detail', 'a', undefined, async () => {
        throw new Error('detail failed');
      })
    ).rejects.toThrow();
    const data = await tracker.query('playback', 'a', undefined, async () => ({}));
    flow.addressReady(tracker.dataQuery(data));
    flow.finish('playing');
    expect(last().outcome).toBe('playing');
    expect(last().queries.map((query) => query.kind)).toEqual(['detail', 'playback']);
  });

  it('does not turn deep-link queue fetching into a fake list visit', async () => {
    const flow = tracker.beginPlayback('a', 'direct');
    await tracker.query('queue', undefined, undefined, async () => []);
    flow.finish('playing');
    expect(last()).toMatchObject({ list: undefined, queries: [{ kind: 'queue' }] });
  });

  it('does not let reporter exceptions change query or playback outcomes', async () => {
    tracker = new DramaTimingTracker(
      () => performance.now(),
      () => 'id',
      () => {
        throw new Error('telemetry down');
      }
    );
    const flow = tracker.beginPlayback('a', 'direct');
    await expect(tracker.query('playback', 'a', undefined, async () => ({}))).resolves.toEqual({});
    expect(() => flow.finish('playing')).not.toThrow();
  });
  it('does not finish a retry on the retained unplayable result of a previous request', async () => {
    const stale = { playable: false, play_url: null, expires_at: null, video_id: null };
    const first = tracker.beginPlayback('a', 'cover');
    tracker.playbackState(first, stale, false, false);
    expect(last().outcome).toBe('unplayable');
    const retry = tracker.beginPlayback('a', 'retry');
    tracker.playbackState(retry, stale, true, false);
    expect(retry.outcome).toBeUndefined();
    await advance(200);
    const fresh = await tracker.query('playback', 'a', undefined, async () => ({
      playable: true,
      play_url: 'not-recorded',
      expires_at: null,
      video_id: 'v',
    }));
    tracker.playbackState(retry, fresh, false, false);
    retry.finish('playing');
    expect(last()).toMatchObject({ entry: 'retry', outcome: 'playing', elapsedMs: 200 });
    expect(JSON.stringify(reports)).not.toContain('not-recorded');
  });
  it('a late update from the old player cannot replace a pending navigation target', () => {
    const old = tracker.beginPlayback('a', 'cover');
    const next = tracker.beginPlayback('b', 'switch');
    tracker.playbackState(old, undefined, false, true);
    expect(tracker.ensurePlayback('b')).toBe(next);
    expect(next.outcome).toBeUndefined();
    expect(reports).toHaveLength(1);
  });

  it('creates a new direct observation when returning to the same drama through browser history', () => {
    const old = tracker.beginPlayback('a', 'direct');
    old.finish('playing');
    tracker.route('/profile');
    const next = tracker.ensurePlayback('a');
    expect(next).not.toBe(old);
    expect(next.outcome).toBeUndefined();
  });

  it('ends an errored list visit immediately and measures its retry independently', async () => {
    tracker.beginList('navigation_click');
    await advance(300);
    tracker.listFailed();
    expect(last()).toMatchObject({ type: 'list', outcome: 'error', elapsedMs: 300 });
    tracker.beginList('retry');
    await advance(200);
    tracker.listReady([]);
    expect(last()).toMatchObject({ type: 'list', outcome: 'ready', elapsedMs: 200 });
    await advance(10_000);
    expect(reports).toHaveLength(2);
  });
  it('distinguishes cache, in-flight reuse and fresh fetch even when timestamps are equal', async () => {
    tracker = new DramaTimingTracker(
      () => 100,
      () => `id-${++sequence}`,
      (report) => reports.push(report)
    );
    const cached = await tracker.query('playback', 'a', undefined, async () => ({}));
    const cachedFlow = tracker.beginPlayback('a', 'cover');
    cachedFlow.addressReady(tracker.dataQuery(cached));
    expect(cachedFlow.addressSource).toBe('cache');
    let resolve!: (value: object) => void;
    const pending = tracker.query(
      'playback',
      'b',
      undefined,
      () =>
        new Promise<object>((done) => {
          resolve = done;
        })
    );
    const reusedFlow = tracker.beginPlayback('b', 'switch');
    resolve({});
    const reused = await pending;
    reusedFlow.addressReady(tracker.dataQuery(reused));
    expect(reusedFlow.addressSource).toBe('inflight');
    const freshFlow = tracker.beginPlayback('c', 'switch');
    const fresh = await tracker.query('playback', 'c', undefined, async () => ({}));
    freshFlow.addressReady(tracker.dataQuery(fresh));
    expect(freshFlow.addressSource).toBe('fetch');
  });
  it('keeps React delivery/mount delay out of the actual address API wait', async () => {
    const flow = tracker.beginPlayback('a', 'cover');
    await advance(200);
    const data = await tracker.query('playback', 'a', undefined, async () => ({}));
    await advance(1800);
    flow.mark('player_ready');
    flow.addressReady(tracker.dataQuery(data));
    flow.mark('source_set');
    flow.finish('playing');
    expect(last()).toMatchObject({
      elapsedMs: 2000,
      stages: { navigation: 2000, address_wait: 200, address_to_source: 1800 },
    });
  });
});
