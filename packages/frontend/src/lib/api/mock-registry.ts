// ⚠️ AUTO-GENERATED 请勿手改。PM bootstrap 会重算本文件（见根 CLAUDE.md Step 2c）。
// 要调整模块清单 → 改 mock-registry.config.ts 而不是本文件。
// 要临时全局强制 mock → .env.local 设 NEXT_PUBLIC_USE_MOCK=1。
//
// ── Sync 快照 ───────────────────────────────────────────────
// 最近一次同步：2026-05-09
//
// Backend 路由扫描结果（含 @frontend-ready 注释状态）：
//   ✅ GET    /api/sessions                       @frontend-ready: true    (routes/sessions.ts)
//   ✅ GET    /api/sessions/:id                   @frontend-ready: true    (routes/sessions.ts)
//   ✅ POST   /api/sessions/open                  @frontend-ready: true    (routes/sessions.ts)
//   ✅ POST   /api/sessions/:id/messages          @frontend-ready: true    (routes/sessions.ts, SSE)
//   ✅ PATCH  /api/sessions/:id                   @frontend-ready: true    (routes/sessions.ts)
//   ✅ DELETE /api/sessions/:id                   @frontend-ready: true    (routes/sessions.ts)
//   ✅ GET    /api/characters                     @frontend-ready: true    (routes/characters.ts)
//   ✅ GET    /api/characters/:id                 @frontend-ready: true    (routes/characters.ts)
//   ✅ GET    /health                             @frontend-ready: true    (app.ts)
//
// 逐模块解析：
//   chat       → REAL  理由：6 个 endpoints 全部注册且 @frontend-ready: true
//   characters → REAL  理由：2 个 endpoints 全部注册且 @frontend-ready: true
//   payment    → MOCK  理由：4 个 endpoints 全部未在 backend 中注册
//
// ────────────────────────────────────────────────────────────

import type { MockModule } from './mock-registry.config';

const FORCE_ALL_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === '1';

const MOCK_MODULES = new Set<MockModule>(['payment']);

export function shouldUseMock(module: MockModule): boolean {
  return FORCE_ALL_MOCK || MOCK_MODULES.has(module);
}

export type { MockModule };
