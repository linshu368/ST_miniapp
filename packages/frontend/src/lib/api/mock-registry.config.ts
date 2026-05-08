// Mock registry 配置（人工维护）
//
// 定义前端每个模块 → 期望调用的后端 endpoints / 强制 mock 原因 / 不可独立切换的模块组。
// Claude Code 在 PM bootstrap 阶段读本文件 + 扫 packages/backend/src/ 自动重算 mock-registry.ts。
// 详细规则见根 CLAUDE.md「Step 2c — PM 专属：Mock-Registry 自动同步」。
//
// ── 新增功能的工作流（PM 视角）────────────────────────────────
// 1. 在 MockModule 联合类型里加新模块名
// 2. 在 MODULE_CONFIG 里加一条 { endpoints, [forceMockReason] }
// 3. 在 src/lib/mock-data/ 下写 mock 数据
// 4. 在 src/lib/api/<module>.ts 里用 shouldUseMock('<module>') 分叉 mock / 真 API 分支
// 5. 下次启动 Claude Code 会话时，bootstrap 自动把新模块标为 MOCK（因 dev 后端还没实现）

export type MockModule = 'chat' | 'characters' | 'payment';

export interface ModuleConfig {
  /** 本模块调用的 backend endpoints，格式 'METHOD /path'，path 用 :paramName 占位 */
  endpoints: string[];
  /**
   * 非空则强制 mock（即使 endpoints 都在、同组成员都 real）。
   * 用于：后端路由已注册但业务逻辑不完整（例如 handler 没调 LLM、支付逻辑未完成）。
   * 内容会出现在生成文件的注释里便于追溯。
   */
  forceMockReason?: string;
}

export const MODULE_CONFIG: Record<MockModule, ModuleConfig> = {
  chat: {
    endpoints: [
      'GET /api/sessions',
      'GET /api/sessions/:id',
      'POST /api/sessions/open',
      'POST /api/sessions/:id/messages',
      'PATCH /api/sessions/:id',
      'DELETE /api/sessions/:id',
    ],
    // forceMockReason 默认不填——handler 完工性由 Dev 在路由上的 @frontend-ready 注释维护
  },
  characters: {
    endpoints: ['GET /api/characters', 'GET /api/characters/:id'],
  },
  payment: {
    endpoints: [
      'GET /api/payment/plans',
      'POST /api/payment/orders',
      'GET /api/payment/orders',
      'GET /api/payment/orders/:id',
    ],
  },
};
