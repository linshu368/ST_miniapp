# Backend 应用规范

适用于 `packages/backend`。本文是入口；实现前必须按改动范围继续阅读专题规范。事实基线以当前源码、根 `AGENTS.md` 和 `docs/ARCHITECTURE.md` 为准；包级 `CLAUDE.md` 已删除，不得恢复平行规则来源。

## 专题导航

| 文档                                                               | 必读场景                                   |
| ------------------------------------------------------------------ | ------------------------------------------ |
| [架构、入口与文件职责](./architecture-and-files.md)                | 所有 Backend 任务                          |
| [路由、功能域与调用链](./routes-and-features.md)                   | API、业务流程、LLM、支付、语音、增长       |
| [数据、可靠性、安全与可观测性](./data-reliability-and-security.md) | DB、外部调用、鉴权、并发、任务、日志、配置 |
| [测试、脚本、构建与部署](./testing-scripts-and-deployment.md)      | 测试、验收、Railway、定时任务、迁移        |
| [规范约定](./backend-rules.md)                                     | 工程相关约束                               |

## 功能模块现状

当前业务、基础设施和公共能力的实现位置与调用链见 [模块索引](./modules/index.md)。模块文件描述当前事实，本文及专题文件继续承载编码规范。

## 架构定位

- Fastify 5 + TypeScript ESM 服务，开发/生产均由 `tsx` 启动；Node.js `>=22`。
- 应用包之间不得 import；Backend 通过 HTTP/SSE 为 Frontend、Admin、CS Platform 提供能力，只依赖 `@miniapp/shared` 契约。
- Prisma 只覆盖 `app_core`、`miniapp_features`、`billing` 的映射；其余域通过 Supabase schema client/RPC/repository 访问。
- LLM 生成与计费唯一出口是 `src/features/generation/`；运行时配置唯一读取入口是 `src/platform/runtime-config.ts`。

## 开发前硬门禁

1. 阅读本入口、对应专题、根 `AGENTS.md` 和 `docs/ARCHITECTURE.md`；日志任务再读 `docs/log_system.md`。
2. 搜索现有 route、feature、repository、helper、shared contract 和测试，说明复用/扩展决策。
3. 对外数据形状必须先定义于 `packages/shared/src/api/*`，再写 handler；不得暴露 Prisma/Supabase 行类型。
4. 外部调用必须明确超时；只对安全可重试操作做有限退避重试。关键写入必须评估幂等、并发、事务、补偿和重复回调。
5. 所有 `app.get/post/put/patch/delete` 注册附近必须保留 `@frontend-ready: true|false`；`false` 要有业务原因。
6. 不新增 `any`；不读取散落的 `process.env` 替代 `platform/config.ts`；不另建生成、计费、runtime config 或日志体系。
7. 不改动受保护的 `DEV_SEED_*` UUID 或对应 `prisma/seed.ts` upsert，除非同步核验所有消费者。

## 最低质量检查

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
```

契约变更必须追加所有消费者 typecheck；对话/生成链路运行现有 backend 测试并记录真实上游/SSE 人工回归，已删除的阶段 `mvp:regression` 不再是验证入口。数据库迁移不随部署自动执行，只能按 Supabase spec 的单文件流程操作。
