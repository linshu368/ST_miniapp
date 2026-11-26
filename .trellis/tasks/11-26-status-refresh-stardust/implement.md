# 执行计划

## 步骤

1. **迁移** `packages/shared/migrations/20261126_status_refresh_charge.sql`（design §3），带尾检与回滚说明。
2. **迁移测试**（计费 + 迁移，按规范需要回归测试）：`scripts/test-status-refresh-charge-migration.sh`，一次性 PG17 容器（`--network none`），用 `fixtures/vip_billing_t2_harness.sql` + `fixtures/chat_reservation_production_functions.sql` 搭出生产形状的钱包、流水、`apply_wallet_debit`、预留触发器，再执行迁移两遍（第二遍必须无变化）。断言：
   - 专项 10 / 通用 0 → 扣 6 全走专项；专项 3 / 通用 10 → 专项 3 + 通用 3；合计 < 6 → `insufficient`，钱包不变，usage_charges 一行 failed。
   - 同一 charge id 调两次 → 只有一条流水，第二次返回 `already_charged`。
   - 聊天预留占住余额 → `insufficient`，预留不被吃掉。
   - 别的用户用同一 charge id → 报错。
   - 旧类型（chat_debit 等）照常能扣；`apply_wallet_debit` 函数体只差白名单一行。
   - anon / authenticated 不能执行新函数。
3. **shared**：`STATUS_REFRESH_CREDITS`；删 `manualUpdate`。
4. **后端**：`StatusRefreshChargeRepository.ts`、`features/generation/status-refresh-billing.ts`（含纯函数 `refreshBillable(...)`）、改 `service.ts` / `template.ts` / `routes/status-bar.ts` / `wallet-spending.ts`、注释。
5. **后端单测**：`status-refresh-billing.test.ts` 只测 `refreshBillable` 的组合（状态 ok/partial/failed/skipped/关着 × 记忆 recorded/no_progress/failed/skipped × 是否撞上进行中）。
6. **前端**：`status-refresh-intro.tsx`（说明卡 + 价格气泡）、改 `chat-status-panel.tsx`、`lib/api/status-bar.ts`、`profile-stardust-balance.tsx`；ui-tests fixture。
7. **文档**：`docs/db/registry.yaml`（usage_charges owner/kind、wallet_ledger owner）、`docs/ARCHITECTURE.md` 状态面板段、`packages/shared/migrations/README` 迁移登记（若仓库有该清单）。

## 验证命令

```bash
bash scripts/test-status-refresh-charge-migration.sh
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test -- status-refresh-billing status-bar
pnpm -r typecheck
pnpm lint
pnpm lint:complexity
pnpm lint:db-contract
pnpm lint:backend-logging
pnpm --filter @miniapp/backend logging:validate
pnpm --filter @miniapp/frontend build
pnpm test:ui --grep @chat
```

## 人工场景（`pnpm preview:ui` 虚构场景 + TEST 真实接口）

- 第一次点 → 说明卡；「先不用」不发请求；再点直接更新；清 localStorage 后又出卡。
- 返回键 / Esc：先关说明卡，再关面板。
- 小问号气泡：点开、点外面关。
- 余额不够 → 底部「星尘不够了 · 去充值 ›」→ 充值页带 `returnTo` 与 `required=6`。
- 失败 → 「这次没更新成功，没扣星尘，再试一次」。
- 夜间 / 白天各看一遍。
- TEST（Railway development，DEV_AUTH_BYPASS）：给内置 dev 用户的会话手动更新一次，核对钱包少 6、钱包明细出现「状态更新」；余额清零后再点返回 402。测完删测试数据。

## 发布

1. 迁移走 GitHub Actions `Database Migration`：TEST `apply` → 上面 TEST 验证 → 生产 `apply`（RUN_PRODUCTION_MIGRATION）→ 生产只读核对约束与函数。
2. 代码 PR（发布分支基于最新 main，只带本任务改动）合入 main，Railway + Vercel 部署完成后核对。
3. 上线后 24 小时：生产只读 SQL 看 `usage_charges` `status_refresh` 的 charged/failed 数、每行 `debit_ledger_id` 都能对上一条 `-6` 流水、没有同会话同秒两条；Railway 日志看 `status_bar.refresh.charge` 的 status 分布。
4. 发布后同步 main → dev。
