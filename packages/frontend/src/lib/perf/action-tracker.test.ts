import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { distribution, count, captureMessage, withScope } = vi.hoisted(() => ({
  distribution: vi.fn(),
  count: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) =>
    cb({ setLevel: vi.fn(), setFingerprint: vi.fn(), setTags: vi.fn(), setContext: vi.fn() })
  ),
}));
const engineering = vi.hoisted(() => ({ measurement: vi.fn(), event: vi.fn() }));
vi.mock('./grafana', () => ({
  recordEngineeringMeasurement: engineering.measurement,
  recordEngineeringEvent: engineering.event,
}));

vi.mock('@sentry/nextjs', () => ({
  metrics: { distribution, count },
  captureMessage,
  withScope,
}));
vi.mock('@telegram-apps/sdk-react', () => ({ retrieveLaunchParams: () => ({}) }));

// 前端测试跑在 node 环境（项目暂无 jsdom），这里只需要 visibility 相关的最小 document，
// 与 page-tracker.test.ts 的做法一致。
const fakeDocument = Object.assign(new EventTarget(), {
  visibilityState: 'visible' as 'visible' | 'hidden',
  hidden: false,
});
vi.stubGlobal('document', fakeDocument);

function setVisibility(state: 'visible' | 'hidden'): void {
  fakeDocument.visibilityState = state;
  fakeDocument.hidden = state === 'hidden';
  fakeDocument.dispatchEvent(new Event('visibilitychange'));
}

import {
  ACTION_STALL_MS,
  completePendingAction,
  discardPendingAction,
  feedbackAfterPaint,
  startAction,
  startPendingAction,
} from './action-tracker';

describe('action tracker', () => {
  beforeEach(() => {
    engineering.measurement.mockClear();
    engineering.event.mockClear();
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
    expect(engineering.event.mock.calls.map(([, attrs]) => attrs.outcome)).toEqual([
      'waiting',
      'feedback',
    ]);
    expect(engineering.measurement).toHaveBeenCalledWith(
      'roleplay.action',
      expect.any(Number),
      expect.objectContaining({ action: 'send_message', stage: 'feedback', outcome: 'feedback' })
    );
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
    expect(engineering.event.mock.calls.map(([, attrs]) => attrs.outcome)).toEqual([
      'waiting',
      'discarded',
      'waiting',
      'feedback',
    ]);
  });

  it('retains original feedback when the engineering mirror fails', () => {
    engineering.measurement.mockImplementationOnce(() => {
      throw new Error('collector unavailable');
    });
    const action = startAction('select_character');
    expect(() => action.feedback()).not.toThrow();
    expect(distribution).toHaveBeenCalledOnce();
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

describe('discardPendingAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    distribution.mockClear();
    captureMessage.mockClear();
  });

  it('stops the watchdog without recording a duration', () => {
    startPendingAction('create_conversation');
    vi.advanceTimersByTime(500);
    discardPendingAction('create_conversation');
    vi.advanceTimersByTime(ACTION_STALL_MS * 2);

    expect(captureMessage).not.toHaveBeenCalled();
    expect(distribution).not.toHaveBeenCalled();
  });
});

// 回归：Android TG WebView 切后台会冻结网络/定时器，生产 trace 已证实一批互不相关的请求
// 会在回到前台时同时"解冻"；这段时间不能被误记成 action_stall，也不能算进上报的耗时里。
describe('action tracker background handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    distribution.mockClear();
    captureMessage.mockClear();
    // 前面的 describe 块在 afterEach 里 unstubAllGlobals，这里必须重新接上 document 桩。
    engineering.event.mockClear();
    engineering.measurement.mockClear();
    vi.stubGlobal('document', fakeDocument);
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pauses the watchdog while the tab is hidden and resumes with remaining time after returning', () => {
    const action = startAction('select_character');
    vi.advanceTimersByTime(1000);
    setVisibility('hidden');
    // 后台停留远超过原阈值，watchdog 不应该在后台触发。
    vi.advanceTimersByTime(ACTION_STALL_MS * 5);
    expect(captureMessage).not.toHaveBeenCalled();

    setVisibility('visible');
    // 前台已用掉 1000ms，恢复后还差 ACTION_STALL_MS - 1000 才会触发。
    vi.advanceTimersByTime(ACTION_STALL_MS - 1000 - 1);
    expect(captureMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(captureMessage).toHaveBeenCalledWith('action_stall');

    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(1);
    expect(
      engineering.event.mock.calls.filter(([, attrs]) => attrs.outcome === 'stalled')
    ).toHaveLength(1);

    action.feedback();
  });

  it('excludes background time from the reported feedback duration', () => {
    const action = startAction('send_message');
    vi.advanceTimersByTime(300);
    setVisibility('hidden');
    // 用户把 App 晾在后台很久，这段时间不该算进「卡了多久」。
    vi.advanceTimersByTime(20_000);
    setVisibility('visible');
    vi.advanceTimersByTime(200);
    action.feedback();

    expect(captureMessage).not.toHaveBeenCalled();
    expect(distribution).toHaveBeenCalledTimes(1);
    const [, durationMs, meta] = distribution.mock.calls[0]!;
    expect(durationMs).toBeLessThan(1000);
    expect(meta).toMatchObject({ attributes: { stalled: 'false' } });
  });

  it('does not report a stall for an action discarded while the tab is hidden', () => {
    const action = startAction('create_conversation');
    setVisibility('hidden');
    vi.advanceTimersByTime(ACTION_STALL_MS * 3);
    action.discard();
    setVisibility('visible');
    vi.advanceTimersByTime(ACTION_STALL_MS * 2);

    expect(captureMessage).not.toHaveBeenCalled();
    expect(distribution).not.toHaveBeenCalled();
  });
});
