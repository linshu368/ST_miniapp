/**
 * 右侧面板（状态栏 / 记忆栏）质量漏斗的工程计数，经 engineering-observability 的 OTLP 通道进 Cloud Metrics。
 * 新增标签要同时加进采集器白名单 ops/observability/config.alloy，否则进 Grafana 时会被删掉。
 */
import { boundedLabel } from './engineering-telemetry-exporter.js';
import { countEngineering } from './engineering-observability.js';

export type PanelName = 'status' | 'memory';
export type PanelTrigger = 'auto' | 'manual';
/** 一次尝试停在哪层：model 没拿到完整输出；format 认不出；content 内容没全过；ok 全过。 */
export type PanelAttemptStage = 'model' | 'format' | 'content' | 'ok';

/** 每次调状态/记忆模型一条（首发、兜底分开）。 */
export function observePanelAttempt(input: {
  panel: PanelName;
  channel: 'primary' | 'fallback';
  trigger: PanelTrigger;
  stage: PanelAttemptStage;
  /** content/format 层的主因，如 missing、record_too_long；其余为 none */
  problem: string;
  /** model 层的错误码，如 first_token_timeout、incomplete、http_429；其余为 none */
  errorCode: string;
}) {
  countEngineering('st_panel_attempts', {
    panel: input.panel,
    channel: input.channel,
    trigger: input.trigger,
    stage: input.stage,
    problem: boundedLabel('panel_problem', input.problem, 24),
    error_code: boundedLabel('panel_error_code', input.errorCode, 32),
  });
}

/**
 * 每次更新/检查一条。stage 是这次"掉在哪"，按优先级只归一个原因，各 stage 占比相加为 100%：
 * 状态栏 model > format > store > content（有项沿用）> display（有项显示错位）> ok；
 * 记忆栏 model > format > content > store > ok（no_progress、conflict 也记 ok 层，由 result 区分）。
 */
export function observePanelUpdate(input: {
  panel: PanelName;
  trigger: PanelTrigger;
  result: string;
  stage: string;
  /** 最终采用的通道；没有可用尝试时为 none */
  channel: string;
}) {
  countEngineering('st_panel_updates', {
    panel: input.panel,
    trigger: input.trigger,
    result: boundedLabel('panel_result', input.result, 8),
    stage: boundedLabel('panel_stage', input.stage, 8),
    channel: boundedLabel('panel_channel', input.channel, 4),
  });
}

/** 状态栏逐项的最终显示结果，按 样式 × 结果 计数（一次更新一批）。 */
export function observeStatusItems(input: {
  trigger: PanelTrigger;
  items: ReadonlyArray<{ style: string; result: string }>;
}) {
  const counts = new Map<string, { style: string; result: string; n: number }>();
  for (const item of input.items) {
    const key = `${item.style}|${item.result}`;
    const entry = counts.get(key) ?? { style: item.style, result: item.result, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  for (const { style, result, n } of counts.values())
    countEngineering(
      'st_status_items',
      {
        trigger: input.trigger,
        style: boundedLabel('status_item_style', style, 12),
        result: boundedLabel('status_item_result', result, 6),
      },
      n
    );
}

/**
 * 回复成功后自动更新的判断结果（只统计自动触发，手动更新是玩家主动点的）：
 * - not_due：还不到时候（状态栏不满 3 轮；记忆栏不是 3 的整数倍）
 * - not_applicable：不适用（卡上没有状态栏 / 玩家隐藏了记忆栏 / 会话已删）
 * - started：已发起，跑到了模型调用
 * - busy：该更新，但同一会话还有一次在跑，这次被跳过
 * - aborted：该更新，但在调模型之前就出错退出（读库失败、运营没配记忆栏提示词等）
 * - check_failed：判断要不要更新时读库就失败了，不知道该不该更新
 * 进程重启丢失 = started − 有结果的自动更新（st_panel_updates trigger=auto），在看板上算。
 */
export type PanelTriggerOutcome =
  | 'not_due'
  | 'not_applicable'
  | 'started'
  | 'busy'
  | 'aborted'
  | 'check_failed';

export function observePanelTrigger(input: { panel: PanelName; outcome: PanelTriggerOutcome }) {
  // 两个标签都已在采集器白名单里（panel、outcome）
  countEngineering('st_panel_triggers', { panel: input.panel, outcome: input.outcome });
}
