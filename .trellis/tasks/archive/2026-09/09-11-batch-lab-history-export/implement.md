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

- 1. 倒序历史、分页/筛选、详情直接来源与最初生成来源
- 2. 复制完整 A/B/样本/模式/目的为新草稿并保持深复制隔离
- 3. 全部样本全部轮次 reuse display tasks，generation task=0
- 4. 实验/样本/可选轮序备注与标签 upsert（排期后置时显式标记）
- 5. Backend 流式 JSONL 一样本一行、schema version和 attachment
- 6. 失败/blocked/unknown、完整输入/组合/结果/血缘和备注导出

每一步先写失败回归，再实现 happy path；保留 `@frontend-ready`、Pino allowlist、runtime config和 generation唯一出口。

## 阶段 3：失败、并发与恢复

1. 覆盖 PRD列出的业务失败及通用无权限、超时、重复、并发、部分失败、重启。
2. 故障注入验证成功事实不重复、缓存不串环境、未知结果不虚报成功。
3. 验证 feature flag停止、worker drain（适用时）、应用回退和数据库 forward-fix。

## 阶段 4：验证

- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/backend test`
- `pnpm --filter @miniapp/batch-lab test`
- JSONL round-trip/partial failure/large stream/zero-generation assertions

不能运行的检查必须记录原因、风险、人工替代和后续 owner。

## 阶段 5：文档与交接

1. 补充 Batch Lab history/reuse/export 规范与 module fact；更新 Shared JSONL契约、Backend生成血缘和数据库存储事实。
2. 准备与 `task.json.meta.module_impact` 一致的 `module-updates.json`，运行 module knowledge check。
3. 把最终契约、验证、部署/回滚和遗留风险交给 `09-11-batch-lab-integration-spec`。
