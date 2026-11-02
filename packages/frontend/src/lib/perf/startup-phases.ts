'use client';

const PHASES = [
  'providers_loaded',
  'first_render',
  'init_start',
  'telegram_initialized',
  'bootstrap_finished',
] as const;
type StartupPhase = (typeof PHASES)[number];
let marks: Partial<Record<StartupPhase, number>> = {};

export const STARTUP_STAGE_NAMES = [
  'before_providers',
  'module_to_render',
  'render_to_init',
  'telegram_init',
  'bootstrap',
  'react_commit',
  'paint_wait',
  'ready_call',
  'document_ttfb',
  'document_download',
  'next_script_fetch_union',
  'last_script_to_providers',
] as const;
type StartupStage = (typeof STARTUP_STAGE_NAMES)[number];

export const STARTUP_DETAIL_FIELDS = [
  ...STARTUP_STAGE_NAMES,
  ...PHASES,
  'shell_committed',
  'shell_ready',
  'ready_call_end',
  'document_response_start',
  'document_response_end',
  'last_script_response_end',
  'script_count',
  'script_zero_transfer_count',
  'script_transfer_bytes',
  'script_max_fetch_ms',
  'resources_truncated',
] as const;

export function markStartupPhase(phase: StartupPhase): void {
  try {
    if (typeof window === 'undefined' || marks[phase] !== undefined) return;
    marks[phase] = performance.now();
  } catch {
    // 早期时间戳不能成为渲染或初始化的新依赖。
  }
}

export function collectStartupDetails(
  committedAt: number,
  shellAt: number,
  readyAt: number,
  observedAt = readyAt
) {
  const details: Partial<Record<(typeof STARTUP_DETAIL_FIELDS)[number], number>> = {};
  const stages: Partial<Record<StartupStage, number>> = {};
  const valid = (v: number | undefined): v is number =>
    v !== undefined && Number.isFinite(v) && v >= 0 && v <= observedAt;
  const duration = (stage: StartupStage, start: number | undefined, end: number | undefined) => {
    if (!valid(start) || !valid(end) || end < start) return;
    stages[stage] = end - start;
    details[stage] = end - start;
  };
  for (const phase of PHASES) {
    if (valid(marks[phase])) details[phase] = marks[phase];
  }
  details.shell_committed = committedAt;
  details.shell_ready = shellAt;
  details.ready_call_end = readyAt;
  duration('before_providers', 0, marks.providers_loaded);
  duration('module_to_render', marks.providers_loaded, marks.first_render);
  duration('render_to_init', marks.first_render, marks.init_start);
  duration('telegram_init', marks.init_start, marks.telegram_initialized);
  duration('bootstrap', marks.telegram_initialized, marks.bootstrap_finished);
  duration('react_commit', marks.bootstrap_finished, committedAt);
  duration('paint_wait', committedAt, shellAt);
  duration('ready_call', shellAt, readyAt);

  // HTML 流式返回、脚本并行下载会重叠；这些是解释性摘要，不能与上面的阶段相加。
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav && nav.responseStart > 0 && valid(nav.responseStart)) {
      details.document_response_start = nav.responseStart;
      duration('document_ttfb', 0, nav.responseStart);
      if (nav.responseEnd > 0 && valid(nav.responseEnd)) {
        details.document_response_end = nav.responseEnd;
        duration('document_download', nav.responseStart, nav.responseEnd);
      }
    }
  } catch {
    // 不支持 Navigation Timing 的 WebView 保留已知阶段，缺失不填 0。
  }
  try {
    const providersLoaded = marks.providers_loaded;
    if (!valid(providersLoaded)) return { stages, details };
    const entries = performance.getEntriesByType('resource');
    details.resources_truncated = entries.length > 128 ? 1 : 0;
    const scripts = (entries.slice(0, 128) as PerformanceResourceTiming[]).filter((entry) => {
      if (!valid(entry.startTime) || !valid(entry.responseEnd)) return false;
      if (entry.responseEnd <= 0 || entry.responseEnd < entry.startTime) return false;
      if (entry.responseEnd > providersLoaded) return false;
      const url = new URL(entry.name, window.location.origin);
      return (
        url.origin === window.location.origin && /^\/_next\/static\/.*\.js$/.test(url.pathname)
      );
    });
    details.script_count = scripts.length;
    if (scripts.length === 0) return { stages, details };
    scripts.sort((a, b) => a.startTime - b.startTime);
    let union = 0;
    let end = 0;
    let max = 0;
    let bytes = 0;
    let zeroTransfer = 0;
    for (const script of scripts) {
      union += Math.max(0, script.responseEnd - Math.max(end, script.startTime));
      end = Math.max(end, script.responseEnd);
      max = Math.max(max, script.responseEnd - script.startTime);
      if (Number.isFinite(script.transferSize) && script.transferSize >= 0) {
        bytes += script.transferSize;
        if (script.transferSize === 0 && script.decodedBodySize > 0) zeroTransfer += 1;
      }
    }
    details.next_script_fetch_union = union;
    stages.next_script_fetch_union = union;
    details.last_script_response_end = end;
    details.script_max_fetch_ms = max;
    details.script_transfer_bytes = bytes;
    details.script_zero_transfer_count = zeroTransfer;
    duration('last_script_to_providers', end, marks.providers_loaded);
  } catch {
    // 不导出资源 URL；Timing 不可用/异常只影响资源摘要。
  }
  return { stages, details };
}

export function resetStartupPhasesForTest(): void {
  marks = {};
}
