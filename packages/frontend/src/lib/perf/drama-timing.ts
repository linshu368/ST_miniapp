import {
  DRAMA_TIMING_MAX_MEDIA_EVENTS,
  type DramaPlayback,
  type DramaTimingReport,
  type DramaMediaEvent,
  type DramaMediaState,
} from '@miniapp/shared';
export type { DramaTimingReport } from '@miniapp/shared';
import type { ApiAttemptTiming } from '@/lib/api/client';

export type DramaQueryKind = 'list' | 'queue' | 'detail' | 'playback';
export type DramaEntry = 'cover' | 'switch' | 'episode' | 'retry' | 'direct';
export type DramaOutcome =
  | 'playing'
  | 'error'
  | 'unplayable'
  | 'autoplay_blocked'
  | 'switched'
  | 'left'
  | 'background';
type Mark =
  | 'player_ready'
  | 'address_ready'
  | 'source_set'
  | 'metadata'
  | 'first_frame'
  | 'playing'
  | 'play_called'
  | 'play_resolved'
  | 'play_rejected'
  | 'loadeddata'
  | 'canplay';

export interface DramaQueryTiming {
  kind: DramaQueryKind;
  dramaId?: string;
  videoId?: string;
  startedAt: number;
  startedOrder: number;
  endedAt?: number;
  endedOrder?: number;
  outcome?: 'ok' | 'error';
  attempts: ApiAttemptTiming[];
  attemptsTruncated?: boolean;
}

interface ListTiming {
  id: string;
  startedAt: number;
  startKind: 'navigation_click' | 'route_commit' | 'query_start' | 'document_navigation' | 'retry';
  readyAt?: number;
  ended?: boolean;
  queriesTruncated?: boolean;
  queries: DramaQueryTiming[];
}

const SLOW_MS = 10_000;
const MAX_QUERY_RUNS = 12;
const rounded = (ms: number) => Math.round(Math.max(0, ms) * 10) / 10;

/** 全部使用同一个页面的单调时钟；报告只含耗时和允许的标识，不保存媒体 URL。 */
export class DramaPlaybackTiming {
  readonly marks: Partial<Record<Mark, number>> = {};
  readonly queries: DramaQueryTiming[] = [];
  outcome?: DramaOutcome;
  addressSource?: DramaTimingReport['addressSource'];
  frameMethod?: DramaTimingReport['frameMethod'];
  resolvedVideoId?: string;
  private timer: ReturnType<typeof setTimeout>;
  private endAt?: number;
  private queriesTruncated = false;
  private mediaEvents: DramaMediaEvent[] = [];
  private mediaEventsTruncated = false;
  private readMediaState?: () => DramaMediaState | undefined;

  constructor(
    readonly id: string,
    readonly dramaId: string,
    readonly requestedVideoId: string | undefined,
    readonly entry: DramaEntry,
    readonly startedAt: number,
    readonly startedOrder: number,
    private readonly now: () => number,
    private readonly emit: (report: DramaTimingReport) => void,
    private readonly list?: ListTiming,
    private readonly cover?: DramaTimingReport['cover']
  ) {
    this.timer = setTimeout(() => this.report('slow'), SLOW_MS);
  }

  mark(mark: Mark): void {
    if (this.outcome || this.marks[mark] !== undefined) return;
    this.marks[mark] = this.now();
  }

  bindMediaState(read: () => DramaMediaState | undefined): () => void {
    if (this.outcome) return () => {};
    this.readMediaState = read;
    return () => {
      if (this.readMediaState === read) this.readMediaState = undefined;
    };
  }

  private mediaSnapshot(): DramaMediaState | undefined {
    try {
      return this.readMediaState?.();
    } catch {
      // WebView 的媒体属性/TimeRanges 读取失败不能中断播放或丢掉整条报告。
      return undefined;
    }
  }

  mediaEvent(
    name: DramaMediaEvent['name'],
    detail: Pick<DramaMediaEvent, 'trigger' | 'error'> = {}
  ): void {
    if (this.outcome) return;
    if (this.mediaEvents.length >= DRAMA_TIMING_MAX_MEDIA_EVENTS) {
      this.mediaEventsTruncated = true;
      return;
    }
    this.mediaEvents.push({
      name,
      atMs: rounded(this.now() - this.startedAt),
      ...detail,
      state: this.mediaSnapshot(),
    });
  }

