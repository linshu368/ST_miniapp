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

- 1. none/v1 与 regex-json/v1 不可变 processor version/digest
- 2. 规则语法/flags/数量/输入输出限制和有序替换
- 3. 可硬终止 worker/subprocess、执行超时、并发/内存限制与 ReDoS 防护
- 4. syntax/validation/runtime/timeout/limit/zero-match 错误语义
- 5. allowlist sanitizer、renderer protocol/version 和手机消息宽度预览
- 6. preview 与持久 display result 共用权威 executor

每一步先写失败回归，再实现 happy path；保留 `@frontend-ready`、Pino allowlist、runtime config和 generation唯一出口。

## 阶段 3：失败、并发与恢复

1. 覆盖 PRD列出的业务失败及通用无权限、超时、重复、并发、部分失败、重启。
2. 故障注入验证成功事实不重复、缓存不串环境、未知结果不虚报成功。
3. 验证 feature flag停止、worker drain（适用时）、应用回退和数据库 forward-fix。

## 阶段 4：验证

- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/backend test`
- ReDoS/worker crash/超长输入输出/sanitizer corpus
- `pnpm --filter @miniapp/batch-lab test`

不能运行的检查必须记录原因、风险、人工替代和后续 owner。

## 阶段 5：文档与交接

1. 补充 Batch Lab processor/renderer 规范与 module fact；更新 Backend 安全、Shared 契约和数据库存储事实。
2. 准备与 `task.json.meta.module_impact` 一致的 `module-updates.json`，运行 module knowledge check。
3. 把最终契约、验证、部署/回滚和遗留风险交给 `09-11-batch-lab-integration-spec`。
