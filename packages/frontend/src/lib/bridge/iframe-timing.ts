/**
 * [TEMP DEBUG — iframe-latency] 首屏加载相位计时器。
 *
 * 目的：把「点角色卡 → 对话呈现」这段（生产实测 ~11s）拆成可归因的相位，
 * 用 Date.now() 打点（父窗口与 ST iframe 同设备同一时钟，绝对毫秒可直接相减）。
 * 由于测试在手机 Telegram WebView（无法看 console），flush 时把打点 POST 给
 * 后端 /api/debug/iframe-timing，落到 Railway backend 日志，用 CLI 拉取分析。
 *
 * 相位锚点（绝对 ms）：
 *   bridge_start   — BridgeClient.start()（iframe 开始加载 /tavern）
 *   iframe_onload  — <iframe> load 事件（ST index + 同步资源到位）
 *   st_handshake   — 收到 phase='handshake'（ST DOMContentLoaded + 本扩展 init 完成）
 *   st_ready       — 收到 phase='ready'（ST APP_READY，闸门打开）
 *   page_mount     — 进入 /tavern/[id]（用户点卡）
 *   gate_open      — page effect 观察到 bridgeStatus==='ready'
 *   ensure_start/ensure_end   — ensureCharacter 单卡下发
 *   select_start/select_end   — selectCharacter postMessage 往返（ST 选角色+载入聊天）
 *   chat_ready     — setChatReady(true)（开屏退场，用户看到对话）
 *
 * 移除方式：删除本文件 + 各调用点 `markTiming(...)` / `flushIframeTiming(...)` +
 * 后端 routes/debug.ts。全部以 [iframe-timing] 标注，便于一次性清理。
 */

import { recordBridgeTelemetryMark } from '@/lib/sentry/bridge-telemetry';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://stminiapp-development.up.railway.app';

const marks = new Map<string, number>();
const details = new Map<string, string>();

export function markTiming(name: string, info?: string): void {
  marks.set(name, Date.now());
  if (info) details.set(name, info);
  recordBridgeTelemetryMark(name, info);
}

/** ST iframe 端打点（携带 ST 侧 Date.now()，同设备同一时钟，可直接与父窗口相减）。 */
export function markTimingAt(name: string, t: number, info?: string): void {
  marks.set(name, t);
  if (info) details.set(name, info);
  recordBridgeTelemetryMark(name, info);
}

/**
 * [iframe-timing] 只写 details 不写 marks：用于把「累计计数/结局」类信息挂到 beacon 的
 * details={...} 里，而不在 timeline 制造一个无意义的时间点（如自愈恢复累计计数 `recovery`）。
 */
export function setTimingDetail(name: string, info: string): void {
  details.set(name, info);
}

/** 页面级打点在每次进入对话页时重置，保留 bridge 生命周期打点（可能早于本次进入）。 */
export function resetPageTiming(): void {
  for (const k of [
    'page_mount',
    'gate_open',
    'ensure_start',
    'ensure_end',
    'select_start',
    'select_end',
    'select_error',
    // [iframe-timing] 失败路径遥测：停摆上报打点（每次进卡刷新）
    'gate_stall',
    'select_stall',
    'chat_ready',
    // [iframe-timing] round2: selectCharacter ST 端子相位（每次进卡刷新）
    'sel_start',
    'sel_reload_done',
    'sel_selectById_done',
    'sel_newchat_start',
    'sel_newchat_error',
    'sel_newchat_done',
  ]) {
    marks.delete(k);
    details.delete(k);
  }
  // [iframe-timing] round4: 点卡窗口探针数据（sel_wf_N/sel_evt/sel_longtask_N，N 不定长）按前缀清理
  // round5: stall_* 停摆诊断收割数据同样按前缀清理
  for (const k of [...marks.keys()]) {
    if (
      k.startsWith('sel_wf') ||
      k.startsWith('sel_longtask') ||
      k === 'sel_evt' ||
      k.startsWith('stall_')
    ) {
      marks.delete(k);
      details.delete(k);
    }
  }
}