  addQuery(query: DramaQueryTiming): void {
    if (this.outcome || this.queries.includes(query)) return;
    if (this.queries.length >= MAX_QUERY_RUNS) {
      this.queriesTruncated = true;
      return;
    }
    this.queries.push(query);
  }

  addressReady(query?: DramaQueryTiming): void {
    if (this.outcome || this.marks.address_ready !== undefined) return;
    this.addressSource = query
      ? query.startedOrder > this.startedOrder
        ? 'fetch'
        : query.endedOrder === undefined || query.endedOrder > this.startedOrder
          ? 'inflight'
          : 'cache'
      : 'unknown';
    // 命中旧缓存的请求只能当作来源，不能算成本次等待，也不能挂到本次请求时间线。
    if (query && this.addressSource !== 'cache') this.addQuery(query);
    // API 完成到 React effect 执行之间可能有调度延迟，应归到 address_to_source，
    // 不能误报成后端/网络等待。旧缓存从本次入口起就已经可用。
    this.marks.address_ready =
      query?.endedAt === undefined ? this.now() : Math.max(this.startedAt, query.endedAt);
  }

  finish(outcome: DramaOutcome): void {
    if (this.outcome) return;
    this.endAt = this.now();
    this.outcome = outcome;
    clearTimeout(this.timer);
    this.report('final');
    this.readMediaState = undefined;
  }

  private report(phase: 'slow' | 'final'): void {
    if (phase === 'slow' && this.outcome) return;
    const end = this.endAt ?? this.now();
    const marks = Object.fromEntries(
      Object.entries(this.marks).map(([key, at]) => [key, rounded(at - this.startedAt)])
    );
    const stages: Record<string, number> = {};
    const between = (key: string, start: number | undefined, finish: number | undefined) => {
      if (start !== undefined && finish !== undefined) stages[key] = rounded(finish - start);
    };
    between('navigation', this.startedAt, this.marks.player_ready);
    between('address_wait', this.startedAt, this.marks.address_ready);
    // 地址预取与路由并行：前两项是重叠区间，禁止相加当作总耗时。
    between('address_to_source', this.marks.address_ready, this.marks.source_set);
    between('source_to_metadata', this.marks.source_set, this.marks.metadata);
    between('metadata_to_frame', this.marks.metadata, this.marks.first_frame);
    between('source_to_frame', this.marks.source_set, this.marks.first_frame);
    between('source_to_playing', this.marks.source_set, this.marks.playing);
    const list = this.list;
    this.emit({
      type: 'playback',
      phase,
      id: this.id,
      entry: this.entry,
      dramaId: this.dramaId,
      videoId: this.resolvedVideoId ?? this.requestedVideoId,
      outcome: this.outcome ?? 'waiting',
      elapsedMs: rounded(end - this.startedAt),
      marks,
      stages,
      addressSource: this.addressSource,
      frameMethod: this.frameMethod,
      cover: this.cover,
      list: list
        ? {
            id: list.id,
            startKind: list.startKind,
            readyMs:
              list.readyAt === undefined ? undefined : rounded(list.readyAt - list.startedAt),
            browseMs:
              list.readyAt === undefined ? undefined : rounded(this.startedAt - list.readyAt),
            sinceEntryMs: rounded(end - list.startedAt),
          }
        : undefined,
      queryDetailsTruncated: this.queriesTruncated,
      media:
        this.readMediaState || this.mediaEvents.length > 0
          ? {
              // 慢报告必须固定当时的数据，后续事件不能改写已发送的快照。
              events: this.mediaEvents.slice(),
              eventsTruncated: this.mediaEventsTruncated,
              snapshot: this.mediaSnapshot(),
            }
          : undefined,
      queries: this.queries.map((query) => queryReport(query, this.startedAt, end)),
    });
  }
}

