# 技术设计

## 复用调研

| 资产                                                                         | 结论                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `features/generation/execute.ts` + `provider-alerts.ts`                      | 响应式 HTTP 分类与进程内事故状态；继续作为 429/402/401/403 唯一挂点                  |
| `features/alerting/{publisher,repository,delivery-worker,feishu-alert-sink}` | 共享信封、事故合并、outbox、限速；余额与响应式共用                                   |
| `scripts/payment-alert-monitor.ts`                                           | 现成 60s 轮次 + advisory lock + `deliverOne`；**余额探针挂这里**，不新建服务         |
| `PaymentAlertMonitor` / `PaymentAlertRules`                                  | 模式参考（snapshot→evaluate→publish→恢复防抖）；支付事件表不适合余额，另建纯函数规则 |
| `veniceFetch` + `config.venice`                                              | 出站与 baseUrl/apiKey；billing GET 复用                                              |
| `lib/engineering-observability` / Sentry bridge                              | 不作为余额或 HTTP 分类触发源                                                         |

## 架构

```
[API] execute.forward ──observe──▶ LlmProviderAlertObserver ──publish──▶ outbox
                                                                         │
[Worker] payment-alert-monitor loop                                      │
           ├ PaymentAlertMonitor.runOnce                                 │
           ├ VeniceBalanceMonitor.runOnce ──publish──────────────────────┤
           └ AlertDeliveryWorker.deliverOne ◀────────────────────────────┘
```

### A. 响应式（既有）

1. `classifyProviderAlert`：429 / 402 / 401|403。
2. 限流按 provider+model；额度/访问按 provider。
3. 异步、同 key 串行、失败冷却；不读非 2xx body。
4. fingerprint 含 `:generation:`，delivery 不抑制。

### B. Venice USD 余额（本扩展）

新增 `features/generation/venice-balance-alerts.ts`（或 `features/alerting` 旁的 generation 子模块，优先放 generation 以靠近 venice 配置）：

1. **Fetcher**：`GET ${baseUrl}/billing/balance`，`Authorization: Bearer ${apiKey}`，超时（建议 5s），最多 2 次有限重试（仅 abort/网络/5xx）；经 `veniceFetch`。
2. **Parse**：只取 `balances.usd`（非 number 或 null → 0）与可选 `canConsume`；忽略其余字段，不把 raw body 传入 evaluation。
3. **Rule**（纯函数）：
   - `usd < 10` → `state=firing`
   - `usd >= 10` → `state=healthy`
   - 阈值常量 `VENICE_USD_BALANCE_THRESHOLD = 10`（代码常量即可；不做 runtime 开关以免超范围）。
4. **Monitor**（有状态，对齐支付恢复防抖）：
   - 连续 `DEFAULT_RECOVERY_PASSES`（2）轮 healthy 才 publish recovered。
   - firing 用稳定 `evaluation` + publisher 事故合并，重复轮次不刷屏。
   - fingerprint：`{environment}:generation:venice:balance_low`
   - rule_id / rule_group：`venice-balance-low`；severity **P1**；service `llm_generation`。
5. **挂载**：在 `payment-alert-monitor.ts` 持锁回调内，于支付 `runOnce` 之后、`deliverOne` 之前调用；余额失败 catch 后记日志，outcome 可 `partial`，不抛垮整轮。
6. **Skip**：`!apiKey` 或空 baseUrl → skip；publisher/notify 仍由现有 alerting runtime + webhook 控制。

拒绝的过度设计：独立 Railway 服务、新表、OpenRouter 余额、diem 合计、runtime 阈值配置、自动充值、通用多供应商余额框架。

## 可靠性

- 超时/重试：余额 GET 有界；飞书仍靠 worker 3s + 有限尝试。
- 幂等：fingerprint + publisher 转换语义；evaluation_id / producer_run_id 每轮新建。
- 并发：monitor 进程内 advisory lock；跨实例不重复跑完整评估。
- 降级：探针失败 ≠ healthy；不关闭 balance_low；不影响支付与 outbox。
- 可观测性：`venice.balance_monitor.heartbeat|skipped|probe_failed|transition`；禁止记 Authorization 与完整 JSON。
- 与响应式关系：USD&lt;10 的 P1 预警与真实 402 的 P0 `quota_exhausted` 可并存；恢复条件独立。

## 演进与恢复

- 无 migration；Backend 同版本发布 API + payment-alert-monitor 镜像即可。
- 回滚：去掉 monitor 挂载或回滚 Backend；既有 outbox 由 worker 收敛。
- 若生产 `VENICE_API_KEY` 非 Admin：探针 401 → skip/日志；运维换成 Admin Key 后无需改代码。确需 Inference/Admin 分离时再开可选 `VENICE_ADMIN_API_KEY`（非本 MVP）。

## 可验证性

- 纯函数：usd null/9.99/10/10.01、非法 JSON、非 number。
- Monitor：连续低余额只 firing 一次；升到 ≥10 需 2 轮 healthy；探针失败不 recovered。
- Script 集成：mock fetcher 挂进 monitor 顺序，支付失败/余额失败互不阻断。
- 命令：`pnpm --filter @miniapp/backend typecheck`、相关 Vitest、`pnpm lint:complexity`。
- 人工：本地 fake balance + fake publisher；不打真实飞书/Venice（可用一次手工 curl 验 Admin Key）。
