# Admin 应用规范

适用于 `packages/admin/**`。该包是“蜜镜 AI 运营平台”内部 SPA；浏览器端只负责运营交互，不得承载可信服务端逻辑。

## 事实来源

依次以当前源码与配置、`packages/admin/README.md`、`docs/ARCHITECTURE.md`、根 `AGENTS.md`、shared/backend/database spec 为准。本文中的“现状”描述当前实现；“MUST/禁止”为后续硬规则；“建议”不得写成已落地事实。

## 专题规范

- [架构与文件地图](./architecture-and-files.md)
- [功能与组件](./features-and-components.md)
- [数据、鉴权与环境](./data-auth-and-environments.md)
- [UI、状态与校验](./ui-state-and-validation.md)
- [测试、构建与部署](./testing-build-and-deployment.md)

## Pre-Development Checklist

1. 先搜索 `src/components`、`src/lib` 与 `@miniapp/shared` 的现有组件、schema、类型和 helper，记录复用、扩展或不复用理由。
2. 明确数据链路属于 Supabase session/RPC、backend admin API 还是公开 API；不得绕开现有鉴权边界。
3. 明确 test/production 影响、角色权限、草稿/发布/回滚语义、故障恢复与验证方式。
4. 跨包 DTO 先进入 `packages/shared/src/api/*`；涉及 backend 或数据库时同时读取对应 spec。
5. 复杂需求必须在 design 中给出最小充分方案、真实故障模型、复用边界、兼容和回滚；不适用项需说明理由。

## Required Rules

- 保持 `UI → src/lib helper → Supabase/backend` 单向依赖；组件不得复制 URL、RPC、token 或错误解包逻辑。
- 不得导入 frontend、backend 或 cs-platform；不得使用数据库行类型作为 UI/API 契约。
- 环境切换必须同时切换 API base、Supabase client/session 和缓存上下文，不得混用环境数据。
- 发布、回滚、赠送、删除、上下架等写操作必须防重复提交、展示明确结果并保留可恢复路径。
- 新抽象必须基于稳定职责和真实复用场景；禁止为假设需求预建通用框架。
- 不得以“简洁”为由省略鉴权、校验、错误反馈、审计语义或测试，也不得以“高可用”为由无故引入队列/缓存/重试层。

## Quality Check

```bash
pnpm --filter @miniapp/admin typecheck
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/admin build
```

逻辑改动至少运行 typecheck 和相关测试；跨页面、环境、依赖或部署改动必须 build。人工验证登录、环境隔离、空态/错误态、破坏性确认和窄屏可用性。
