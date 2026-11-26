# 状态栏 / 记忆栏成本与星尘收入对照看板

## 背景

2026-11-26 起「立即更新」所有人每次 6 星尘（任务 11-26-status-refresh-stardust）。用户（项目负责人）要在 Grafana `st-panel-quality` 页面上，每天对照状态栏和记忆栏的模型成本与星尘收入。

## 用户要求（2026-11-26）

- 成本侧：状态栏、记忆栏调用的所有模型都计入，首发和兜底都算，调用了但没被采用的也算（比如报错、超时、输出不合格被丢弃的）。重点是记全；延迟几分钟可以接受。
- 收入侧：消耗的星尘数，不折算成现金。
- 能实时看到每天的对照情况；可视化形式由我们定，要直观，方便项目负责人看。

## 现状

- 状态栏 / 记忆栏的模型调用（`features/generation/status-bar-model.ts`）没有记进 `ops.llm_calls`，也没有任何成本数据；Prometheus 只有调用次数（`st_panel_attempts_total`），没有成本。
- 收入在 `billing.usage_charges`（`kind = 'status_refresh'`），11-26 发布起才有。
- Grafana 生产只读账号 `grafana_cloud` 只能读 `analytics` 下的视图。

## 需求

- R1 每次状态栏 / 记忆栏模型调用（自动、手动，首发、兜底，成功或失败）在 `ops.llm_calls` 记一行：`lane = 'status_bar' | 'memory_bar'`，`role = 'primary' | 'fallback'`，触发方式 auto / manual，供应商、模型、发出时间、HTTP 状态、结束原因、能拿到的请求号 / generation id 与 token 用量。记账失败只记日志，不影响更新。
- R2 成本由现有 `call-costs` 任务（每 10 分钟）事后补齐：OpenRouter 按 generation id 查实际花费，Surplus 按请求号查买家成本。查不到的记为「成本缺失」，在看板上单独显示，不当 0 混进去。
- R3 这些调用不能混进聊天的每轮成本：经营核心看板（`analytics.refresh_core_daily`）和每轮成本视图（`analytics.llm_call_costs` / `llm_turn_costs`）保持原口径。
- R4 `analytics` 新增两张给看板读的视图：模型调用成本明细、立即更新收入明细，只授 `grafana_cloud` 读。
- R5 `st-panel-quality` 顶部新增「成本与收入」一节（见 design.md §5），按北京时间每天对照，5 分钟刷新。

## 不做

- 建卡 / 工具箱里「AI 帮写状态栏」的调用（DeepSeek 官方 + OpenRouter）不计入：它是作者编辑模板的工具，不是状态栏 / 记忆栏的更新调用，且 DeepSeek 官方接口没有可查的单次花费。需要时另做。
- 会话长期记忆（`story-memory` 压缩）不是记忆栏，不计入。
- 不回填历史：成本从本次发布起才有；收入从 11-26 立即更新收费上线起。
- 不把星尘折算成现金，也不把美元折成星尘；只给「每 1 美元成本对应多少星尘收入」这个比值，方便按自己的汇率判断。
- 不加告警。

## 验收

- A1 发布后生产每次状态栏 / 记忆栏模型调用都在 `ops.llm_calls` 有一行；条数与 Prometheus `st_panel_attempts_total` 同期增量一致（允许进程重启丢失的少量差异）。
- A2 30 分钟内这些行的 `cost_source` 被补上；补不上的计入「成本缺失」。
- A3 经营核心看板与聊天每轮成本视图的数值不受影响（发布前后同一天口径一致）。
- A4 看板新一节能看到：所选时间范围的总成本 / 总收入 / 每美元换回星尘 / 成本记录完整度；每天的成本（按状态栏 / 记忆栏 × 自动 / 手动堆叠）与收入对照图；每天对照表；按首发 / 兜底、是否被采用、模型拆开的成本。
- A5 `grafana_cloud` 只能读两张新视图，读不到 `ops` / `billing` 原表。
