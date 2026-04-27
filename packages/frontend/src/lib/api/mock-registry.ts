// ⚠️ AUTO-GENERATED 请勿手改。PM bootstrap 会重算本文件（见根 CLAUDE.md Step 2c）。
// 要调整模块清单 → 改 mock-registry.config.ts 而不是本文件。
// 要临时全局强制 mock → .env.local 设 NEXT_PUBLIC_USE_MOCK=1。
//
// ── Sync 快照 ───────────────────────────────────────────────
// 最近一次同步：2026-04-27（基准：本地 packages/backend/src/ 当前状态）
//
// Backend 路由扫描结果（含 @frontend-ready 注释状态）：
//   ✅ GET  /api/sessions                       @frontend-ready: true    (routes/sessions.ts)
//   ✅ GET  /api/sessions/:id                   @frontend-ready: true    (routes/sessions.ts)
//   ✅ POST /api/sessions/open                  @frontend-ready: true    (routes/sessions.ts)
//   ⚠️ POST /api/sessions/:id/messages          @frontend-ready: false — 响应改 SSE 流，shared 契约 PostMessageData 待更新为流式格式  (routes/sessions.ts)
//   ✅ GET  /api/characters                     @frontend-ready: true    (routes/characters.ts)
//   ✅ GET  /api/characters/:id                 @frontend-ready: true    (routes/characters.ts)
//   ✅ GET  /health                             @frontend-ready: true    (app.ts)
//
// 逐模块解析：
//   chat       → MOCK  理由：POST /api/sessions/:id/messages 标记 @frontend-ready: false — 响应改 SSE 流，shared 契约 PostMessageData 待更新为流式格式
//   characters → REAL  理由：2 个 endpoints 全部注册且 @frontend-ready: true
//   payment    → MOCK  理由：4 个 endpoints 全部未在 backend 中注册
//
// ────────────────────────────────────────────────────────────

import type { MockModule } from './mock-registry.config';

const FORCE_ALL_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === '1';

const MOCK_MODULES = new Set<MockModule>(['chat', 'payment']);

export function shouldUseMock(module: MockModule): boolean {
  return FORCE_ALL_MOCK || MOCK_MODULES.has(module);
}

export type { MockModule };
