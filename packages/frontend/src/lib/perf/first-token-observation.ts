import type { ReportFirstTokenRequest } from '@miniapp/shared';
import { recordEngineeringEvent, recordEngineeringMeasurement } from './grafana';

export interface FirstTokenIdentity {
  requestId: string;
  assistantMessageId: string | null;
  revision: number;
}

export type FirstTokenDelayAttribution = 'on_time' | 'ours' | 'user_network';

/** A reused socket proven alive this recently cannot be the dead connection we could fix. */
const CONNECTION_PROOF_MAX_AGE_MS = 60_000;
/** Reasons that mean the server gave up, whether or not the browser clock had expired. */
const SERVER_TIMEOUT_REASONS: ReadonlySet<string | null> = new Set([
  'server_timeout',
  'fallback_timeout',
  'primary_timeout',
]);

/**
 * Only time spent moving data over an already established connection is the user's own
 * network. Connection setup can be improved by us, so it stays ours, and so does any wait
 * we cannot prove: a missing first token or missing timing never moves blame to the user.
 */
export function attributeFirstTokenDelay(input: {
  waitMs: number | null;
  deadlineMs: number;
  pathMs: number | null;
}): FirstTokenDelayAttribution {
  const { waitMs, deadlineMs, pathMs } = input;
  if (waitMs !== null && waitMs < deadlineMs) return 'on_time';
  if (waitMs === null || pathMs === null) return 'ours';
  return waitMs - pathMs >= deadlineMs ? 'ours' : 'user_network';
}

/** Streams finish long before this; it only bounds an observer whose report never runs. */
const TIMING_OBSERVER_MAX_MS = 180_000;

function isRequestEntry(entry: PerformanceEntry, url: string, startedAt: number): boolean {
  return entry.name === url && entry.startTime >= startedAt - 1;
}

function bufferedRequestEntry(url: string, startedAt: number) {
  if (typeof performance.getEntriesByName !== 'function') return null;
  return (performance
    .getEntriesByName(url, 'resource')
    .filter((item) => item.startTime >= startedAt - 1)
    .at(-1) ?? null) as PerformanceResourceTiming | null;
}

function requestTiming(entry: PerformanceResourceTiming | null) {
  // Without Timing-Allow-Origin the browser zeroes these fields; that is no evidence.
  if (!entry || entry.requestStart <= 0) return null;
  return {
    setupMs: Math.max(0, entry.requestStart - entry.startTime),
    protocol: entry.nextHopProtocol || 'unknown',
    reused: entry.connectStart === entry.connectEnd,
  };
}

/** Submit → React message commit on one monotonic clock. The first terminal result is immutable. */
export class FirstTokenObservation {
  readonly startedAt = performance.now();
  private timer: ReturnType<typeof setTimeout>;
  private outcome: ReportFirstTokenRequest['outcome'] | null = null;
  private visibleMs: number | null = null;
  private dispatchedMs: number | null = null;
  private receivedMs: number | null = null;
  private receivedFromStream = false;
  private backgrounded = document.visibilityState !== 'visible';
  private reason: ReportFirstTokenRequest['reason'] = null;
  private reported = false;
  private engineeringOutcome: 'rejected' | undefined;
  private triggerMs: number | undefined;
  private finishedMs: number | null = null;
  private requestUrl: string | null = null;
  private connectionProven = false;
  private startReceivedMs: number | null = null;
  private serverElapsedMs: number | null = null;
  private lateVisibleMs: number | null = null;
  private networkReported = false;
  private timingEntry: PerformanceResourceTiming | null = null;
  private timingObserver: PerformanceObserver | null = null;
  private timingRelease: ReturnType<typeof setTimeout> | undefined;
  private visibility = () => {
    if (document.visibilityState !== 'visible') {
      this.backgrounded = true;
      this.unavailable('page_left');
    }
  };
  private pagehide = () => this.unavailable('page_left');

