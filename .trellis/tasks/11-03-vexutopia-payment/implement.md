# Implement：支付供应商替换为 Vexutopia

## 执行顺序

1. **网关适配器**：新增 `VexutopiaPaymentGateway`（建单、查单、Webhook 验签、错误分类、有限重试）。导出 `PaymentGateway` 接口类型，供用例和 cron 依赖接口而非具体类。
2. **配置**：`platform/config.ts` 的 `payment` 段替换为 Vexutopia 字段，并加环境标签。
3. **下单**：`RechargeUseCase` 增加金额范围校验、写交易号；仓库增加 `attachProviderTransaction`（条件更新）。
4. **查单与对账**：`reconcileWithGateway`、`FastPaymentReconciliation`、`ExpirePaymentOrders` 改为传订单行；无交易号的订单跳过（skipped / `missing_provider_ref`），不计入失败率。
5. **路由**：删除 `/webhook/zqpay`（GET/POST）和表单解析器；新增 `/webhook/vexutopia`（子插件 + 原始 body）；`/return` 改为只导航 + 一次查单。
6. **脚本**：删除 `diagnose-zqpay-query.ts` 和对应 npm script；新增 `payment:webhooks`（list/register/delete）。
7. **删除** `ZqPaymentGateway.ts` 及其测试，清理所有引用。
8. **部署与文档**：`.env.example`、`.env.compose.example`、`ops/env/backend.env.production.example`、`railway-pr-env.yml`（去掉 NOTIFY 注入）、`ops/railway/README.md`、`README.md`、`docs/ARCHITECTURE.md`、`.trellis/spec/backend/app/architecture-and-files.md`、`wallet-payment` 各 spec 同步。

## 测试

按 AGENTS.md，支付属于高风险改动。现有测试会跟着改：

- `ZqPaymentGateway.test.ts` 删除，改为 `VexutopiaPaymentGateway.test.ts`：验签（正确/篡改 body/错 secret/超时/格式错）、建单请求形状与幂等头、错误码到分类的映射、重试只发生在可重试分类且最多 1 次、`checkout_url` 非 https 拒绝、查单状态映射、metadata 不符拒绝。
- `routes/payment.test.ts`：Webhook 401/400/200（他环境、非 completed、订单不存在、金额/币种不符）/500（结算失败）、成功入账；回跳不入账只导航。
- `RechargeUseCase.test.ts`：金额越界拒绝、写交易号失败时订单标 failed 且不返回 `pay_url`。
- `FastPaymentReconciliation.test.ts` / `ExpirePaymentOrders.test.ts`：无交易号订单跳过且不计入失败、不阻断过期。

这些都是对现有测试文件的修改或替换；唯一新增测试文件是新网关的单测（替代被删除的旧网关单测）。

## 验证命令

```bash
pnpm --filter @miniapp/backend exec vitest run src/infrastructure/payment src/routes/payment.test.ts src/features/payment
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter @miniapp/backend build
git grep -n -i -E 'zqpay|ZqPayment|子千易|716faka|PAYMENT_MERCHANT|PAYMENT_PLATFORM_PUBLIC_KEY|PAYMENT_NOTIFY_URL' -- ':!.trellis/tasks/archive' ':!.trellis/tasks/11-03-vexutopia-payment'   # 期望无结果
```

## TEST 环境人工验收（需用户手机真实支付）

| 场景          | 步骤                                            | 期望                                                                    |
| ------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| 支付宝 × 星尘 | 选最低价星尘套餐 → 支付宝付款                   | 一次到账，`settled_by=webhook`，钱包流水一条                            |
| 微信 × VIP    | 选周卡 → 微信付款                               | VIP 延长一次，专项星尘一次                                              |
| 查单兜底      | 临时清空 TEST `VEXUTOPIA_WEBHOOK_SECRET` 后付款 | Webhook 401，轮询页或 cron 查单入账，`settled_by=query` 或 `cron`       |
| 重复投递      | 对已完成交易调用 `resend-webhook`               | 200，不重复入账                                                         |
| 取消/返回     | 打开收银台后直接返回 MiniApp                    | 订单保持待支付，可继续付款；过期后显示已过期                            |
| 他环境事件    | 生产端点收到 TEST 订单事件（看生产日志）        | 200 + `foreign_environment`，无告警                                     |
| 子交易确认    | 支付后 `GET /payments/<tx>`                     | 记录真实返回状态（completed 还是 cancelled），决定设计第 6.1 项是否要补 |

## 本地验收系统

完整支付流程涉及真实供应商，`packages/ui-tests` 的模拟场景不能替代真实支付验收。建议把“收银台打开 → 返回 → 订单结果页”的前端状态扩展到现有 `@profile` 充值场景里（模拟后端返回 Vexutopia 风格 `pay_url`），这一步不在本任务范围内，收尾时提醒工程师。
