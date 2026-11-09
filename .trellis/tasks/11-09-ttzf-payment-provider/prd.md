# Replace Vexutopia with TTZF payment integration

## Goal

Replace retired Vexutopia with TTZF using the epay API only, as explicitly requested by the user. Preserve credits/VIP purchase, checkout, notification, polling, return, reconciliation and historical order behavior.

## Requirements

- Use the supplied screenshots as the protocol authority and `test.txt` as the local credential source; never copy secret values into source, logs, URLs, task artifacts or fixtures.
- Use `https://ttzf8.com/api/epay/mapi.php` for payment creation; do not implement the native API.
- Fulfil each matching, verified paid order once through the existing atomic settlement boundary. Preserve product snapshots, VIP mixed rewards, balances and ledgers.
- Preserve historical orders and explicitly isolate Vexutopia references from new-provider queries and settlement.
- Keep current frontend DTOs and navigation where possible. TEST and production remain distinct; current scope is local implementation and validation, not production deployment or real-money purchases.

## Acceptance Criteria

- [ ] Epay form creation uses appId as pid, server-owned product/amount, client IP, mobile device, callback/return URL and the documented uppercase MD5 signature.
- [ ] Validated HTTPS checkout URL and provider transaction ID are persisted before checkout is returned.
- [ ] Signed GET notifications validate application, order, transaction, channel, exact amount and payment state; only TRADE_SUCCESS grants benefits.
- [ ] Duplicate/concurrent confirmations cannot double-fulfil. Durable success/duplicate acknowledgement is success; retryable failures do not falsely acknowledge completion.
- [ ] Browser return is navigation plus authoritative query, never proof of payment.
- [ ] Query uses the documented epay endpoint with credentials kept in the POST body; actual provider support must be verified before release.
- [ ] Missed notifications, early notifications, late payments, write failure and unknown creation outcomes have recoverable paths.
- [ ] Reconciliation has bounded calls/concurrency/deadlines and fair processing. Failed queries never imply paid or confirmed unpaid finality.
- [ ] Main backend, reconcile worker, expiry Cron and inherited alert-process config are updated together; obsolete Vexutopia operational paths are removed.
- [ ] Existing applicable tests/checks and approved targeted security/protocol regressions pass; real provider/phone/P95 gaps are stated separately.

## Android/iOS 性能 P95 门禁

- 受影响页面：`/profile/recharge`, `/profile/recharge/:orderId`, `/vip`。
- 受影响接口：建单、订单详情、回跳、新供应商通知。
- Android 页面加载 P95：基线 null（无可见样本）；目标 3000 ms。
- iOS 页面加载 P95：基线 null（无可见样本）；目标 3000 ms。
- 接口 P95：基线 null（无可见样本）；建单目标 3000 ms，详情单独目标 1500 ms。
- 数据来源与观测窗口：核对现有页面就绪遥测是否覆盖上述页面，结合后端请求/Pino耗时；发布前可见基线与发布后至少7天同版本、同路由、同平台比较；每组少于100条标低样本。
- 发布后分别验收 Android/iOS 真实支付唤起、返回与页面就绪。目标是规划值，不能用 mock、调用超时上限或零值冒充实测。

规划完成后同步填写 `task.json.meta.mobile_performance`：有影响使用 `required`，确实不影响移动端页面加载和接口性能时使用 `not_applicable` 并填写具体理由。门禁未完成时 `task.py start` 会阻断。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design, `implement.md` for execution planning, and `task.md` for the executable task breakdown before `task.py start`.
