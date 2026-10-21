'use client';

import * as Sentry from '@sentry/nextjs';

import { createLogger } from '@/lib/logger';

import { getMetricDimensions, getNetworkTags } from './env-tags';

const log = createLogger('perf');

/** 初值（PRD 决策 2026-10-21）：点击后 2.5 秒界面仍无反应，记为 action_stall。 */
export const ACTION_STALL_MS = 2_500;

/** 只给这几个核心动作埋点（design §3.3），不做全局按钮自动采集。 */
export type TrackedAction = 'select_character' | 'send_message' | 'recharge_create_order';

export interface ActionHandle {
  /** 界面给出反馈（路由切换完成 / 控件进入处理中状态）时调用。幂等。 */
  feedback: () => void;
  /** 该次动作已作废：停止看门狗，也不记耗时。 */
  discard: () => void;
}

const pending = new Map<TrackedAction, ActionHandle>();

function safely(stage: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    log.warn(`action tracker ${stage} failed`, error);
    try {
      Sentry.metrics.count('perf.instrument_error', 1, {
        attributes: { side: 'frontend', stage },
      });
    } catch {
      // 放弃。
    }
  }
}

export function startAction(name: TrackedAction): ActionHandle {
  const startedAt = performance.now();
  let settled = false;
  let stalled = false;

  const timer = setTimeout(() => {
    stalled = true;
    safely('action_stall', () => {
      Sentry.withScope((scope) => {
        scope.setLevel('warning');
        scope.setFingerprint(['action_stall', name]);
        scope.setTags({ perf_event: 'action_stall', action: name, ...getNetworkTags() });
        scope.setContext('action_stall', { waitedMs: Math.round(performance.now() - startedAt) });
        Sentry.captureMessage('action_stall');
      });
    });
  }, ACTION_STALL_MS);

  const handle: ActionHandle = {
    feedback: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending.get(name) === handle) pending.delete(name);
      safely('action_feedback', () => {
        // 即使已经判定过卡住，迟到的反馈也要记录，用来看实际等了多久。
        Sentry.metrics.distribution('action.feedback.duration', performance.now() - startedAt, {
          unit: 'millisecond',
          attributes: { action: name, stalled: String(stalled), ...getMetricDimensions() },
        });
      });
    },
    discard: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending.get(name) === handle) pending.delete(name);
    },
  };
  return handle;
}

/**
 * 反馈发生在另一个组件/路由里时用：发起方登记，目标方按名字完成。
 * 同名动作重复发起时以最新一次为准，旧的直接丢弃（不算卡住也不记耗时）。
 */
export function startPendingAction(name: TrackedAction): void {
  // 必须真正作废旧的那次，否则它的看门狗还会触发，把一次已被取代的点击误报成卡住。
  pending.get(name)?.discard();
  pending.set(name, startAction(name));
}

export function completePendingAction(name: TrackedAction): void {
  pending.get(name)?.feedback();
}

/** 状态更新后等浏览器真正绘制一帧再算「用户看到了反馈」。 */
export function feedbackAfterPaint(handle: ActionHandle): void {
  if (typeof requestAnimationFrame !== 'function') {
    handle.feedback();
    return;
  }
  requestAnimationFrame(() => setTimeout(handle.feedback, 0));
}
