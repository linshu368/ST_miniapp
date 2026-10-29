import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleplayReplyTiming } from './roleplay-timing';

const engineering = vi.hoisted(() => ({ measurement: vi.fn(), event: vi.fn() }));
vi.mock('./grafana', () => ({
  recordEngineeringMeasurement: engineering.measurement,
  recordEngineeringEvent: engineering.event,
}));

let page: EventTarget & { visibilityState: string };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.clearAllMocks();
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', page);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('roleplay full-reply engineering mirror', () => {
  it('uses a monotonic clock for send/regenerate and keeps the first terminal immutable', async () => {
    const timing = new RoleplayReplyTiming('not-exported-request', 'regenerate');
    await vi.advanceTimersByTimeAsync(1200);
    vi.setSystemTime(new Date('2000-01-01'));
    timing.finish('complete');
    timing.finish('failed');
    expect(engineering.measurement).toHaveBeenCalledExactlyOnceWith(
      'roleplay.full_reply',
      1200,
      expect.objectContaining({ action: 'regenerate', outcome: 'complete' })
    );
    expect(engineering.event).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(engineering.event.mock.calls)).not.toContain('not-exported');
  });

  it('records recovery separately without treating disconnection as a completed failure', async () => {
    const timing = new RoleplayReplyTiming('r', 'send');
    await vi.advanceTimersByTimeAsync(1000);
    timing.recovering();
    timing.recovering();
    expect(engineering.measurement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    timing.finish('complete');
    expect(engineering.measurement).toHaveBeenCalledWith(
      'roleplay.full_reply',
      3000,
      expect.objectContaining({ outcome: 'complete' })
    );
    expect(engineering.measurement).toHaveBeenCalledWith(
      'roleplay.recovery',
      2000,
      expect.objectContaining({ stage: 'recovery', outcome: 'complete' })
    );
    expect(engineering.event).toHaveBeenCalledTimes(4);
  });

  it.each([
    'failed',
    'interrupted',
    'cancelled',
    'page_left',
    'superseded',
    'rejected',
    'timed_out',
  ] as const)('retains %s instead of reporting a success-only latency sample', (outcome) => {
    const timing = new RoleplayReplyTiming('r', 'send');
    timing.finish(outcome);
    expect(engineering.event).toHaveBeenLastCalledWith(
      'roleplay.terminal',
      expect.objectContaining({ stage: 'full_reply', outcome })
    );
  });

  it('ends foreground observation at background and cannot rewrite it after returning', async () => {
    const timing = new RoleplayReplyTiming('r', 'send');
    await vi.advanceTimersByTimeAsync(2000);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    page.visibilityState = 'visible';
    timing.finish('complete');
    expect(engineering.measurement).toHaveBeenCalledExactlyOnceWith(
      'roleplay.full_reply',
      2000,
      expect.objectContaining({ outcome: 'background' })
    );
  });

  it('contains exporter failures and never waits for a transport', () => {
    engineering.event.mockImplementationOnce(() => {
      throw new Error('offline');
    });
    const timing = new RoleplayReplyTiming('r', 'send');
    engineering.measurement.mockImplementationOnce(() => {
      throw new Error('offline');
    });
    expect(() => timing.finish('complete')).not.toThrow();
    expect(() => timing.finish('failed')).not.toThrow();
  });
});
