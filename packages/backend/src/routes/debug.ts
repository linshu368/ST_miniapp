/**
 * [TEMP DEBUG — iframe-latency] backend / routes / debug.ts
 *
 * POST /api/debug/iframe-timing
 *
 * 接收前端首屏加载相位打点（见 frontend/src/lib/bridge/iframe-timing.ts + ST 端 debug-timing），
 * 计算相位耗时并以 info 级别落 Railway 日志，供 `railway logs -s stminiapp` 拉取分析。
 *
 * 无鉴权：临时调试端点，只读打点、只写日志，不触碰业务数据。用完连同前端/ST 端打点一并删除。
 */

import { FastifyInstance } from 'fastify';
import { ok } from '@miniapp/shared';

type TimingBody = {
  meta?: Record<string, unknown>;
  marks?: Record<string, number>;
  details?: Record<string, string>;
  ua?: string;
};

// 相邻相位定义：[标签, 起点 mark, 终点 mark]
const PHASES: Array<[string, string, string]> = [
  // 整体
  ['点卡→呈现', 'page_mount', 'chat_ready'],
  ['点卡→闸门(等ST_ready)', 'page_mount', 'gate_open'],
  ['ensureCharacter', 'ensure_start', 'ensure_end'],
  ['selectCharacter(总)', 'select_start', 'select_end'],
  // selectCharacter 内部（ST 端）
  ['  ├H1 找卡+getCharacters重载', 'sel_start', 'sel_reload_done'],
  ['  ├H3 selectCharacterById', 'sel_reload_done', 'sel_selectById_done'],
  ['  └H2 /newchat', 'sel_selectById_done', 'sel_newchat_done'],
  ['  └H2 /newchat失败', 'sel_newchat_start', 'sel_newchat_error'],
  // 冷启动（bridge 生命周期，绝对，仅首次有意义）
  ['[冷]iframe_load(网络)', 'bridge_start', 'iframe_onload'],
  ['[冷]st_script+ext_init', 'iframe_onload', 'st_handshake'],
  ['[冷]st_app_boot(→APP_READY)', 'st_handshake', 'st_ready'],
  // T2 三段握手：interactive 相位（握手→可交互、以及 interactive 领先 APP_READY 的量）
  ['[冷]st_boot(→interactive)', 'st_handshake', 'st_interactive'],
  ['[冷]interactive→APP_READY', 'st_interactive', 'st_ready'],
];

export default async function debugRoutes(app: FastifyInstance) {
  // @frontend-ready: true — 临时调试端点，接收前端打点并落日志
  app.post('/api/debug/iframe-timing', async (request, reply) => {
    const body = (request.body ?? {}) as TimingBody;
    const marks = body.marks ?? {};
    const details = body.details ?? {};

    const phaseLines = PHASES.map(([label, a, b]) => {
      const va = marks[a];
      const vb = marks[b];
      const d = va != null && vb != null ? vb - va : null;
      return `${label}=${d != null ? `${d}ms` : 'n/a'}`;
    });

    // boot 瀑布/长任务收割数据（round-3 细粒度探针）单独成行，避免主行超长被日志截断。
    // 瀑布偏移基准是 iframe 的 performance.timeOrigin（boot_nav 里携带），非 bridge_start。
    // round-4 新增 sel_*：点卡窗口探针（瀑布/事件序列/长任务），偏移基准是 sel_start。
    const isWaterfallKey = (k: string) =>
      k.startsWith('boot_wf') ||
      k.startsWith('boot_longtask') ||
      k === 'boot_nav' ||
      k.startsWith('sel_wf') ||
      k.startsWith('sel_longtask') ||
      k === 'sel_evt' ||
      // round5: 停摆诊断收割数据（fetch 生命周期/资源/文档状态），独立成行防截断
      k.startsWith('stall_');
    const mainDetails: Record<string, string> = {};
    const waterfallLines: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(details)) {
      if (isWaterfallKey(k)) waterfallLines.push([k, v]);
      else mainDetails[k] = v;
    }

    // 冷启动内部时间线：所有打点按时间排序，相对最早打点给偏移（含动态 ar:* 事件）
    const sorted = Object.entries(marks)
      .filter(([k]) => !isWaterfallKey(k))
      .sort((x, y) => x[1] - y[1]);
    const t0 = sorted.length > 0 ? sorted[0]![1] : 0;
    const timeline = sorted.map(([k, v]) => `${k}@+${v - t0}ms`).join(' ');

    const charId = String(body.meta?.characterId ?? '-');
    // 平台分类（供按 iOS/Android/Desktop 分别统计停摆率）。plat 紧跟 char 放前部，
    // 即使主行被日志截断也能保留；原始 ua 追加在行尾（best-effort）。
    const ua = String(body.ua ?? '-');
    const plat = /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /Macintosh|Windows|Linux|X11/i.test(ua)
          ? 'Desktop'
          : 'other';
    request.log.info(
      `[iframe-timing] char=${charId} plat=${plat} | ` +
        phaseLines.join('  ') +
        ` | details=${JSON.stringify(mainDetails)}` +
        ` | timeline=${timeline}` +
        ` | ua=${ua}`
    );
    // Keep failure metadata on its own line: the main timing line can be long enough for
    // Railway to truncate its tail, and PR #123's BridgeError fields live under meta.
    request.log.info(`[iframe-timing-meta] char=${charId} meta=${JSON.stringify(body.meta ?? {})}`);
    waterfallLines.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k, v] of waterfallLines) {
      request.log.info(`[iframe-timing-wf] char=${charId} ${k}: ${v}`);
    }

    return reply.send(ok({ received: true }));
  });
}
