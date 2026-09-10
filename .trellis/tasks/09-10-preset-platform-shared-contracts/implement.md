# Preset Platform Shared 契约实施计划

## 顺序

1. 复核父任务 PRD/design 的已确认决策，锁定 V1 单段 preset、私有会话/草稿、当前环境角色卡、关键用户信息脱敏和 SSE 事件。
2. 搜索现有 `packages/shared/src/api/*` 的分页、envelope、SSE、模型和会话契约写法，复用命名和测试风格。
3. 新增 `preset-platform.ts`，定义 DTO/Zod/error code/SSE event，并从 shared 根出口导出。
4. 补 shared 单元测试，覆盖有效/无效 preset、采样参数边界、分页、错误码和 SSE discriminator。
5. 运行 shared typecheck/test 和受影响消费者 typecheck。
6. 根据新增契约更新 `.trellis/spec/shared/contracts/*`，必要时补模块事实。

## 验证

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm -r typecheck
```
