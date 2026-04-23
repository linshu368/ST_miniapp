# Backend CLAUDE.md（AI 硬规则速查）

> 在 `packages/backend` 下工作时必须遵守本文件。  
> 与前端 CLAUDE.md 对等，提供后端侧的约束和目录约定。

## 必须（硬规则）

- **框架**：Fastify 5。
- **语言**：TypeScript 严格模式。**禁止 `any`**。
- **运行时**：Node.js 20.x，使用 tsx 执行。
- **数据契约**：所有前后端共享的数据形状必须定义在 `packages/shared/`，后端不得在 `backend/` 内部私定对外数据形状。
- **数据库**：Supabase PostgreSQL，与 Bot 共享。
- **环境变量**：不要提交到 git，走部署平台（Railway）管理。

## 与前端的边界

- 后端**不关心**前端的 UI 框架、样式方案、状态管理选型。
- 后端**必须关心** `packages/shared/` 里的类型契约，确保 API 响应与契约一致。
- 新增 API 端点时，先在 `shared/` 定义请求/响应类型，再写实现。
