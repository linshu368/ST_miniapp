'use client';

import * as Sentry from '@sentry/nextjs';

import { createLogger } from '@/lib/logger';

import { getMetricDimensions, getNetworkTags } from './env-tags';
import { recordEngineeringEvent, recordEngineeringMeasurement } from './grafana';

const log = createLogger('perf');

/** 初值（PRD 决策 2026-10-21）：点击后 2.5 秒界面仍无反应，记为 action_stall。 */
export const ACTION_STALL_MS = 2_500;

/**
 * 只给会触发请求的关键动作埋点（design §3.3），不做全局按钮自动采集：
 * 纯前端交互本来就瞬时，全量采集只会把噪声灌进看板。
 */
export type TrackedAction =
  | 'select_character'
  | 'send_message'
  | 'recharge_create_order'
  | 'vip_create_order'
  | 'daily_checkin'
  | 'support_send_message'
  | 'image_generate'
  | 'video_generate'
  | 'voice_generate'
  | 'create_conversation';

export interface ActionHandle {
  /** 界面给出反馈（路由切换完成 / 控件进入处理中状态）时调用。幂等。 */
  feedback: () => void;
  /** 该次动作已作废：停止看门狗，也不记耗时。 */
  discard: () => void;
}

const pending = new Map<TrackedAction, ActionHandle>();

const roleplayActions = new Set<TrackedAction>([
  'select_character',
  'send_message',
  'create_conversation',
  'image_generate',
  'voice_generate',
]);

function mirrorAction(
  action: ActiveAction,
  outcome: 'waiting' | 'stalled' | 'feedback' | 'discarded',
  durationMs?: number
): void {
  if (!roleplayActions.has(action.name)) return;
  try {
    const attributes = {
      route: '/chat/:id',
      action: action.name,
      stage: 'feedback',
      outcome,
      source_measurement_version: 'action_foreground_v1',
    };
    recordEngineeringEvent('roleplay.action', attributes);
    if (durationMs !== undefined) {
      recordEngineeringMeasurement('roleplay.action', durationMs, attributes);
    }
  } catch {
    // The mirror must not affect the original watchdog or its Sentry evidence.
  }
}

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

/**
 * 切后台期间的等待不算用户体感卡顿：Android TG WebView 切后台会冻结网络/定时器，
 * 一批毫不相关的请求会在回到前台时同时"解冻"（已在生产 trace 中证实），
 * 这段时间不计入看门狗阈值，也不计入 action.feedback.duration，否则会把系统冻结误记成卡顿。
 * 与 page-tracker.ts 的 bindVisibility/hiddenMs 是同一套口径。
 */
interface ActiveAction {
  name: TrackedAction;
  startedAt: number;
  hiddenMs: number;
  hiddenSince: number | null;
  settled: boolean;
  stalled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const active = new Set<ActiveAction>();
let visibilityBound = false;

function elapsed(action: ActiveAction, now: number): number {
  const hidden = action.hiddenMs + (action.hiddenSince !== null ? now - action.hiddenSince : 0);
  return Math.max(0, now - action.startedAt - hidden);
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    const now = performance.now();
    if (document.visibilityState === 'hidden') {
      for (const action of active) {
        action.hiddenSince = now;
        if (action.timer) {
          clearTimeout(action.timer);
          action.timer = null;
        }
      }
    } else {
      for (const action of active) {
        if (action.hiddenSince === null) continue;
        action.hiddenMs += now - action.hiddenSince;
        action.hiddenSince = null;
        if (!action.settled) armStallTimer(action);
      }
    }
  });
}

function armStallTimer(action: ActiveAction): void {
  const remaining = Math.max(0, ACTION_STALL_MS - elapsed(action, performance.now()));
  action.timer = setTimeout(() => raiseStall(action), remaining);
}

function raiseStall(action: ActiveAction): void {
  const firstStall = !action.stalled;
  action.stalled = true;
  if (firstStall) mirrorAction(action, 'stalled');
  safely('action_stall', () => {
    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setFingerprint(['action_stall', action.name]);
      scope.setTags({ perf_event: 'action_stall', action: action.name, ...getNetworkTags() });
      scope.setContext('action_stall', {
        waitedMs: Math.round(elapsed(action, performance.now())),
      });
      Sentry.captureMessage('action_stall');
    });
  });
}

export function startAction(name: TrackedAction): ActionHandle {
  bindVisibility();
  const now = performance.now();
  const action: ActiveAction = {
    name,
    startedAt: now,
    hiddenMs: 0,
    hiddenSince: typeof document !== 'undefined' && document.hidden ? now : null,
    settled: false,
    stalled: false,
    timer: null,
  };
  active.add(action);
  mirrorAction(action, 'waiting');
  if (!action.hiddenSince) {
    action.timer = setTimeout(() => raiseStall(action), ACTION_STALL_MS);
  }

  const handle: ActionHandle = {
    feedback: () => {
      if (action.settled) return;
      action.settled = true;
      if (action.timer) clearTimeout(action.timer);
      active.delete(action);
      if (pending.get(name) === handle) pending.delete(name);
      mirrorAction(action, 'feedback', elapsed(action, performance.now()));
      safely('action_feedback', () => {
        // 即使已经判定过卡住，迟到的反馈也要记录，用来看实际等了多久；后台时长已排除在外。
        Sentry.metrics.distribution(
          'action.feedback.duration',
          elapsed(action, performance.now()),
          {
            unit: 'millisecond',
            attributes: { action: name, stalled: String(action.stalled), ...getMetricDimensions() },
          }
        );
      });
    },
    discard: () => {
      if (action.settled) return;
      action.settled = true;
      if (action.timer) clearTimeout(action.timer);
      active.delete(action);
      if (pending.get(name) === handle) pending.delete(name);
      mirrorAction(action, 'discarded');
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

/** 动作已失败/被取消：停止看门狗，也不记耗时。 */
export function discardPendingAction(name: TrackedAction): void {
  pending.get(name)?.discard();
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
