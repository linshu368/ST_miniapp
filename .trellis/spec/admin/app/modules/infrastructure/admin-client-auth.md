---
module_id: admin.infrastructure.admin-client-auth
title: Admin API、鉴权与环境基建
scope: admin
category: infrastructure
status: active
owners: [admin]
last_verified_task: .trellis/tasks/09-17-batch-lab-prototype-alignment/
last_verified_at: 2026-09-22
---

# Admin API、鉴权与环境基建

## 职责与边界

提供 Supabase 会话、环境选择、统一 API helper、UI 状态和构建配置。Batch Lab 属于独立内部 SPA，不复用 Admin 登录/session 或 Refine 资源层；它只复用内部 Vite SPA 的公开配置边界与后端权威环境展示模式。

## 当前状态

Batch Lab 原型对齐后的样本详情、实验操作、对比详情、手机宽度富文本预览和新建实验逐变体配置继续使用自身 API client/React Query；模型密钥仅由 Backend 的 `BATCH_LAB_MODEL_KEY` 提供，不进入 Vite 配置或浏览器请求。

test/prod 配置隔离，Browser 只使用公开 anon 配置。Batch Lab V1 浏览器端只读取 `VITE_BATCH_LAB_API_URL`，通过 `/api/batch-lab/context` 获取 backend/source environment 和能力开关；应用内不提供登录、账号、角色或环境切换，不持有 Supabase anon key、service-role、数据库连接或供应商密钥。

## 入口与调用者

Admin 所有业务页面复用 Admin session/API helper。Batch Lab 页面复用自身 `packages/batch-lab/src/api/client.ts` 与 React Query，不直接调用 Admin helper，也不导入 Admin 源码。

## 涉及文件

| 路径                                          | 职责                                               |
| --------------------------------------------- | -------------------------------------------------- |
| `packages/admin/src/components/LoginPage.tsx` | Admin 登录入口                                     |
| `packages/admin/src/lib/adminApi.ts`          | Admin API helper                                   |
| `packages/admin/src/lib/adminNavigation.ts`   | Admin 导航公共逻辑                                 |
| `packages/batch-lab/src/api/client.ts`        | Batch Lab HTTP client、错误解包、超时与 request id |
| `packages/batch-lab/src/api/query-keys.ts`    | Batch Lab backend/source environment 缓存隔离      |
| `packages/batch-lab/src/App.tsx`              | Batch Lab 工作台、环境 banner 与 API 消费者        |

## 关键实现链路

Admin：选择环境 → Supabase session → API helper 附带身份 → 统一错误/UI。Batch Lab：读取公开 API base → context 握手 → React Query key 注入 backend/source environment → 页面只调用 frontend-ready Batch Lab API；配置缺失或 context 失败时显示安全停止错误态。

## 数据、契约与外部依赖

Admin 依赖 Vite、Ant Design、Refine、Supabase JS。Batch Lab 依赖 Vite、React Query、Ant Design 和 `@miniapp/shared` Batch Lab DTO；浏览器端只消费 shared contract 与 Backend HTTP 响应，不消费数据库 row 或 secret。

## 关键节点与约束

生产操作必须显式确认；VITE 变量均视为公开。Batch Lab V1 的访问控制依赖独立部署/域名与 backend CORS/feature flag，不能把 Admin session、Supabase browser client 或 service-role 带入 Batch Lab 包；source environment 由 Backend 部署固定，UI 只展示，不能切换。

## 验证方式

Admin test/typecheck/build。Batch Lab 变更至少运行 `pnpm --filter @miniapp/batch-lab typecheck && pnpm --filter @miniapp/batch-lab test && pnpm --filter @miniapp/batch-lab build`，跨消费者变更运行 `pnpm -r typecheck`。

## 已知缺口与待核验项

不同部署 Root Directory 对配置文件选择需持续核对。Batch Lab 真实 Vercel Preview 与 Backend CORS/feature flag 联调、结果详情/导出读端和最终 `.trellis/spec/batch-lab/app/` 建档由后续 integration-spec 收口。

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.infrastructure.database-environment`。

## 变更记录

- 2026-09-16：任务 `Batch Lab 前端工作台功能`（`.trellis/tasks/archive/2026-09/09-11-batch-lab-frontend-workbench/`）更新模块知识文档；提交前归档，见本任务后续 Git 提交。
- 2026-09-22：任务 `Batch Lab 原型一致性修复规划`（`.trellis/tasks/archive/2026-09/09-17-batch-lab-prototype-alignment/`）补充 Batch Lab 原型对齐后的当前实现事实；commit：`212942339cb51b2419b01149828a1b4ec78074d7`。
