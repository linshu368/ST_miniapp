import type { ReportFirstTokenRequest } from '@miniapp/shared';
import { recordEngineeringEvent, recordEngineeringMeasurement } from './grafana';

export interface FirstTokenIdentity {
  requestId: string;
  assistantMessageId: string | null;
  revision: number;
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
    readonly thinkingEnabled = true,
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
  dispatched(): void {
    if (this.outcome) return;
    this.dispatchedMs ??= performance.now() - this.startedAt;
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
      this.outcome ||
      !identity.assistantMessageId ||
      identity.requestId !== this.identity.requestId ||
      identity.assistantMessageId !== this.identity.assistantMessageId ||
      identity.revision !== this.identity.revision
    )
      return false;
    if (document.visibilityState !== 'visible') {
      this.unavailable('page_left');
      return false;
    }
    // Timers may be delayed by a busy main thread. A late commit must not win that race.
    const duration = at - this.startedAt;
    if (duration >= this.deadlineMs) {
      this.expire();
      return false;
    }
    this.outcome = 'observed';
    this.visibleMs = duration;
    this.finishedMs = duration;
    this.finish();
    return true;
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
