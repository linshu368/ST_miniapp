# 执行计划（分支 codex/chat-cost-dashboard）

1. **迁移** `packages/shared/migrations/20261127_chat_cost_rollups.sql`：两张表、刷新函数、部分索引（事务外 CONCURRENTLY）、cron（无 pg_cron 时跳过）、回填，回滚写在文件头。
2. **本地 PG17 测试** `scripts/test-chat-cost-rollups-migration.sh`：用生产形状的 ops.llm_calls / chat_history / llm_call_costs 夹具，覆盖：
   - 一轮多路调用的成本结构拆分：首发胜出与落败、并发槽位、兜底、重写；
   - 待补（NULL）与 unavailable 计数；
   - 中转渠道 NULL 美元不当 0；
   - 跨 p_since 边界的轮不被截断；
   - 重跑幂等，结果不变；
   - 单价小时表只算有成本有 token 的调用；
   - p_since 超过 8 天被拒；
   - 权限：reader 只能 SELECT 表、不能执行函数；
   - 无 pg_cron 时迁移成功；
   - 与 llm_turn_costs 的 total 逐轮一致。
3. **后端**：
   - `stream-recovery.ts` 请求号读法；
   - `safe-log.ts` 四个字段；
   - 在现有 `stream-recovery.test.ts` 或 `execute.test.ts` 补断言：Surplus 重写只给 `x-request-id` 时台账带请求号。
4. **看板**：`docs/grafana/st-chat-cost.json`，用 Grafana MCP 发布；01、02 用 patch 加链接；`docs/grafana/README.md` 加一节；`docs/db/registry.yaml` 登记两张表并在 ops.llm_calls 备注里加索引；`packages/shared/migrations/README.md` 加一节。
5. **验证**：
   - `bash scripts/test-chat-cost-rollups-migration.sh`
   - `pnpm --filter @miniapp/backend exec vitest run src/features/generation src/platform/observability`
   - `pnpm -r typecheck`
   - `pnpm lint:complexity`
   - `pnpm lint:backend-logging`
   - `pnpm --filter @miniapp/backend logging:validate`
   - `pnpm lint:db-contract`
6. **发布**：
   1. PR → dev（squash）；
   2. GitHub Actions db-migrate：TEST apply → 生产 apply；
   3. 核对：两张表行数、cron 已排程、首轮刷新成功、回填天数、与 llm_turn_costs 抽样一致；
   4. release 分支 cherry-pick → main → Railway 部署 → 同步 dev；
   5. 发布看板，逐个面板在只读数据源上跑通并记耗时。

## 失败路径

- **迁移守卫**：ops.llm_calls 缺列，或 llm_call_costs 输出列与预期不符，直接 RAISE，整体回滚。
- **回填超时**：事务回滚，表和函数都不留下（索引在事务外，单独 DROP）。
- **cron 刷新失败**：表保留旧数据，看板刷新时间停住；查 cron.job_run_details。
- **重写请求号仍为空**：说明 Surplus 两个头都没给；看日志 `llm.call_record_failed` 与新行 request_id，必要时另查。
