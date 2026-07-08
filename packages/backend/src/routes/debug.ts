/**
 * [TEMP DEBUG — iframe-latency] backend / routes / debug.ts
 *
 * POST /api/debug/iframe-timing
 *
 * 接收前端首屏加载相位打点（见 frontend/src/lib/bridge/iframe-timing.ts），
 * 计算相位耗时并以 info 级别落 Railway 日志，供 `railway logs -s stminiapp` 拉取分析。
 *
 * 无鉴权：临时调试端点，只读打点、只写日志，不触碰业务数据。用完连同前端打点一并删除。
 */

import { FastifyInstance } from 'fastify';
import { ok } from '@miniapp/shared';

type TimingBody = {
  meta?: Record<string, unknown>;
  marks?: Record<string, number>;
  ua?: string;
};

// 相邻相位定义：[标签, 起点 mark, 终点 mark]
const PHASES: Array<[string, string, string]> = [
  ['iframe_load(网络: index+同步资源)', 'bridge_start', 'iframe_onload'],
  ['st_script_exec+ext_init(到握手)', 'iframe_onload', 'st_handshake'],
  ['st_app_boot(握手→APP_READY, 峰值疑点)', 'st_handshake', 'st_ready'],
  ['gate_wait(ready→page放行)', 'st_ready', 'gate_open'],
  ['ensureCharacter(单卡下发)', 'ensure_start', 'ensure_end'],
  ['selectCharacter(选角色+载入聊天)', 'select_start', 'select_end'],
  ['select_end→chat_ready(呈现)', 'select_end', 'chat_ready'],
];

export default async function debugRoutes(app: FastifyInstance) {
  // @frontend-ready: true — 临时调试端点，接收前端打点并落日志
  app.post('/api/debug/iframe-timing', async (request, reply) => {
    const body = (request.body ?? {}) as TimingBody;
    const marks = body.marks ?? {};

    const t0 = marks['page_mount'] ?? marks['bridge_start'];
    const end = marks['chat_ready'];
    const total = t0 != null && end != null ? end - t0 : null;

    const phaseLines = PHASES.map(([label, a, b]) => {
      const va = marks[a];
      const vb = marks[b];
      const d = va != null && vb != null ? vb - va : null;
      return `${label}=${d != null ? `${d}ms` : 'n/a'}`;
    });

    // 关键复合区间：点卡→呈现，以及点卡→闸门打开（等 ST 冷启动那段）
    const clickToReady = total;
    const clickToGate =
      marks['page_mount'] != null && marks['gate_open'] != null
        ? marks['gate_open'] - marks['page_mount']
        : null;

    request.log.info(
      `[iframe-timing] char=${String(body.meta?.characterId ?? '-')} ` +
        `点卡→呈现=${clickToReady != null ? `${clickToReady}ms` : 'n/a'} ` +
        `点卡→闸门=${clickToGate != null ? `${clickToGate}ms` : 'n/a'} | ` +
        phaseLines.join(' ') +
        ` | marks=${JSON.stringify(marks)}`
    );

    return reply.send(ok({ received: true }));
  });
}
