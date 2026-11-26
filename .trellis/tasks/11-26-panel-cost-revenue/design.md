# 设计：状态栏 / 记忆栏成本与星尘收入对照

## 1. 复用调研

| 检索对象                                                                                                | 结论                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops.llm_calls`（生产 48 万行 / 489MB，lane 只有 chat / free_zone，`chat_history_id` NOT NULL，无外键） | **扩展**：加 lane `status_bar` / `memory_bar`，`chat_history_id` 改可空（面板调用不属于任何聊天轮次），加列 `panel_trigger`。CONTRACT 规则 4：上游调用统一记这里、新场景加 lane。 |
| `features/generation/call-costs.ts`（每 10 分钟补 `cost_source` 为空的行，不分 lane）                   | **原样复用**：OpenRouter 有 generation id → 查实际花费（最多 8 次、24 小时内）；Surplus 非 attempt 行有请求号 → 20 分钟后查买家成本；都拿不到 → `unavailable`。                   |
| `call-ledger.ts insertLlmCall`（聊天专用，要 chatHistoryId、attempt 归属）                              | **不复用**：字段语义是聊天轮次。新写一个小函数只插面板行。                                                                                                                        |
| `analytics.refresh_core_daily`（经营核心每日成本，按当天轮次 id `IN (...)` 汇总 llm_calls）             | **不改**：面板行 `chat_history_id` 为空，天然不会被算进聊天成本。                                                                                                                 |
| `analytics.llm_call_costs` / `llm_turn_costs`（每轮成本视图，无 lane 过滤）                             | **改一处**：加 `lane IN ('chat','free_zone')`，免得面板行以空轮次聚成一行。列不变。                                                                                               |
| `experience.list_llm_call_metadata_gaps` / `list_surplus_request_record_candidates` 等                  | 只看 attempt 行或带任务的 Surplus 行，面板行（attempt_id 为空、无任务）不受影响。                                                                                                 |
| `billing.usage_charges`（`kind='status_refresh'`，有 `(kind, subject_id)` 部分索引）                    | **只读**：收入明细视图。                                                                                                                                                          |
| Grafana 生产只读角色 `grafana_cloud`（只能读 `analytics` 视图，连接上限 3）                             | 新增两张 `analytics` 视图并单独授权。                                                                                                                                             |
| Prometheus `st_panel_attempts_total`                                                                    | 只用来核对调用条数，不当成本来源。                                                                                                                                                |

## 2. 记账（后端）

`callStatusModel(channel, messages, { panel, trigger, signal })` 新增必填 `trigger`（状态更新、记忆检查两处调用各传 `input.trigger`）。每次调用用一个事实对象边调边填，`finally` 里不 await 地写一行：

| 列                          | 首发（Surplus 流式）                                                            | 兜底（OpenRouter 非流式）        |
| --------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| provider / model            | `surplus` / 实际模型                                                            | `openrouter` / 实际模型          |
| dispatched_at               | 发请求前                                                                        | 同左                             |
| http_status                 | 响应状态                                                                        | 同左                             |
| request_id                  | 响应头 `x-si-request-id` / `x-request-id`（查成本用）                           | —                                |
| generation_id               | 响应头 `x-generation-id` 或流里的 `id`                                          | 响应体 `id` 或响应头（查成本用） |
| prompt / completion_tokens  | 流末 `usage`（有就记）                                                          | 响应体 `usage`                   |
| end_reason                  | `completed` 或错误码（`first_token_timeout`、`http_429`、`truncated`…，≤32 字） | 同左                             |
| lane / role / panel_trigger | `status_bar`/`memory_bar` · `primary` · `auto`/`manual`                         | 同左 · `fallback`                |

- 失败（包括 4 秒首字超时被掐掉、拿到输出但校验没过被丢弃）的调用一样记，成本照补。
- 在响应头之前就失败的调用（连接错误、首字前超时且没收到响应头）没有请求号 / generation id，成本记「缺失」；看板单独计数。
- 写入：新文件 `features/generation/panel-call-ledger.ts`，Prisma 原生 SQL，5 秒超时，不 await、失败只记 `panel_llm_call.record_failed`（warn），绝不影响更新。

## 3. 数据库（一个迁移 `20261126_panel_llm_calls.sql`，domain: ops + analytics）

事务内（lock_timeout 5s）：

1. `ops.llm_calls.chat_history_id` DROP NOT NULL（只改元数据）。
2. `llm_calls_lane_check` → 四个值，NOT VALID。
3. 加列 `panel_trigger text`；加 `llm_calls_panel_shape_check`：聊天 lane 必须有 `chat_history_id`、没有 `panel_trigger`；面板 lane 必须没有 `chat_history_id`、`panel_trigger IN ('auto','manual')`。NOT VALID。
4. `analytics.llm_call_costs` 加 `lane IN ('chat','free_zone')`：先比对现行定义（按 11-26 生产原文），已加过跳过，对不上就报错回滚。
5. 新视图（owner 权限，`grafana_cloud` 只授 SELECT，PUBLIC / anon / authenticated 全收回）：
   - `analytics.panel_call_costs`：每次面板模型调用一行 —— 北京日期、面板、触发、首发 / 兜底、供应商、模型、是否返回成功、成本状态（已知 / 估算 / 待补 / 缺失）、成本美元（待补和缺失为空）、token。
   - `analytics.panel_refresh_revenue`：每次立即更新扣费一行 —— 北京日期、结果（charged / failed）、扣的星尘、其中通用 / 专项。
     提交后：两个约束 VALIDATE（SHARE UPDATE EXCLUSIVE，不挡读写）；`CREATE INDEX CONCURRENTLY llm_calls_panel_dispatched_idx ON ops.llm_calls (dispatched_at) WHERE lane IN ('status_bar','memory_bar')`；尾检。

坐标：`ops.llm_calls` 新列性质 O、写入模块 generation、同表同生命周期（保留 180 天），读者是看板视图；两张视图在 `analytics`（外部只读出口），跨域读 `ops` / `billing`。registry 同 PR 更新。

## 4. 口径

- 成本 = 面板模型调用在 `ops.llm_calls` 补到的美元成本（OpenRouter 实际花费 / Surplus 买家成本 / 少量估算）。待补的不计入、单独显示「待补 N 次」；查不到的（`unavailable`）单独显示「缺失 N 次」，不当 0。
- 收入 = `status_refresh` 扣费里 charged 的星尘（含专项）。余额不足（failed）只计次数。
- 日界：北京时间（`Asia/Shanghai`）。
- 对照指标「每 1 美元成本换回星尘」= 收入星尘 ÷ 成本美元；只在成本 > 0 时显示。不做任何货币折算。
- 历史：成本从本次发布起才有；发布当天成本是半天的，看板注明。

## 5. 看板（`st-panel-quality` 顶部新增一节，数据源生产只读 PG `fg1oltvmm56v4b`）

时间窗写在标题里、由 SQL 按北京日界取，不跟页面右上角的时间范围（那是给下面 Prometheus 漏斗用的 12/24 小时）。

```
┌ 成本与收入（北京时间按天；成本约 10–30 分钟后补齐）────────────────────┐
│ [今天 模型成本 $] [今天 星尘收入] [今天 每$换回星尘] [今天 收费次数] [成本补齐率] │
│ [近7天 模型成本 $] [近7天 星尘收入] [近7天 每$换回星尘] [近7天 收费次数]           │
├──────────────────────────────────────────────────────────────┤
│ 近 14 天每天模型成本（柱，堆叠：状态栏·自动 / 状态栏·手动 / 记忆栏·自动 / 记忆栏·手动，$） │
│ 近 14 天每天星尘收入（柱，同一时间轴上下对齐；不做双纵轴）                       │
├──────────────────────────────────────────────────────────────┤
│ 近 14 天每天对照表：日期 │ 星尘收入 │ 收费次数 │ 其中专项 │ 模型成本$ │ 自动成本$ │ 手动成本$ │
│                    │ 每次收费更新的平均成本$ │ 每$换回星尘 │ 调用次数 │ 失败调用成本$ │ 待补 │ 缺失 │
├───────────────────────────────┬──────────────────────────────┤
│ 近 7 天成本去哪了（横条）：         │ 近 7 天按模型（表）：                  │
│ 状态栏/记忆栏 × 首发/兜底 × 成功/失败 │ 供应商·模型 │ 调用次数 │ 成本$ │ 平均每次$ │
└───────────────────────────────┴──────────────────────────────┘
```

- 「手动成本」只含手动触发的调用，和收入同口径对照；自动更新的成本是平台补贴，单列。
- 「失败调用成本」= 调用了但没返回可用结果的花费（报错、超时、截断等），对应用户说的「调用了没采用」。
- 每个面板说明里写清口径和延迟。

## 6. 可靠性

- 超时：记账写库 5 秒；成本补查沿用现有任务的超时与次数上限。
- 幂等：每次调用新 uuid，`INSERT` 一次；不重试（丢一行只少记一次成本，日志可查）。
- 并发：无共享状态。
- 降级：记账失败不影响更新；成本查不到记缺失并在看板显示。
- 容量：面板调用每天约数千行，补查任务每轮上限 2000 行 / OpenRouter 60 次 / Surplus 60 次，与聊天共用；当前聊天量下余量充足（发布后看 `llm.call_costs_done` 的 pending 数）。
- 看板查询：走部分索引，只扫近 14 天面板行和 `status_refresh` 扣费行；Grafana 连接上限 1，新增 8–9 个查询、5 分钟刷新。

## 7. 演进与恢复

- 顺序：迁移 TEST → 验证 → 生产 → 后端发布 → 导入看板。迁移只扩展，旧后端不写面板行、不受影响。
- 停止条件：记账写入报错率高、补查任务 pending 持续增长、经营核心看板数字变化。
- 回滚：回滚后端即停止写入；视图与约束保留无害。如需清理：DROP 两张视图与部分索引，`DELETE FROM ops.llm_calls WHERE lane IN ('status_bar','memory_bar')` 后再恢复 lane 约束与 NOT NULL。

## 8. 拒绝的方案

- 单独建一张面板调用表：违反 CONTRACT 规则 4，且要复制一套成本补查。
- 挂到锚点轮次的 `chat_history_id` 上：会被经营核心按轮次算进聊天成本，还得改 `refresh_core_daily`。
- 用 Prometheus 记成本：成本要事后补查，指标没法回写。
- 把星尘折成美元或反过来：用户明确不要折算现金；给比值让负责人自己判断。
