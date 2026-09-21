# 实施计划

> 当前只完成规划，保持 `planning`；人工评审后才运行 `task.py start`。

## 阶段 0：依赖与实况门禁

1. 核对父 PRD、HTML 原型和依赖任务最终契约/证据。
2. 只读确认相关源码、环境和数据库 shape；不得读取或提交业务行。
3. 冻结本任务 API、状态、容量上限、失败码与 feature flag。

**停止**：依赖未完成、环境目标不清、来源只读边界无法证明。

## 阶段 1：契约与持久边界

1. 先完成 shared DTO/Zod和兼容测试，再写 producer/consumer。
2. 完成必要 migration/repository/mapper；禁止 DB row进入 UI。
3. 对 mutation 增加事务、唯一约束、版本或幂等键。

## 阶段 2：核心交付

- 1. batch_lab schema、样本相关表、约束/索引/grants/RLS/RPC与 repository
- 2. 唯一来源环境标识和专用只读连接；配置缺失时拒绝preview
- 3. 工程SQL模板、参数绑定、单SELECT/WITH预检与READ ONLY事务
- 4. 来源角色写/DDL/危险函数权限负测；平台写入独立client且只写`batch_lab`
- 5. statement/lock timeout、行数/字节/并发限制
- 6. 锚点去重、真实 turn/角色/动态输入补齐、排除原因
- 7. preview digest/TTL/一次性事务冻结和不可变样本集

每一步先写失败回归，再实现 happy path；保留 `@frontend-ready`、Pino allowlist、runtime config和 generation唯一出口。

## 阶段 3：失败、并发与恢复

1. 覆盖PRD列出的业务失败及通用配置缺失、超时、重复、并发、部分失败、重启。
2. 故障注入验证成功事实不重复、缓存不串环境、未知结果不虚报成功。
3. 验证 feature flag停止、worker drain（适用时）、应用回退和数据库 forward-fix。

## 阶段 4：验证

- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/backend typecheck`
- `pnpm --filter @miniapp/backend test`
- test migration shape/RLS/grants/locks/rollback checklist

不能运行的检查必须记录原因、风险、人工替代和后续 owner。

## 阶段 5：文档与交接

1. 新增 database Batch Lab storage module fact；更新 schema-security、conversation-storage、Backend data access、Shared environment 与 schema 归属地图。
2. 准备与 `task.json.meta.module_impact` 一致的 `module-updates.json`，运行 module knowledge check。
3. 把最终契约、验证、部署/回滚和遗留风险交给 `09-11-batch-lab-integration-spec`。