function queryReport(
  query: DramaQueryTiming,
  origin: number,
  end: number
): DramaTimingReport['queries'][number] {
  return {
    kind: query.kind,
    // 复用进入本页前已在途的请求时，负偏移是真实的，不能截断成 0。
    startMs: Math.round((query.startedAt - origin) * 10) / 10,
    durationMs: rounded(Math.min(query.endedAt ?? end, end) - query.startedAt),
    outcome:
      query.endedAt !== undefined && query.endedAt <= end
        ? (query.outcome ?? 'unknown')
        : 'pending',
    attemptsTruncated: query.attemptsTruncated,
    attempts: query.attempts.map((attempt) => {
      const endedAt = Math.min(attempt.endedAt ?? end, end);
      const dispatchedAt = attempt.dispatchedAt;
      const headersAt = attempt.headersAt;
      return {
        requestId: attempt.requestId,
        startMs: Math.round((attempt.queuedAt - origin) * 10) / 10,
        queueMs: rounded((dispatchedAt ?? endedAt) - attempt.queuedAt),
        headersMs:
          dispatchedAt === undefined ? undefined : rounded((headersAt ?? endedAt) - dispatchedAt),
        bodyMs: headersAt === undefined ? undefined : rounded(endedAt - headersAt),
        totalMs: rounded(endedAt - attempt.queuedAt),
        status: attempt.status,
        outcome:
          attempt.endedAt !== undefined && attempt.endedAt <= end
            ? (attempt.outcome ?? 'unknown')
            : 'pending',
      };
    }),
  };
}

export class DramaTimingTracker {
  private list?: ListTiming;
  private playback?: DramaPlaybackTiming;
  private readonly pending = new Set<DramaQueryTiming>();
  private readonly dataQueries = new WeakMap<object, DramaQueryTiming>();
  private listTimer?: ReturnType<typeof setTimeout>;
  private onListRoute = false;
  // WebView 时钟精度可能较低，同一刻度内的缓存/在途判定用事件顺序，不能比较时间戳猜测。
  private sequence = 0;

  constructor(
    private readonly now: () => number,
    private readonly newId: () => string,
    private readonly reporter: (report: DramaTimingReport) => void
  ) {}

  private emit = (report: DramaTimingReport): void => {
    try {
      this.reporter(report);
    } catch {
      /* 观测失败不得改变播放/请求结果。 */
    }
  };

  beginList(startKind: ListTiming['startKind'], startedAt = this.now()): void {
    this.endList();
    this.list = { id: this.newId(), startedAt, startKind, queries: [] };
    this.listTimer = setTimeout(
      () => this.reportList('slow', 'waiting'),
      Math.max(0, SLOW_MS - (this.now() - startedAt))
    );
  }

  route(pathname: string, documentStart?: number): void {
    const match = /^\/dramas\/([^/]+)\/?$/.exec(pathname);
    if (this.playback && (!match || match[1] !== this.playback.dramaId)) {
      this.playback.finish('left');
      this.playback = undefined;
    }
    if (pathname === '/dramas') {
      if (!this.onListRoute && (!this.list || this.list.ended))
        this.beginList(
          documentStart === undefined ? 'route_commit' : 'document_navigation',
          documentStart
        );
      this.onListRoute = true;
    } else {
      this.onListRoute = false;
      this.endList();
      if (!match) this.list = undefined;
    }
  }

  listReady(data: object): void {
    if (!this.list || this.list.ended) this.beginList('route_commit');
    const list = this.list!;
    if (list.readyAt !== undefined) return;
    const query = this.dataQueries.get(data);
    if (
      query &&
      query.endedAt !== undefined &&
      query.endedAt >= list.startedAt &&
      !list.queries.includes(query)
    )
      this.addListQuery(query);
    list.readyAt = this.now();
    clearTimeout(this.listTimer);
    this.reportList('final', 'ready');
  }

  private reportList(phase: 'slow' | 'final', outcome: DramaTimingReport['outcome']): void {
    const list = this.list;
    if (!list) return;
    const end = list.readyAt ?? this.now();
    this.emit({
      type: 'list',
      phase,
      id: list.id,
      outcome,
      elapsedMs: rounded(end - list.startedAt),
      marks: {},
      stages: {},
      list: {
        id: list.id,
        startKind: list.startKind,
        sinceEntryMs: rounded(end - list.startedAt),
        readyMs: list.readyAt === undefined ? undefined : rounded(list.readyAt - list.startedAt),
      },
      queryDetailsTruncated: list.queriesTruncated ?? false,
      queries: list.queries.map((query) => queryReport(query, list.startedAt, end)),
    });
  }

