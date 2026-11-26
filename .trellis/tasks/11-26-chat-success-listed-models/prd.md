# 聊天成功率看板只看在架模型

## Goal

`st-chat-success` 看板只统计当前在架的模型。下架模型的残留样本（如 `openrouter · x-ai/grok-4.20`、`venice · gemini-3-flash-preview`）调用少、比率乱跳，用户认为是干扰（2026-11-26）。

## 背景与约束

- 看板数据是 Prometheus `st_chat_turns_total{platform, model, lane, …}`，Grafana 拿不到在架名单：只读 PG 数据源没有 `app_core` 权限，Prometheus 里也没有名单类指标。
- 在架会自动变化：畅聊 Surplus 模型连续拒单会被自动下架，看板里手写名单会悄悄过期。用户选定"后端上报名单"。
- 在架 = 本次生成可能路由到的首发模型，与 `st_chat_turns_total` 的 `platform/model/lane` 同口径：
  - `chat`：模型目录 `tiers` 里启用的模型（`provider` + `provider_model_id`）；
  - `free_zone`：畅聊快照 `listed`（候选池上架且有供应商的 Surplus 模型 + 目录「免费畅聊」板块启用的模型），上游用 `freeModelUpstream`。

## Requirements

1. 后端新增 gauge `st_chat_model_listed{platform, model, lane} = 1`，每次导出（15 秒）上报当前名单；标签经同一个 `identity()` 处理，保证和 `st_chat_turns_total` 对得上。
2. 名单读进程内已有缓存（目录快照、畅聊快照 30 秒），不新增查库路径；读失败沿用上一次名单，不影响对话。
3. 看板所有查询（含「模型」变量）在聚合前按 `and on (platform, model, lane)` 只保留名单里的模型；名单取看板时间范围终点（`@ end()`），走势和按小时图也按"现在在架"过滤。
4. README 口径说明、看板内「口径说明」同步。

## Acceptance Criteria

- [ ] TEST 环境发版后 Prometheus 出现 `st_chat_model_listed{deployment_environment_name="test"}`，条目与 TEST 目录/畅聊在架一致。
- [ ] 生产发版后名单与生产目录启用模型 + `features.free_zone_models` listed 一致。
- [ ] 线上看板更新后：grok-4.20、venice·gemini-3-flash-preview 不再出现；在架模型的数字与改前一致（同一时间范围）。
- [ ] 后端 typecheck、相关测试、`pnpm lint:backend-logging` 通过。

## Android/iOS 性能 P95 门禁

不适用，见 `task.json.meta.mobile_performance`。

## 发布顺序

后端先发生产、确认名单指标有数，再推 Grafana 看板；反过来会让看板全空。回滚：看板回滚到 v13（Grafana 版本历史），后端指标留着无害。
