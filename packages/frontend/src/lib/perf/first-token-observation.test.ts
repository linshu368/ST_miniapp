import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstTokenObservation } from './first-token-observation';

const engineering = vi.hoisted(() => ({ measurement: vi.fn(), event: vi.fn() }));
vi.mock('./grafana', () => ({
  recordEngineeringMeasurement: engineering.measurement,
  recordEngineeringEvent: engineering.event,
}));

const identity = { requestId: 'r', assistantMessageId: 'a', revision: 0 };
let page: EventTarget & { visibilityState: string };
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', page);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('client-committed first token observation', () => {
  it('mirrors pre-start timeouts once without waiting for business identity or exporting it', async () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(
      { requestId: 'private-request', assistantMessageId: null, revision: 0 },
      6000,
      report,
      vi.fn(),
      true,
      'regenerate'
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        assistant_message_id: null,
        revision: null,
        outcome: 'timed_out',
        wait_finished_ms: 6000,
      })
    );
    expect(engineering.measurement).toHaveBeenCalledExactlyOnceWith(
      'roleplay.first_token',
      6000,
      expect.objectContaining({
        action: 'regenerate',
        outcome: 'timed_out',
        source_measurement_version: 'client_committed_v4',
      })
    );
    expect(engineering.event).toHaveBeenCalledTimes(2);
    obs.identify('private-assistant', 2);
    expect(report).toHaveBeenCalledOnce();
    expect(engineering.event).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(engineering.event.mock.calls)).not.toContain('private');
  });

  it('does not invent render latency for a recovered commit without stream reception', () => {
    const obs = new FirstTokenObservation(identity, 6000, vi.fn(), vi.fn());
    obs.received('commit');
    obs.committed(identity, performance.now());
    expect(engineering.measurement.mock.calls.map(([name]) => name)).toEqual([
      'roleplay.first_token',
    ]);
  });

  it('preserves the original receipt when the engineering mirror throws', () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(identity, 6000, report, vi.fn());
    engineering.measurement.mockImplementationOnce(() => {
      throw new Error('collector unavailable');
    });
    expect(obs.committed(identity, performance.now())).toBe(true);
    expect(report).toHaveBeenCalledOnce();
  });

  it('uses the server-frozen six-second budget on the original clock despite a cached ten-second catalog', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(
      { ...identity, assistantMessageId: null },
      10000,
      report,
      timeout
    );
    await vi.advanceTimersByTimeAsync(2000);
    obs.identify('a', 0, 6000);
    await vi.advanceTimersByTimeAsync(3999);
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(timeout).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'timed_out', wait_finished_ms: 6000 })
    );
    expect(engineering.measurement).toHaveBeenCalledExactlyOnceWith(
      'roleplay.first_token',
      6000,
      expect.objectContaining({ outcome: 'timed_out' })
    );
  });
  it('immediately expires a late identity without giving it another six seconds', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(
      { ...identity, assistantMessageId: null },
      10000,
      report,
      timeout
    );
    await vi.advanceTimersByTimeAsync(7000);
    obs.identify('a', 0, 6000);
    expect(timeout).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'timed_out',
        wait_finished_ms: 7000,
        assistant_message_id: 'a',
      })
    );
  });
  it('records early departure by request ID before an identity exists', async () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(
      { ...identity, assistantMessageId: null },
      6000,
      report,
      vi.fn()
    );
    await vi.advanceTimersByTimeAsync(770);
    obs.unavailable('page_left');
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        assistant_message_id: null,
        revision: null,
        outcome: 'not_observed',
        reason: 'page_left',
        backgrounded: true,
        wait_finished_ms: 770,
      })
    );
    obs.identify('a', 0, 6000);
    expect(report).toHaveBeenCalledOnce();
  });
  it('uses submit-to-commit timing, independently of token reception and stream completion', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(identity, 6000, report, timeout);
    await vi.advanceTimersByTimeAsync(25);
    obs.dispatched();
    await vi.advanceTimersByTimeAsync(4000);
    obs.received();
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(obs.committed(identity, performance.now())).toBe(true);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'observed',
        first_token_visible_ms: 5225,
        first_token_received_ms: 4025,
        request_dispatched_ms: 25,
        revision: 0,
      })
    );
    expect(engineering.measurement).toHaveBeenCalledWith(
      'roleplay.render',
      1200,
      expect.objectContaining({ stage: 'render', outcome: 'observed' })
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(timeout).not.toHaveBeenCalled();
  });
  it('received text does not stop the deadline; a late commit cannot replace a timeout', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, timeout);
    await vi.advanceTimersByTimeAsync(2000);
    obs.received();
    await vi.advanceTimersByTimeAsync(18000);
    expect(timeout).toHaveBeenCalledOnce();
    expect(obs.committed(identity, performance.now())).toBe(false);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'timed_out',
        wait_finished_ms: 10000,
        first_token_visible_ms: null,
        first_token_received_ms: 2000,
      })
    );
  });
  it('checks the absolute deadline when the timer is delayed by the main thread', () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, timeout);
    vi.spyOn(performance, 'now').mockReturnValue(obs.startedAt + 10000);
    expect(obs.committed(identity, performance.now())).toBe(false);
    expect(timeout).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'timed_out',
      wait_finished_ms: 10000,
      first_token_visible_ms: null,
    });
    vi.restoreAllMocks();
  });
  it('background across the deadline never triggers cancellation or a fake timeout', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, timeout);
    await vi.advanceTimersByTimeAsync(1000);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(timeout).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'not_observed', reason: 'page_left', backgrounded: true })
    );
    page.visibilityState = 'visible';
    obs.received();
    expect(obs.committed(identity, performance.now())).toBe(false);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'not_observed',
      reason: 'page_left',
      wait_finished_ms: 1000,
      first_token_visible_ms: null,
      first_token_received_ms: null,
    });
  });
  it('reports a pre-start timeout by request ID without waiting for an SSE identity', async () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(
      { ...identity, assistantMessageId: null },
      6000,
      report,
      vi.fn()
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    obs.identify('discovered', 2);
    obs.identify('discovered', 2);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      assistant_message_id: null,
      revision: null,
      outcome: 'timed_out',
      wait_finished_ms: 6000,
    });
  });
  it('rejects mismatched requests and revisions without ending the observation', () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, vi.fn());
    expect(obs.committed({ ...identity, requestId: 'another' }, performance.now())).toBe(false);
    expect(obs.committed({ ...identity, assistantMessageId: 'another' }, performance.now())).toBe(
      false
    );
    expect(obs.committed({ ...identity, revision: 1 }, performance.now())).toBe(false);
    expect(report).not.toHaveBeenCalled();
    expect(obs.committed(identity, performance.now())).toBe(true);
    expect(obs.committed(identity, performance.now())).toBe(false);
    expect(report).toHaveBeenCalledOnce();
  });
  it('classifies an initially hidden page separately and never reports it as a foreground success', () => {
    page.visibilityState = 'hidden';
    const report = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, vi.fn());
    page.visibilityState = 'visible';
    expect(obs.committed(identity, performance.now())).toBe(false);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'not_observed',
      reason: 'page_left',
      backgrounded: true,
    });
  });
  it.each(['cancelled', 'superseded', 'upstream_error'] as const)(
    'keeps the first %s terminal result and its diagnostic timestamps',
    async (reason) => {
      const report = vi.fn();
      const obs = new FirstTokenObservation(
        { ...identity, assistantMessageId: null },
        10000,
        report,
        vi.fn()
      );
      await vi.advanceTimersByTimeAsync(500);
      obs.unavailable(reason);
      await vi.advanceTimersByTimeAsync(1000);
      obs.received();
      obs.dispatched();
      obs.identify('a', 0);
      expect(obs.committed(identity, performance.now())).toBe(false);
      expect(report).toHaveBeenCalledOnce();
      expect(report.mock.calls[0]?.[0]).toMatchObject({
        outcome: 'not_observed',
        reason,
        wait_finished_ms: 500,
        first_token_received_ms: null,
        request_dispatched_ms: null,
      });
    }
  );
  it('leaves unavailable measurements null instead of inventing a zero', () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(identity, 6000, report, vi.fn());
    obs.unavailable('page_left');
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      outcome: 'not_observed',
      first_token_visible_ms: null,
      first_token_received_ms: null,
      request_dispatched_ms: null,
    });
  });
  it('records an early fallback timeout as a stage failure, not a full user-deadline timeout', async () => {
    const report = vi.fn(),
      cancel = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, cancel);
    await vi.advanceTimersByTimeAsync(7200);
    obs.deadlineFailed('fallback_timeout');
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'not_observed',
        reason: 'fallback_timeout',
        wait_finished_ms: 7200,
        measurement_method: 'client_committed_v4',
        first_token_visible_ms: null,
      })
    );
    expect(cancel).not.toHaveBeenCalled();
  });
  it('never overwrites already committed text with a later server error', async () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, vi.fn());
    await vi.advanceTimersByTimeAsync(2000);
    obs.committed(identity, performance.now());
    obs.deadlineFailed();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0].outcome).toBe('observed');
  });
});
