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

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://stminiapp-development.up.railway.app';

const marks = new Map<string, number>();
const details = new Map<string, string>();

export function markTiming(name: string): void {
  marks.set(name, Date.now());
}

/** ST iframe 端打点（携带 ST 侧 Date.now()，同设备同一时钟，可直接与父窗口相减）。 */
export function markTimingAt(name: string, t: number, info?: string): void {
  marks.set(name, t);
  if (info) details.set(name, info);
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
    'chat_ready',
    // [iframe-timing] round2: selectCharacter ST 端子相位（每次进卡刷新）
    'sel_start',
    'sel_reload_done',
    'sel_selectById_done',
    'sel_newchat_done',
  ]) {
    marks.delete(k);
    details.delete(k);
  }
  // [iframe-timing] round4: 点卡窗口探针数据（sel_wf_N/sel_evt/sel_longtask_N，N 不定长）按前缀清理
  for (const k of [...marks.keys()]) {
    if (k.startsWith('sel_wf') || k.startsWith('sel_longtask') || k === 'sel_evt') {
      marks.delete(k);
      details.delete(k);
    }
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
