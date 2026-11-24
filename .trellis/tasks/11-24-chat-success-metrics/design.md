# 设计：聊天成功率指标

## 复用调研

- 指标出口复用 `lib/engineering-observability.ts`（OTel → Grafana Cloud Prometheus，生产已在推 `st_generation_results_total` 等）；`identity()` 给出 `platform`、`model` 标签并限基数。
- 不复用 `st_generation_results`：它按交付模型记、没有首发视角、没有拒答识别，也不区分兜底救回。
- 不走 SQL 视图：Grafana 的只读库账号看不到 `ops`/`experience`，要新迁移 + 授权，且每次刷新都扫正文判拒答；时序指标实时、不压生产库。代价：没有上线前的历史。
- 拒答判定复用 `stream-pass.ts createRefusalDetector` 与 `chat-recovery-config.ts`（进程内缓存）。

## 实现

- `turn-outcome.ts`：`TurnFacts`（胜出一路、首发各路结束原因、出字后结束方式、是否重写成功）、`classifyTurn`（纯函数，口径见 prd）、`recordChatTurn`（读缓存配置判拒答 → `observeChatTurn`）。
- 事实收集：`generation-dispatch.ts`（`onCallSettled` 记首发各路结束原因；竞速后记胜出 role）、`generation-stream.ts`（`consumeStream` 记结束方式与是否救回）、`execute.ts`（只在有首字竞速的轮次创建 facts，finally 里 `void recordChatTurn`）。
- 指标：`st_chat_turns_total{platform, model, lane, outcome, primary_outcome, rescue}`，platform/model 为首发（用户所选模型对应的首发）。一轮一条。基数：3 平台 × ≤64 模型 × 2 栏目 × 5 × 5 × 3，实际组合远少于此。

## 看板（`docs/grafana/st-chat-success.json`，uid `st-chat-success`）

- 变量：`lane`（全部/chat/free_zone）、`fail_type`（全部=error|interrupted|refused|timeout，或单类）。
- 行 1：大盘用户成功率（stat）+ 用户成功率时序；视图 1：每个模型用户失败率（横条，按失败率排序）+ 救回构成。
- 行 2：视图 2 横向堆叠柱（首发失败率按类型分色，受 `fail_type` 过滤）｜视图 3 明细表（调用数 + 四类 + 总失败率，阈值着色）。
- 所有比率用 `increase(...[$__range])`，instant 查询。

## 可靠性

- 计数在内存累加、由现有 exporter 周期推送；推送失败已有 `st_telemetry_failures` 自监控。
- `recordChatTurn` 不阻塞返回，异常吞掉；配置读不到时不判拒答（只影响拒答率偏低）。
- 进程重启计数归零：Prometheus `increase` 自动处理计数器重置。

## 演进与恢复

- 纯新增指标，无迁移；回退 = 回退后端版本，看板无数据。
- 口径调整只改 `classifyTurn` 与看板说明。
