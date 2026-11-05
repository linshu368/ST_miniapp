# 第三方模型限流与额度飞书告警

## Goal

在现有飞书告警 outbox/投递链路上：

1. 覆盖 OpenRouter、Venice 聊天上游的账户阻断类**响应式**告警（429 / 402 / 401 / 403）。
2. **主动**轮询 Venice `billing/balance`，当 **`balances.usd`（null→0）&lt; $10** 时飞书告警，余额恢复后 recovered。

两类告警均不得带入第三方响应正文、提示词、用户信息或 API key。

## Background

- 响应式观察点：`features/generation/execute.ts` → `provider-alerts.ts`，复用 `features/alerting`。
- 飞书投递常驻服务：`stminiapp-payment-alert-monitor`（约 60s/轮：支付规则 + `deliverOne` + advisory lock）。
- Venice：`GET /api/v1/billing/balance` 需 Admin API Key；`balances.usd` 为 null 表示无可花美元。
- 判定口径（已确认）：**仅 `balances.usd`**，不含 diem / bundledCredits / earnedCredits。
- 原设计曾拒绝余额轮询；本需求改为在现有 monitor 轮次内挂载，不新建 Railway 服务/告警表。

## Requirements

### A. 响应式上游 HTTP 告警

- 观察统一聊天 LLM 出口每一次真实上游响应（首发、首字兜底、非流式）。
- `429`→限流；`402`→额度/消费上限；`401/403`→凭据/访问受阻。
- 复用 `features/alerting` 与 `FEISHU_ALERT_WEBHOOK_URL`；卡片仅环境、provider、模型、类别、HTTP 状态。
- 不阻塞生成/SSE/计费/兜底；同事故去重；成功可 recovered 后再触发。
- 支付域飞书抑制不变；放行 generation 域通知（含 P0/P1/recovered）。

### B. Venice USD 余额主动告警

- 在 `payment-alert-monitor` 每轮调用 `GET {base}/billing/balance`（经 `veniceFetch`），明确超时、有限重试（仅网络/5xx）。
- 鉴权复用 Backend `VENICE_API_KEY`（运维必须使用可调 billing 的 **Admin** Key；401 时跳过并记脱敏日志，不新增必选 env）。
- 当 `coalesce(balances.usd, 0) < 10` 时 firing；`>= 10` 连续健康满恢复防抖轮次后 recovered。
- 稳定 fingerprint：`{env}:generation:venice:balance_low`；severity **P1**（预警）；`domain=generation`。
- 卡片可含阈值、当前 USD（或 `balance_usd_cents` count 指标）、`canConsume`；禁止完整 body / key / 用户会话。
- 探针失败：不发 healthy、不关闭已有 balance_low；不影响同轮支付监控与 outbox。
- 无 key / 无 webhook：跳过余额检查，heartbeat 标明 skipped。
- 不新增 migration、独立 cron 服务、第二套飞书客户端。

## Acceptance Criteria

### A

- [ ] 429/402/401/403 分别产生合法可投递 evaluation；其它状态不误报。
- [ ] 同事故不刷屏；恢复后再失败可再告警；成功路径不等待告警。
- [ ] 首字竞争失败 attempt 也被观察。
- [ ] generation 通知经 delivery worker；支付抑制不变。
- [ ] 卡片/日志无正文、prompt、key、用户/会话 ID。

### B

- [x] `balances.usd`（null→0）&lt; 10 时一条 generation 飞书 firing；持续低于不刷屏（publisher 去重）。
- [x] `usd >= 10` 且满足恢复防抖后 recovered。
- [x] 探针失败不关闭 balance_low，不阻塞支付监控与 outbox。
- [x] 未配置 key/webhook 时跳过余额检查，支付链路可用。
- [x] typecheck、相关单测、复杂度检查通过；运维文档写明 Admin Key 与挂载点。

## Out of Scope

- OpenRouter 余额轮询；Venice 自动充值；按 diem/credits 合计阈值。
- 新建 Railway 余额服务、告警表、第二套飞书客户端。
- 用错误响 message 做分类。

## Key Decisions

| 决策     | 选择                                                       |
| -------- | ---------------------------------------------------------- |
| 余额口径 | 仅 `balances.usd`（null→0）                                |
| 阈值     | `$10`                                                      |
| 挂载点   | 现有 `payment-alert-monitor` 轮次                          |
| 严重级别 | P1（预警）；硬 402 仍由响应式 P0 覆盖                      |
| 密钥     | 复用 `VENICE_API_KEY`（须 Admin）                          |
| 指标单位 | `balance_usd_cents` 用 `count`，不扩 AlertMetric unit 枚举 |

## Android/iOS 性能 P95 门禁

- 页面/同步接口：无新增。模式 `not_applicable`（旁路 cron + 生成路径异步观察）。
- 发布后核对 generation P95、monitor heartbeat、探针失败日志与未处理 rejection。
