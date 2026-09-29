# 实施计划

> 当前只完成规划，保持 `planning`；人工评审后才运行 `task.py start`。

## 阶段 0：依赖与实况门禁

1. 核对父 PRD、HTML 原型和依赖任务最终契约/证据。
2. 只读确认相关源码、环境和数据库 shape；不得读取或提交业务行。
3. 冻结本任务 API、状态、容量上限、失败码与 feature flag。

**停止**：依赖未完成、环境目标不清、只读/鉴权/不计费边界无法证明。

## 阶段 1：契约与持久边界

1. 先完成 shared DTO/Zod和兼容测试，再写 producer/consumer。
2. 完成必要 migration/repository/mapper；禁止 DB row进入 UI。
3. 对 mutation 增加事务、唯一约束、版本或幂等键。

## 阶段 2：核心交付

- 1. A/B 模型/参数/完整预设/processor snapshot、深复制与真实 diff
- 2. 启动预检、排除、调用数、frozen revision 和幂等启动
- 3. features/generation 内受控 internal_research policy
- 4. 数据库任务租约、heartbeat、SKIP LOCKED 等价领取和重启恢复
- 5. 单轮与最后 X 轮分支串行、跨样本有界并发
- 6. attempt/effective request/raw output/finish reason/usage、失败阻塞、有限重试和 unknown

每一步先写失败回归，再实现 happy path；保留 `@frontend-ready`、Pino allowlist、runtime config和 generation唯一出口。

## 阶段 3：失败、并发与恢复

1. 覆盖 PRD列出的业务失败及通用无权限、超时、重复、并发、部分失败、重启。
2. 故障注入验证成功事实不重复、缓存不串环境、未知结果不虚报成功。
3. 验证 feature flag停止、worker drain（适用时）、应用回退和数据库 forward-fix。

## 阶段 4：验证

- `pnpm --filter @miniapp/backend typecheck`
- `pnpm --filter @miniapp/backend test`
- `pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model`
- 故障注入：429/5xx/4xx/超时/截断/空输出/双 worker/kill

不能运行的检查必须记录原因、风险、人工替代和后续 owner。

## 阶段 5：文档与交接

1. 新增 Backend Batch Lab execution module fact；更新 conversation-generation 与 runtime-data-security，记录 internal research 不绕过 generation 的边界。
2. 准备与 `task.json.meta.module_impact` 一致的 `module-updates.json`，运行 module knowledge check。
3. 把最终契约、验证、部署/回滚和遗留风险交给 `09-11-batch-lab-integration-spec`。