/**
 * [iframe-timing] round5: 停摆诊断收割。gate_stall/select_stall 上报前调用，同源直读 ST iframe：
 * - __miniappFetchLog（vendor 探针）：fetch 生命周期，能区分「发出未归(PENDING)」与「从未发出」
 * - performance resource timing：已完成的资源请求（在途请求不生成条目，与 fetchLog 互补）
 * - document.readyState / URL / __miniappBootErrors（静默异常与未处理 rejection）
 * 结果写入 stall_* details，由后端按 [iframe-timing-wf] 独立成行（防主行截断）。
 */
export function harvestStIframeStallDiagnostics(): void {
  try {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="SillyTavern"]');
    const win = iframe?.contentWindow as
      | (Window & {
          __miniappFetchLog?: Array<{
            url: string;
            start: number;
            end: number;
            status: number;
            err: string;
          }>;
          __miniappBootErrors?: string[];
        })
      | null
      | undefined;
    if (!win) {
      markTimingAt('stall_doc', Date.now(), 'iframe unavailable');
      return;
    }

    const doc = iframe!.contentDocument;
    markTimingAt(
      'stall_doc',
      Date.now(),
      `readyState=${doc?.readyState ?? 'n/a'} url=${(win.location?.href ?? 'n/a').slice(-120)} ` +
        `errors=[${(win.__miniappBootErrors ?? []).join(' | ').slice(0, 600) || 'none'}]`
    );

    // fetch 生命周期（相对 iframe timeOrigin 的 ms 偏移）：url@start→end(status)；在途标 PENDING
    const fetchLog = win.__miniappFetchLog ?? [];
    const fetchStr =
      fetchLog
        .map((e) => {
          const tail = e.end < 0 ? 'PENDING' : `${e.end}(${e.err ? `err:${e.err}` : e.status})`;
          return `${e.url.replace(/^.*\/st-runtime\/[^/]+/, '~')}@${e.start}→${tail}`;
        })
        .join(' ') || '(probe absent or no fetch yet)';
    chunkIntoDetails('stall_fetchlog', fetchStr);

    // 已完成资源（截尾 25 条）：路径尾段@start+duration
    const resources = (win.performance?.getEntriesByType('resource') ??
      []) as PerformanceResourceTiming[];
    const resStr =
      `count=${resources.length} | ` +
      resources
        .slice(-25)
        .map(
          (r) =>
            `${r.name.replace(/^.*\/st-runtime\/[^/]+/, '~').replace(/^https?:\/\/[^/]+/, '')}@${Math.round(r.startTime)}+${Math.round(r.duration)}`
        )
        .join(' ');
    chunkIntoDetails('stall_resources', resStr);
  } catch (err) {
    markTimingAt('stall_doc', Date.now(), `harvest failed: ${String(err).slice(0, 120)}`);
  }
}

/** [iframe-timing] round5: 长字符串切块进 details（每块独立成行，避开 Railway 单行截断）。 */
function chunkIntoDetails(prefix: string, value: string): void {
  const CHUNK = 1500;
  let i = 0;
  for (let off = 0; off < value.length && i < 8; off += CHUNK) {
    i += 1;
    markTimingAt(`${prefix}_${i}`, Date.now(), value.slice(off, off + CHUNK));
  }
}

export function flushIframeTiming(meta: Record<string, unknown>): void {
  const snapshot: Record<string, number> = {};
  for (const [k, v] of marks) snapshot[k] = v;
  const detailSnapshot: Record<string, string> = {};
  for (const [k, v] of details) detailSnapshot[k] = v;

  const payload = { meta, marks: snapshot, details: detailSnapshot, ua: navigator.userAgent };

  try {
    // eslint-disable-next-line no-console
    console.log('[iframe-timing]', payload);
  } catch {
    /* noop */
  }

  try {
    void fetch(`${API_URL}/api/debug/iframe-timing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      /* fire-and-forget */
    });
  } catch {
    /* noop */
  }
}
