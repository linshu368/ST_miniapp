# 执行计划

## 步骤

1. 迁移 `packages/shared/migrations/20261126_panel_llm_calls.sql`（design §3），带尾检与回滚说明。
2. 迁移测试 `scripts/test-panel-llm-calls-migration.sh`（一次性 PG17，`--network none`）：按生产形状建 `ops.llm_calls`（四个现行约束 + 索引）、`analytics.llm_call_costs` 生产原文、`billing.usage_charges`、`grafana_cloud` 角色，执行两遍。断言：
   - 聊天行仍必须带 `chat_history_id`、不能带 `panel_trigger`；面板行必须不带 `chat_history_id`、`panel_trigger` 只能 auto / manual；未知 lane 拒绝。
   - `llm_call_costs` 不含面板行，聊天行结果不变；两张新视图口径正确（北京日界、待补 / 缺失为空、收入通用 / 专项拆分）。
   - `grafana_cloud` 能读新视图、读不到 `ops.llm_calls` / `billing.usage_charges`；anon / authenticated 读不到。
   - 约束已 VALIDATE、部分索引有效；重放无变化；`llm_call_costs` 定义对不上时整体回滚。
3. 后端：`panel-call-ledger.ts`、`status-bar-model.ts` 采集调用事实并记账、`status-bar/update.ts` 与 `memory-bar/update.ts` 传 `trigger`。
4. 后端单测：扩展 `status-bar-model.test.ts`：首发成功 / 首字超时 / HTTP 错误、兜底成功 / 截断各记一行，字段正确；记账失败不影响返回。
5. 看板：`docs/grafana/st-panel-quality.json` 顶部插入新一节（其余面板整体下移，不改内容）；`docs/grafana/README.md` 补口径。
6. 文档：`docs/db/registry.yaml`、`packages/shared/migrations/README.md`。

## 验证命令

```bash
bash scripts/test-panel-llm-calls-migration.sh
pnpm --filter @miniapp/backend test -- status-bar-model memory-bar status-bar
pnpm -r typecheck
pnpm lint
pnpm lint:complexity
pnpm lint:db-contract
pnpm lint:backend-logging
pnpm --filter @miniapp/backend logging:validate
```

## 发布与验收

1. 迁移：TEST apply（自带尾检）→ 生产 apply → 生产只读核对约束、视图、授权、索引。
2. 代码：PR → dev → TEST（Railway development）手动更新一次，30 分钟后 TEST 只读确认面板行与成本（TEST 无 MCP，用 workflow inspect 或日志）；发布分支基于最新 main → 合 main → 部署核对。
3. 看板：用 Grafana MCP 读线上 `st-panel-quality` 现版，与仓库 JSON 比对后整体更新；逐个面板跑查询核对无报错。
4. 发布后 1 小时：生产 `ops.llm_calls` 面板行数 ≈ `st_panel_attempts_total` 同期增量；`cost_source` 开始补齐。24 小时：补齐率、缺失率、经营核心看板当天数字与发布前同口径。
5. 发布后同步 main → dev。
