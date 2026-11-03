# 设计

## 复用调研

- `FirstTokenObservation`：继续作为点击时钟与终态唯一来源，扩展 start/迟到首字/网络归因，不新增并行状态。
- `use-conversation-turn`：沿用 `streamError` 与提示条，新增一条软提示；复用现有恢复探测和 `replyStalled`。
- `recordEngineeringMeasurement` + ENUMS 白名单：扩展枚举，不新建遥测通道。
- `forwardWithFirstTokenFallback`/`fallbackProviderPreferences`/`resolveFallbackProviders`：复用，放开同型号阈值并在 execute 决定顺序，不新增路由配置。
- `/health`：现有无库路由，已排除 perf/tracing，复用为保温目标，不新增接口。
- `billing.chat_delivery_billing_gate`、`experience.report_chat_first_token`：既有函数替换，不新增表、索引、cron。对象归属不变（billing/experience）。
- 拒绝复用 `apiClient`：保温不是业务请求，不应进重试、Sentry 和 api 遥测。

## 计费

闸门 recoverable 分支删除“客户端 timed_out/observed 迟到”两个条件；保留 `client_delivery_failed`。回报函数把 `v_delivery_failed` 收窄为客户端转述的服务端失败原因（server/primary/fallback_timeout），`not_visible` 不再写失败、不再释放免费额度。于是部署窗口内旧记录已写入的 `client_delivery_failed=true` 继续免扣，不被改判。`measurement` 的 v4 outcome 不变，`timed_out` 继续表示“6 秒内未提交”，历史可比。

## 前端提示

`expire()` 仍记录 v4 超时，`onTimeout` 改设 `CONVERSATION_SLOW_NETWORK_MESSAGE`。token 提交时既有 `setStreamError(null)` 清除；runTurn finally 清除残留软提示；服务端超时错误走既有分支覆盖为重试提示。请求静默挂起沿用既有 stalled 探测和 130 秒 idle 恢复。

## 连接保温

`lib/api/connection-warmth.ts` 导出 `warmApiConnection()`：25 秒节流、同时只一发、5 秒超时、错误吞掉，用默认 credentials 与聊天 POST 同连接池。`hooks/use-api-connection-warmth.ts` 在聊天页监听 pointerdown/keydown/input/focusin/scroll，记录最后活动并立即尝试保温；每 45 秒定时检查，页面可见且 5 分钟内有活动才发。45 秒低于边缘 60 秒空闲断开。上限约每 25 秒一次，空闲 5 分钟后完全停止。

## 同型号备份

竞争器去掉 `differentModels` 对阈值与预算跳过的限制。execute 的 forward 判定 `model === policy.fallbackModelId`：primary 用 `[A,B]`，fallback 用 `[B,A]`；不同型号时 fallback 仍 `[A,B]`，primary 不变。

## 归因

start 事件新增可选 `server_elapsed_ms`（路由入口到发送 start）。`overhead = start 到达 − server_elapsed`。轮次结束后读该 URL 的 Resource Timing：`setup = requestStart − startTime`（含 DNS/TCP/TLS/排队/预检），`reused = connectStart === connectEnd`。`path = max(0, overhead − setup)`。只有 start 与 RT 都在，且连接是新建的或 60 秒内被保温验证过，才能把 path 判给用户，否则可能是死连接上的停滞，全部算我方。服务端超时先于客户端计时到达时也进入分母并算我方。等待取真实首字（含迟到值）；`wait − path ≥ deadline` 为 `ours`，否则若 `wait ≥ deadline` 为 `user_network`，其余 `on_time`。发出 `roleplay.network` 的 overhead/setup/path 三个 stage，带 `protocol/conn_reused/delay_attribution`。需要 `Timing-Allow-Origin`，SSE 已继承。

## 可靠性

遥测和保温全部 try/catch，不影响聊天；RT 缺失降级为我方。计费并发沿用 FOR UPDATE 和幂等 dedup。竞争仍一个首发、最多一个第二路，总截止共享，败方取消；第二路上游成本只在阈值后产生。

## 演进与恢复

顺序：Backend/Frontend 先发 → TEST 迁移验收 → 生产迁移。应用先发时旧计费规则仍生效，只是少了误报。旧客户端不传新字段，`server_elapsed_ms` 可选。回滚：应用回退安全；计费回滚重放 `20261027_recoverable_chat_delivery.sql` 的闸门与 `20261029_first_token_receipt_recovery.sql` 的回报函数定义，已结算记录不改写。停止条件：发布后充值投诉异常、重复扣费或 5xx 上升即回退。

## 验证

扩展既有单测（`first-token-observation`、`use-conversation-turn`、`first-token-fallback`、`execute`、`grafana`），新增一份 SQL 回归 `tests/first_token_server_delivery_billing.sql` 与保温节流单测（计费与节流边界需要回归锁定）。`bash scripts/test-first-token-fallback-local.sh`、`pnpm -r typecheck`、受影响包 test/lint/build、`pnpm test:ui --grep @chat`。模拟不能替代 TEST 真实扣费与真机网络。