  constructor(
    public identity: FirstTokenIdentity,
    public deadlineMs: number,
    private readonly report: (body: ReportFirstTokenRequest) => void,
    private readonly onTimeout: () => void,
    /** 这一轮的思考过程算不算首字；服务端 start 说要显示时会被置为 true */
    public thinkingEnabled = true,
    private readonly action: 'send' | 'regenerate' = 'send',
    private requestedModel = 'unknown'
  ) {
    try {
      recordEngineeringEvent('roleplay.started', this.attributes('waiting'));
    } catch {
      // The engineering mirror never owns delivery or its business receipt.
    }
    this.timer = setTimeout(() => this.expire(), deadlineMs);
    document.addEventListener('visibilitychange', this.visibility);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.pagehide);
    if (this.backgrounded) this.unavailable('page_left');
  }

  identify(
    assistantMessageId: string,
    revision: number,
    deadlineMs?: number,
    requestedModelId?: string,
    triggerMs?: number
  ): void {
    // One request owns one server revision; late or duplicate start events cannot retarget it.
    if (this.identity.assistantMessageId !== null) return;
    this.identity = { ...this.identity, assistantMessageId, revision };
    if (typeof requestedModelId === 'string') this.requestedModel = requestedModelId;
    if (
      typeof triggerMs === 'number' &&
      Number.isInteger(triggerMs) &&
      triggerMs > 0 &&
      triggerMs <= 110000
    )
      this.triggerMs = triggerMs;
    // A cached catalog can predate an operator change. Keep the original click clock.
    if (!this.outcome && Number.isFinite(deadlineMs) && deadlineMs! > 0 && deadlineMs! <= 110000) {
      this.deadlineMs = deadlineMs!;
      clearTimeout(this.timer);
      const remaining = this.deadlineMs - (performance.now() - this.startedAt);
      if (remaining <= 0) this.expire();
      else this.timer = setTimeout(() => this.expire(), remaining);
    }
    this.flush();
  }
  dispatched(url?: string, connectionAgeMs: number | null = null): void {
    this.requestUrl ??= url ?? null;
    this.connectionProven =
      connectionAgeMs !== null && connectionAgeMs < CONNECTION_PROOF_MAX_AGE_MS;
    if (this.requestUrl && !this.timingObserver) this.watchRequestTiming();
    if (this.outcome) return;
    this.dispatchedMs ??= performance.now() - this.startedAt;
  }
  /**
   * The page-wide resource buffer stops recording after 250 entries, which a long chat session
   * with avatars and covers fills early. An observer still receives this request's entry.
   */
  private watchRequestTiming(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const observer = new PerformanceObserver((list) => this.acceptTiming(list.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
      this.timingObserver = observer;
      this.timingRelease = setTimeout(() => this.releaseTimingObserver(), TIMING_OBSERVER_MAX_MS);
    } catch {
      // Optional WebView reader; the buffer lookup below still runs.
    }
  }
  private acceptTiming(entries: PerformanceEntryList): void {
    const url = this.requestUrl;
    if (!url) return;
    for (const entry of entries)
      if (isRequestEntry(entry, url, this.startedAt))
        this.timingEntry = entry as PerformanceResourceTiming;
  }
  private releaseTimingObserver(): void {
    clearTimeout(this.timingRelease);
    const observer = this.timingObserver;
    if (!observer) return;
    try {
      this.acceptTiming(observer.takeRecords());
      observer.disconnect();
    } catch {
      // Losing the entry only leaves the attribution unknown.
    }
  }
  /** Recorded even after the deadline: a late start still separates network from server time. */
  started(serverElapsedMs?: number): void {
    if (this.startReceivedMs !== null) return;
    this.startReceivedMs = performance.now() - this.startedAt;
    if (typeof serverElapsedMs === 'number' && Number.isFinite(serverElapsedMs))
      this.serverElapsedMs = serverElapsedMs;
  }
  received(source: 'stream' | 'commit' = 'stream'): void {
    if (this.outcome) return;
    if (this.receivedMs === null) this.receivedFromStream = source === 'stream';
    this.receivedMs ??= performance.now() - this.startedAt;
  }
  get hasReceivedToken(): boolean {
    return this.receivedMs !== null;
  }
  committed(identity: FirstTokenIdentity, at: number): boolean {
    if (
      !identity.assistantMessageId ||
      identity.requestId !== this.identity.requestId ||
      identity.assistantMessageId !== this.identity.assistantMessageId ||
      identity.revision !== this.identity.revision
    )
      return false;
    const duration = at - this.startedAt;
    if (this.outcome) {
      this.noteLateCommit(duration);
      return false;
    }
    if (document.visibilityState !== 'visible') {
      this.unavailable('page_left');
      return false;
    }
    // Timers may be delayed by a busy main thread. A late commit must not win that race.
    if (duration >= this.deadlineMs) {
      this.expire();
      this.noteLateCommit(duration);
      return false;
    }
    this.outcome = 'observed';
    this.visibleMs = duration;
    this.finishedMs = duration;
    this.finish();
    return true;
  }
  /** The terminal stays timed_out; this keeps how long the user really waited. */
  private noteLateCommit(duration: number): void {
    if (this.outcome !== 'timed_out' || this.lateVisibleMs !== null) return;
    this.lateVisibleMs = duration;
    try {
      recordEngineeringMeasurement(
        'roleplay.first_token_late',
        duration,
        this.attributes('timed_out')
      );
    } catch {
      // The engineering mirror never owns delivery or its business receipt.
    }
  }
  /** Resource timing only exists once the response has ended, so this runs after the turn. */
  reportNetwork(): void {
    if (this.networkReported) return;
    this.networkReported = true;
    const known =
      this.outcome === 'observed' ||
      this.outcome === 'timed_out' ||
      SERVER_TIMEOUT_REASONS.has(this.reason);
    this.releaseTimingObserver();
    if (!known || !this.outcome) return;
    try {
      const buffered = this.requestUrl
        ? bufferedRequestEntry(this.requestUrl, this.startedAt)
        : null;
      const entry = this.timingEntry ?? buffered;
      const timing = requestTiming(entry);
      // Says why attribution lacks evidence: a full page buffer (observer only), a missing
      // Timing-Allow-Origin (limited), or no entry at all for this stream.
      const networkStatus = !this.requestUrl
        ? 'unknown'
        : timing
          ? 'available'
          : entry
            ? 'limited'
            : typeof PerformanceObserver === 'undefined' &&
                typeof performance.getEntriesByName !== 'function'
              ? 'unsupported'
              : 'no_entry';
      const overheadMs =
        this.startReceivedMs !== null && this.serverElapsedMs !== null
          ? Math.max(0, this.startReceivedMs - this.serverElapsedMs)
          : null;
      const pathMs =
        overheadMs !== null && timing ? Math.max(0, overheadMs - timing.setupMs) : null;
      // Transit is only the user's when the connection is known to have worked: a stall on a
      // silently dead socket looks identical, and that one we can fix.
      const provenPathMs = timing && (!timing.reused || this.connectionProven) ? pathMs : null;
      const attributes = {
        ...this.attributes(this.outcome),
        protocol: timing?.protocol ?? 'unknown',
        conn_reused: timing ? String(timing.reused) : 'unknown',
        conn_proven: String(this.connectionProven),
        network_status: networkStatus,
        rt_buffer: buffered ? 'hit' : 'miss',
        delay_attribution: attributeFirstTokenDelay({
          waitMs: this.visibleMs ?? this.lateVisibleMs,
          deadlineMs: this.deadlineMs,
          pathMs: provenPathMs,
        }),
      };
      const stages = [
        ['network_overhead', overheadMs],
        ['network_setup', timing?.setupMs ?? null],
        ['network_path', pathMs],
      ] as const;
      for (const [stage, value] of stages)
        if (value !== null)
          recordEngineeringMeasurement('roleplay.network', value, { ...attributes, stage });
      recordEngineeringEvent('roleplay.delay', attributes);
    } catch {
      // Attribution is diagnostic; losing it must never touch the conversation.
    }
  }
  deadlineFailed(
    reason: 'server_timeout' | 'fallback_timeout' | 'primary_timeout' = 'server_timeout'
  ): void {
    if (this.outcome) return;
    // A provider-stage failure may arrive before the user's total deadline. Keep it distinct.
    this.outcome =
      performance.now() - this.startedAt >= this.deadlineMs ? 'timed_out' : 'not_observed';
    this.reason = reason;
    this.finish();
  }
  private expire(): void {
    if (this.outcome) return;
    if (this.backgrounded || document.visibilityState !== 'visible') {
      this.backgrounded = true;
      this.unavailable('page_left');
      return;
    }
    this.outcome = 'timed_out';
    // Keep the legacy wire reason; v4 means no message commit by the deadline.
    this.reason = 'not_visible';
    this.finish();
    this.onTimeout();
  }
  unavailable(reason: ReportFirstTokenRequest['reason'], engineeringOutcome?: 'rejected'): void {
    if (!this.outcome) {
      this.outcome = 'not_observed';
      this.engineeringOutcome = engineeringOutcome;
      if (reason === 'page_left') this.backgrounded = true;
      this.reason = reason;
      this.finish();
    }
  }
  private finish(): void {
    this.finishedMs ??= performance.now() - this.startedAt;
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.visibility);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.pagehide);
    // Mirror the same immutable terminal outcome, including pre-identity failures.
    // Business receipt recovery remains independent and identity is never exported.
    try {
      let outcome =
        this.outcome === 'observed'
          ? 'observed'
          : this.outcome === 'timed_out'
            ? 'timed_out'
            : this.reason === 'page_left' && document.visibilityState !== 'visible'
              ? 'background'
              : (this.reason ?? 'not_observed');
      if (this.engineeringOutcome) outcome = this.engineeringOutcome;
      const attributes = this.attributes(outcome);
      recordEngineeringMeasurement('roleplay.first_token', this.finishedMs, attributes);
      recordEngineeringEvent('roleplay.terminal', attributes);
      // A recovered DB snapshot has no known network-reception timestamp. Do not
      // turn the commit-time fallback in the legacy receipt into a fake 0ms render.
      if (
        this.outcome === 'observed' &&
        this.receivedFromStream &&
        this.visibleMs !== null &&
        this.receivedMs !== null &&
        this.visibleMs >= this.receivedMs
      ) {
        recordEngineeringMeasurement('roleplay.render', this.visibleMs - this.receivedMs, {
          ...attributes,
          stage: 'render',
        });
      }
    } catch {
      // A disabled/unavailable exporter cannot suppress the original v4 receipt.
    }
    this.flush();
  }
  private attributes(outcome: string) {
    return {
      route: '/chat/:id',
      stage: 'first_token',
      action: this.action,
      outcome,
      requested_model: this.requestedModel,
      deadline_ms: this.deadlineMs,
      trigger_ms: this.triggerMs,
      source_measurement_version: 'client_committed_v4',
      first_token_stage:
        this.outcome === 'observed'
          ? 'committed'
          : this.receivedMs !== null
            ? 'awaiting_commit'
            : this.identity.assistantMessageId !== null
              ? 'awaiting_token'
              : 'awaiting_start',
    };
  }
  private flush(): void {
    if (!this.outcome || this.reported) return;
    this.reported = true;
    this.report({
      request_id: this.identity.requestId,
      assistant_message_id: this.identity.assistantMessageId,
      revision: this.identity.assistantMessageId === null ? null : this.identity.revision,
      measurement_method: 'client_committed_v4',
      wait_finished_ms: this.finishedMs,
      outcome: this.outcome,
      first_token_visible_ms: this.visibleMs,
      request_dispatched_ms: this.dispatchedMs,
      first_token_received_ms: this.receivedMs,
      backgrounded: this.backgrounded,
      reason: this.reason,
    });
  }
}
