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
  it('times out even if a token was received before the deadline, but never displayed', async () => {
    const report = vi.fn(),
      timeout = vi.fn();
    const obs = new FirstTokenObservation(identity, 6000, report, timeout);
    await vi.advanceTimersByTimeAsync(5000);
    obs.received();
    await vi.advanceTimersByTimeAsync(1000);
    expect(timeout).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'timed_out', first_token_visible_ms: null })
    );
    expect(obs.displayed(identity, performance.now())).toBe(false);
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
    obs.identify('discovered', 2);
    obs.identify('discovered', 2);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toMatchObject({
      assistant_message_id: 'discovered',
      revision: 2,
      outcome: 'timed_out',
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
});
