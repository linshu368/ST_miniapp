# 实施计划

顺序：T1 → T2 → T3/T5 → T4 → T6 → T7 → 验证。

## 验证命令

- `pnpm --filter @miniapp/shared typecheck && pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`
- `pnpm --filter @miniapp/admin-client typecheck`、`pnpm --filter @miniapp/admin typecheck && pnpm --filter @miniapp/admin test`、`pnpm --filter @miniapp/admin-cli typecheck`
- `pnpm lint:complexity`、`pnpm lint:migrations`
- 迁移：在 docker PG17 上回放 `scripts/test-conversation-branches-migration.sh` 的基线，再执行新迁移，用 SQL 断言验证 RPC（前移+建任务、领取/租约、CAS 提交、失败退避、分支继承与记忆选择）。

## 测试（用户已同意开发后做基本测试）

- 窗口计划：未超水位不动；超水位退到 L 以下；保底不可移除；可移除不足时 floorBinding；富回复尾部不计数。
- 校验：缺板块、超长、思考标签、异常缩水、围栏剥离。
- 渲染：T 标注去除、注入块格式、压缩输入格式。
- 用真实压缩模型（TEST 或本地 key）跑一段 30+ 轮样例故事的分块压缩，人工检查档案。

## 失败路径

- 记忆读取超时/报错 → 不注入，生成照常（单测覆盖）。
- advance RPC 失败 → 只记日志。
- 模型失败/校验失败 → 旧版本不变，任务退避。

## 回退点

- 总开关关闭即停止生成与注入。
- 不准备回滚迁移；问题用 forward-fix。
