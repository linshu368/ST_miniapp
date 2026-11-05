# 实施计划

## 顺序

1. **响应式收尾（若未完成）**：`provider-alerts` 分类/observer、`execute` 挂点、delivery 放行 generation、回归测试。
2. **Venice 余额规则**：纯函数解析 `balances.usd`（null→0）与阈值比较；构建安全 `AlertEvaluation`（P1、`balance_usd_cents` count、fingerprint `…:generation:venice:balance_low`）。
3. **VeniceBalanceMonitor**：有界 fetch（`veniceFetch` + 超时/重试）、恢复防抖、探针失败不 healthy；单测覆盖。
4. **挂载** `payment-alert-monitor.ts`：支付 `runOnce` → 余额 `runOnce`（独立 try/catch）→ `deliverOne`；heartbeat 字段含 balance 结果。
5. **运维文档**：`ops/railway/README.md` 写明余额检查同挂在 payment-alert-monitor、需 Admin Key、阈值 $10 仅看 USD。
6. **验证**：backend typecheck、相关 Vitest、complexity；不新增 migration/secret（除非运维换 Admin Key）。

## 失败路径

| 场景                  | 期望                                       |
| --------------------- | ------------------------------------------ |
| usd=9.99 连续多轮     | 仅首次 firing（事故未恢复前）              |
| usd 从 9 → 10 仅 1 轮 | 不 recovered；第 2 轮 healthy 才 recovered |
| billing 超时/5xx      | 日志 probe_failed；既有 firing 保持        |
| billing 401           | skip/auth_failed 日志；不关闭事故          |
| 无 VENICE_API_KEY     | skip；支付与 outbox 正常                   |
| publisher 失败        | 同支付：记错，下轮可再试                   |

## 验证命令

```bash
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test -- provider-alerts venice-balance delivery-worker
pnpm lint:complexity
```

## 风险文件

- `packages/backend/src/scripts/payment-alert-monitor.ts`（挂载顺序）
- `packages/backend/src/features/generation/provider-alerts.ts`（响应式）
- 新建 `venice-balance-alerts.ts`（建议同目录）
- `ops/railway/README.md`

## Rollback

回滚 Backend 部署或临时在 monitor 注释余额调用；保留 outbox 数据即可。
