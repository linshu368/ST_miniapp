# 实施计划

> 当前只完成规划，保持 `planning`；人工评审后才运行 `task.py start`。

## 阶段 0：依赖与实况门禁

1. 核对父 PRD、HTML 原型和依赖任务最终契约/证据。
2. 只读确认相关源码、环境和数据库 shape；不得读取或提交业务行。
3. 冻结本任务 API、状态、容量上限、失败码与 feature flag。

**停止**：依赖未完成、环境目标不清、来源只读/不计费边界无法证明。

## 阶段 1：契约与持久边界

1. 先完成 shared DTO/Zod和兼容测试，再写 producer/consumer。
2. 完成必要 migration/repository/mapper；禁止 DB row进入 UI。
3. 对 mutation 增加事务、唯一约束、版本或幂等键。

## 阶段 2：核心交付

- 1. Vite React 18 + TypeScript strict + Ant Design + React Query 包骨架
- 2. packages/shared/src/api/batch-lab.ts 基础 context/envelope/error 契约
- 3. 统一 API client、请求 ID、超时/取消、错误分类与环境 query key；不接入登录或Bearer token
- 4. 权威环境 banner、精确CORS allowlist与最小公开env example
- 5. 参考Admin/CS Platform新增包内Vercel配置、独立项目说明和SPA rewrite
- 6. 在现有CI quality gate增加Batch Lab test/build，不增加Railway前端service或前端镜像

每一步先写失败回归，再实现 happy path；保留 `@frontend-ready`、Pino allowlist、runtime config和 generation唯一出口。

## 阶段 3：失败、并发与恢复

1. 覆盖PRD列出的业务失败及通用配置缺失、超时、重复、并发、部分失败、重启。
2. 故障注入验证成功事实不重复、缓存不串环境、未知结果不虚报成功。
3. 验证 feature flag停止、worker drain（适用时）、应用回退和数据库 forward-fix。

## 阶段 4：验证

- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/batch-lab typecheck`
- `pnpm --filter @miniapp/batch-lab test`
- `pnpm --filter @miniapp/batch-lab build`
- `pnpm -r typecheck`

不能运行的检查必须记录原因、风险、人工替代和后续 owner。

## 阶段 5：文档与交接

1. 为最终`.trellis/spec/batch-lab/app/`提供工程、API client、环境、Vercel与CI部署事实；更新Backend/Shared基建module facts。
2. 准备与 `task.json.meta.module_impact` 一致的 `module-updates.json`，运行 module knowledge check。
3. 把最终契约、验证、部署/回滚和遗留风险交给 `09-11-batch-lab-integration-spec`。
