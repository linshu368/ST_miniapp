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
  // 冷启动（bridge 生命周期，绝对，仅首次有意义）
  ['[冷]iframe_load(网络)', 'bridge_start', 'iframe_onload'],
  ['[冷]st_script+ext_init', 'iframe_onload', 'st_handshake'],
  ['[冷]st_app_boot(→APP_READY)', 'st_handshake', 'st_ready'],
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

    // 冷启动内部时间线：所有打点按时间排序，相对最早打点给偏移（含动态 ar:* 事件）
    const sorted = Object.entries(marks).sort((x, y) => x[1] - y[1]);
    const t0 = sorted.length > 0 ? sorted[0]![1] : 0;
    const timeline = sorted.map(([k, v]) => `${k}@+${v - t0}ms`).join(' ');

    request.log.info(
      `[iframe-timing] char=${String(body.meta?.characterId ?? '-')} | ` +
        phaseLines.join('  ') +
        ` | details=${JSON.stringify(details)}` +
        ` | timeline=${timeline}`
    );

    return reply.send(ok({ received: true }));
  });
}
