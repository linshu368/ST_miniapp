# CS Platform 应用规范

> 当前客服业务与客户端基建见 [功能模块现状索引](./modules/index.md)；模块文件描述当前事实，本目录其他文件继续承载工程规范。

适用于 `packages/cs-platform/**`。本包是内部客服 SPA，承载 Telegram 用户回访和 MiniApp 站内客服两条隔离业务流。

## 专题规范

- [架构与文件地图](./architecture-and-files.md)
- [功能与组件](./features-and-components.md)
- [API、React Query 与鉴权](./api-query-and-auth.md)
- [UI、状态与可访问性](./ui-state-and-accessibility.md)
- [测试、构建与部署](./testing-build-and-deployment.md)

## Pre-Development Checklist

1. 搜索现有组件、`csApi`、query key、mutation 失效路径、CSS class 和 shared DTO。
2. 明确需求属于 Telegram 回访还是 MiniApp 客服；不得混用 ID、缓存、环境或消息模型。
3. 涉及接口时同时核对 `packages/backend/src/routes/cs-platform.ts`、shared contract 和 backend spec。
4. 明确 API 环境、认证头、敏感数据、轮询、失败/恢复和操作审计需求。
5. 复杂需求须记录复用调研、真实故障模型、最小方案、兼容和回滚后才实施。

## Required Rules

- 所有服务端状态通过 TanStack React Query 管理，网络调用通过 `src/api.ts`；组件不得直接 `fetch`。
- 使用 shared DTO；禁止导入 frontend/backend/admin 或数据库 row 类型。
- 保留 `X-CS-Admin-Token` 和 operator headers 的现有契约；token 不得进入 URL、日志、源码或持久化导出。
- query key 必须包含业务流、资源身份和环境；mutation 成功后精确失效相关缓存。
- 轮询只能用于需要接近实时的数据，页面隐藏/未登录/无会话时应停止，避免请求风暴。
- 保留运营流程，除非 PRD 明确批准改变；高风险群发/状态推进必须确认、禁重和展示部分失败。

## Quality Check

```bash
pnpm --filter @miniapp/cs-platform typecheck
pnpm --filter @miniapp/cs-platform build
```

本包当前无 test script；默认不因新增逻辑自动引入 Vitest 或新建测试文件。仅在用户、审核后的验收标准或明确风险确认需要时添加最小测试基础设施；在此之前必须执行并记录可重复人工回归，不能声称自动测试已覆盖。
