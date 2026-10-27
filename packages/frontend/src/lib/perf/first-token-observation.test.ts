import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstTokenObservation } from './first-token-observation';

const identity = { requestId: 'r', assistantMessageId: 'a', revision: 0 };
let page: EventTarget & { visibilityState: string };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', page);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('user-visible first token observation', () => {
  it('uses submit-to-display timing, independently of token reception and stream completion', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(identity, 6000, report, timeout);
    await vi.advanceTimersByTimeAsync(25);
    obs.dispatched();
    await vi.advanceTimersByTimeAsync(4000);
    obs.received();
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1200);
    expect(obs.displayed(identity, performance.now())).toBe(true);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'observed',
        first_token_visible_ms: 5225,
        first_token_received_ms: 4025,
        request_dispatched_ms: 25,
        revision: 0,
      })
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(timeout).not.toHaveBeenCalled();
  });
  it('does not time out received text outside the viewport; records its eventual real display', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(identity, 6000, report, timeout);
    await vi.advanceTimersByTimeAsync(2000);
    obs.received();
    await vi.advanceTimersByTimeAsync(18000);
    expect(timeout).not.toHaveBeenCalled();
    expect(obs.displayed(identity, performance.now())).toBe(true);
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'observed',
        first_token_visible_ms: 20000,
        first_token_received_ms: 2000,
      })
    );
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
    expect(obs.displayed(identity, performance.now())).toBe(true);
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'observed',
        backgrounded: true,
        first_token_visible_ms: 21000,
      })
    );
  });
  it('defers reporting until the exact revision is discovered after a pre-start timeout', async () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(
      { ...identity, assistantMessageId: null },
      6000,
      report,
      vi.fn()
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    obs.identify('discovered', 2);
    obs.identify('discovered', 2);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      assistant_message_id: 'discovered',
      revision: 2,
      outcome: 'timed_out',
      wait_finished_ms: 6000,
    });
  });
  it('does not count background or mismatched revisions as a visible token', async () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(identity, 6000, report, vi.fn());
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(obs.displayed(identity, performance.now())).toBe(false);
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(obs.displayed({ ...identity, revision: 1 }, performance.now())).toBe(false);
    expect(obs.displayed(identity, performance.now())).toBe(true);
    expect(report.mock.calls[0]?.[0].backgrounded).toBe(true);
  });
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
        measurement_method: 'visible_dom_after_frame_v3',
        first_token_visible_ms: null,
      })
    );
    expect(cancel).not.toHaveBeenCalled();
  });
  it('never overwrites already displayed text with a later server error', async () => {
    const report = vi.fn();
    const obs = new FirstTokenObservation(identity, 10000, report, vi.fn());
    await vi.advanceTimersByTimeAsync(2000);
    obs.displayed(identity, performance.now());
    obs.deadlineFailed();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0].outcome).toBe('observed');
  });
});