  private addListQuery(query: DramaQueryTiming): void {
    if (!this.list || this.list.queries.includes(query)) return;
    if (this.list.queries.length >= MAX_QUERY_RUNS) this.list.queriesTruncated = true;
    else this.list.queries.push(query);
  }

  listFailed(): void {
    if (!this.list || this.list.ended || this.list.readyAt !== undefined) return;
    clearTimeout(this.listTimer);
    this.reportList('final', 'error');
    this.list.ended = true;
  }

  private endList(): void {
    clearTimeout(this.listTimer);
    if (this.list && !this.list.ended) {
      if (this.list.readyAt === undefined) this.reportList('final', 'left');
      this.list.ended = true;
    }
  }

  beginPlayback(
    dramaId: string,
    entry: DramaEntry,
    videoId?: string,
    cover?: DramaTimingReport['cover']
  ): DramaPlaybackTiming {
    this.playback?.finish('switched');
    const playback = new DramaPlaybackTiming(
      this.newId(),
      dramaId,
      videoId,
      entry,
      this.now(),
      ++this.sequence,
      this.now,
      this.emit,
      entry === 'cover' ? this.list : undefined,
      cover
    );
    this.playback = playback;
    for (const query of this.pending) if (this.matches(query, playback)) playback.addQuery(query);
    return playback;
  }

  ensurePlayback(dramaId: string, videoId?: string): DramaPlaybackTiming {
    const active = this.playback;
    return active && active.dramaId === dramaId && active.requestedVideoId === videoId
      ? active
      : this.beginPlayback(dramaId, 'direct', videoId);
  }

  playbackState(
    timing: DramaPlaybackTiming,
    data: DramaPlayback | undefined,
    isFetching: boolean,
    isError: boolean
  ): void {
    timing.mark('player_ready');
    if (data?.video_id && !timing.outcome) timing.resolvedVideoId = data.video_id;
    if (data?.playable && data.play_url) timing.addressReady(this.dataQuery(data));
    // refetch 时会保留旧的不可播结果，必须等本轮查询结束后才能判定失败。
    else if (data && !isFetching) timing.finish('unplayable');
    else if (!data && isError) timing.finish('error');
  }

  background(reason: 'visibility_hidden' | 'pagehide' = 'visibility_hidden'): void {
    this.playback?.mediaEvent(reason);
    this.playback?.finish('background');
    this.endList();
    this.list = undefined;
  }

  private matches(query: DramaQueryTiming, playback: DramaPlaybackTiming): boolean {
    return (
      query.kind === 'queue' ||
      (query.dramaId === playback.dramaId &&
        (query.kind === 'detail' ||
          (query.kind === 'playback' && query.videoId === playback.requestedVideoId)))
    );
  }

  async query<T extends object>(
    kind: DramaQueryKind,
    dramaId: string | undefined,
    videoId: string | undefined,
    run: (onAttempt: (attempt: ApiAttemptTiming) => void) => Promise<T>
  ): Promise<T> {
    const query: DramaQueryTiming = {
      kind,
      dramaId,
      videoId,
      startedAt: this.now(),
      startedOrder: ++this.sequence,
      attempts: [],
    };
    this.pending.add(query);
    if (kind === 'list') {
      if (!this.list || this.list.ended) this.beginList('query_start', query.startedAt);
      this.addListQuery(query);
    }
    if (this.playback && this.matches(query, this.playback)) this.playback.addQuery(query);
    try {
      const data = await run((attempt) => {
        if (query.attempts.length < 4) query.attempts.push(attempt);
        else query.attemptsTruncated = true;
      });
      query.outcome = 'ok';
      this.dataQueries.set(data, query);
      return data;
    } catch (err) {
      query.outcome = 'error';
      throw err;
    } finally {
      query.endedAt = this.now();
      query.endedOrder = ++this.sequence;
      this.pending.delete(query);
    }
  }

  dataQuery(data: object): DramaQueryTiming | undefined {
    return this.dataQueries.get(data);
  }
}
