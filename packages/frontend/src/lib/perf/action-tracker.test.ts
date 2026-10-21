import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { distribution, count, captureMessage, withScope } = vi.hoisted(() => ({
  distribution: vi.fn(),
  count: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setLevel: vi.fn(), setFingerprint: vi.fn(), setTags: vi.fn(), setContext: vi.fn() })
  ),
}));

vi.mock('@sentry/nextjs', () => ({
  metrics: { distribution, count },
  captureMessage,
  withScope,
}));
vi.mock('@telegram-apps/sdk-react', () => ({ retrieveLaunchParams: () => ({}) }));

import {
  ACTION_STALL_MS,
  completePendingAction,
  feedbackAfterPaint,
  startAction,
  startPendingAction,
} from './action-tracker';

describe('action tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    distribution.mockClear();
    captureMessage.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records feedback duration and stays silent when feedback arrives in time', () => {
    const action = startAction('send_message');
    vi.advanceTimersByTime(300);
    action.feedback();
    vi.advanceTimersByTime(ACTION_STALL_MS * 2);

    expect(captureMessage).not.toHaveBeenCalled();
    expect(distribution).toHaveBeenCalledTimes(1);
    expect(distribution.mock.calls[0]?.[2]).toMatchObject({
      attributes: { action: 'send_message', stalled: 'false' },
    });
  });

  it('raises action_stall once, and still records the late feedback', () => {
    const action = startAction('recharge_create_order');
    vi.advanceTimersByTime(ACTION_STALL_MS + 50);
    expect(captureMessage).toHaveBeenCalledWith('action_stall');

    action.feedback();
    action.feedback();
    expect(distribution).toHaveBeenCalledTimes(1);
    expect(distribution.mock.calls[0]?.[2]).toMatchObject({ attributes: { stalled: 'true' } });
  });

  it('completes a pending action started elsewhere', () => {
    startPendingAction('select_character');
    vi.advanceTimersByTime(500);
    completePendingAction('select_character');
    vi.advanceTimersByTime(ACTION_STALL_MS * 2);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(distribution).toHaveBeenCalledTimes(1);
  });

  it('drops a superseded pending action instead of reporting it as stalled', () => {
    startPendingAction('select_character');
    startPendingAction('select_character');
    completePendingAction('select_character');
    vi.advanceTimersByTime(ACTION_STALL_MS * 2);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('feedbackAfterPaint waits for a frame before counting feedback', () => {
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
    const action = startAction('send_message');
    feedbackAfterPaint(action);
    expect(distribution).not.toHaveBeenCalled();

    frames[0]?.();
    vi.advanceTimersByTime(1);
    expect(distribution).toHaveBeenCalledTimes(1);
  });
});
