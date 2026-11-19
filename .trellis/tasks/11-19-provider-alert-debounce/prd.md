# provider 告警去抖与 outbox 合并投递

## Goal

一次模型供应商故障在飞书只产生一张故障卡和一张恢复卡；outbox 里同一事故的过期卡片不再按每分钟一张的速度陆续发出。

## Background

2026-11-19 OpenRouter 旧 key 额度耗尽（402），换 key 后新 key 访问 Gemini 返回 403。主请求失败后 first-token fallback 到同一 provider 的其他模型并成功，`LlmProviderAlertObserver` 把这次成功当成恢复，于是每个请求产生"firing + recovered"两张卡。投递 worker 每 60 秒一轮、每轮只发一张，一小时内积压 150+ 张，换 key 之后仍在持续发出 402 卡，造成误判。

## Requirements

- R1 去抖：provider 告警在第一次 402/403/429 时立即触发；只有距该事故最后一次失败满恢复静默窗口（5 分钟）后的成功响应，才判定为恢复。
- R2 合并：worker 领取投递任务前，同一事故（incident_id）且同一 transition、已有更新任务的旧 pending/failed 任务标为 `abandoned`（`last_error_class='superseded'`），并记录数量。不跨 transition 合并，避免支付域被抑制的恢复卡顶掉 P0 故障卡。
- R3 吞吐：每轮最多投递 10 张，继续遵守 `min_delivery_interval_ms`，单轮耗时控制在 60 秒轮次间隔之内。
- 不新增表、列和运行配置；不改支付域抑制策略和告警卡片内容。

## Acceptance Criteria

- [ ] 持续失败（每次间隔不到 5 分钟），期间穿插成功响应，只发出一次 firing；失败停止满 5 分钟后的第一个成功响应发出一次 recovered。
- [ ] 同一事故积压 N 张 firing 和 N 张 recovered 时，一轮之后只剩每类最新的一张需要投递，其余为 `superseded`。
- [ ] 支付域 firing 不会被同一事故的 recovered 合并掉。
- [ ] 一轮最多发送 10 张；遇到 idle、disabled 或 retrying 时提前结束。
- [ ] backend typecheck、相关测试、`lint:complexity`、`lint:backend-logging` 通过。

## Android/iOS 性能 P95 门禁

- 受影响页面：无
- 受影响接口：无（observer 只在内存里比较时间戳，不增加请求路径上的 IO；投递在独立的 payment-alert-monitor 服务中运行）
- 发布后验证：上线后观察飞书群和 `ops.alert_delivery_jobs` 的 superseded/succeeded 分布

## Notes

- 403 根因（新 key 的 OpenRouter Guardrails）不在本任务范围内。
- 静默窗口和每轮上限暂时写成常量，配置化暂缓。
