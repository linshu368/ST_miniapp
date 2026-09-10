# Preset Platform 模型目录与内部生成实施计划

## 顺序

1. 读取 Admin 模型目录实现、backend generation/model 现状和 shared SSE 契约。
2. 复用 backend OpenRouter 目录 timeout/cache/stale fallback，并新增 Preset Platform 专用鉴权端点。
3. 前端模型目录交互按 Admin 口径实现：schema 校验、搜索 name/id/description/canonical slug、stale/同步/强刷/过期状态。
4. 在 `features/generation` 内新增 internal test purpose，跳过 quota/wallet/charge，保留 timeout/SSE/prompt cache/request id。
5. 实现单段 preset composer、原子开轮、busy、idempotency、SSE 收口和 retry。
6. fake upstream 覆盖流前/流内失败、断线、重复、并发和重启恢复。
7. 更新 backend generation/model spec 和 shared 契约说明。

## 验证

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
```
