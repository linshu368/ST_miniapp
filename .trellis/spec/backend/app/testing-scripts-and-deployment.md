# Backend 测试、脚本、构建与部署

## 测试分层

- 纯函数：billing、engine、context window、SSE encoder、ranking、recharge rules、voice 文本/草稿；覆盖边界和确定性。
- 编排/route：mock repository/upstream，断言鉴权、status、envelope、日志安全；SSE 覆盖 start/delta/done/error、首字节前失败、abort。
- Repository/integration：显式 opt-in、隔离数据并确认 test DB；普通单测不得意外访问远端。
- 回归：`mvp:regression` 验证对话，`invite:uat` 验证邀请；固定 fixture、超时、非零失败退出码和摘要。

Bug 修复先写失败回归。关键写覆盖重复调用、并发、超时、上游 4xx/429/5xx、DB 部分失败、job 重跑；不能自动化时记录人工步骤和剩余风险。

## 命令与脚本

```bash
pnpm --filter @miniapp/backend dev
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model
pnpm --filter @miniapp/backend invite:uat
```

`payment:expire-orders`、`payment:reconcile-orders`、`payment:diagnose-query`、`payment:callback-report` 具有环境影响；运行前确认环境、幂等性和 dry-run/只读性质。

## 部署与验收

- 主服务部署 Railway；参考 `ops/docker/Dockerfile.backend`、`ops/railway/README.md`、`.railway/railway.ts`。监听 `PORT`，健康检查 `/health`。
- start 先 `prisma generate`，再 `tsx --import ./src/instrumentation.ts src/server.ts`；当前没有传统 `dist` build。
- 支付过期/对账可能为独立 Railway 服务/任务。部署不执行 DB migration，禁止把迁移塞进启动命令。
- route/feature：typecheck + tests + 契约和 `@frontend-ready`；contract：shared test + 所有 consumers typecheck；生成：MVP 回归/SSE/扣费失败路径；支付：状态机/重复回调/原子入账/恢复；DB：test-first、RLS/锁/回滚；deploy：fail-fast、health、日志脱敏。
- 最终执行 `git diff --check`，不提交 `.env`、报告或测试业务数据；不自动 push。
