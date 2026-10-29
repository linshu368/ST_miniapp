import { recordEngineeringEvent, recordEngineeringMeasurement } from './grafana';

export type RoleplayReplyOutcome =
  | 'complete'
  | 'failed'
  | 'interrupted'
  | 'rejected'
  | 'timed_out'
  | 'cancelled'
  | 'page_left'
  | 'background'
  | 'superseded';

/** Local delivery observation only; never changes a server-owned generation. */
export class RoleplayReplyTiming {
  private readonly startedAt = performance.now();
  private finished = false;
  private recoveryAt: number | undefined;
  private visibility = () => {
    if (document.visibilityState !== 'visible') this.finish('background');
  };

  constructor(
    readonly requestId: string,
    private readonly action: 'send' | 'regenerate'
  ) {
    this.safely(() =>
      recordEngineeringEvent('roleplay.started', this.attributes('full_reply', 'waiting'))
    );
    document.addEventListener('visibilitychange', this.visibility);
    if (document.visibilityState !== 'visible') this.finish('background');
  }

  /** Disconnection is not a failed generation: a later committed snapshot may recover it. */
  recovering(): void {
    if (this.finished || this.recoveryAt !== undefined) return;
    this.recoveryAt = performance.now();
    this.safely(() =>
      recordEngineeringEvent('roleplay.started', this.attributes('recovery', 'recovering'))
    );
  }

  finish(outcome: RoleplayReplyOutcome): void {
    if (this.finished) return;
    this.finished = true;
    document.removeEventListener('visibilitychange', this.visibility);
    const now = performance.now();
    this.safely(() => {
      const attributes = this.attributes('full_reply', outcome);
      recordEngineeringMeasurement('roleplay.full_reply', now - this.startedAt, attributes);
      recordEngineeringEvent('roleplay.terminal', attributes);
      if (this.recoveryAt !== undefined) {
        const recovery = this.attributes('recovery', outcome);
        recordEngineeringMeasurement('roleplay.recovery', now - this.recoveryAt, recovery);
        recordEngineeringEvent('roleplay.terminal', recovery);
      }
    });
  }

  private attributes(stage: 'full_reply' | 'recovery', outcome: string) {
    return {
      route: '/chat/:id',
      stage,
      action: this.action,
      outcome,
      source_measurement_version: 'client_committed_reply_v1',
    };
  }

  private safely(run: () => void): void {
    try {
      run();
    } catch {
      // No telemetry failure is allowed to affect the chat state machine.
    }
  }
}
