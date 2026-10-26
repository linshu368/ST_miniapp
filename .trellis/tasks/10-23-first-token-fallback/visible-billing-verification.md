# 超时轻提示与无字零扣费验证（2026-10-26）

用户要求：超时温柔提醒；用户未看到首 token 绝不扣星尘。随后明确授权“改好直接发布到时候”，覆盖本次修复的提交、推送和发布。

## 实现与边界

- 超时统一“这次回应稍慢，再试一次吧”，灰色文字、无红色警告框/图标、polite 通告与重试入口。
- 新轮 requires_visible_token 开启交付确认：未回报 pending；超时/not_observed 或服务器预算加 15 秒仍缺报为 waived。没有看到的轮次不先扣再退。
- charge/free-quota 数据库闸门共享请求锁；原价/权益/成功完整条件仍保留。零费用终态不可重开；后台 sync 不把 pending 当结算完成。
- 客户端回报丢失可能使实际看到的轮次免费，这是保守的收入损失，不推断为可收费。旧轮政策不追溯修改。
- stage_budgets 已先在 TEST apply，源文件保持不可变。生产必须先有支持 pending 的后端，再激活 visible_billing 迁移，避免旧后端提前写 settled_at。

## 已完成的本地验证

- Backend 全套：99 文件、861 测试通过；包含新增 apply/settle/sync pending 回归。最后相关 56 测试再验。
- Frontend 全套 378：376 先通过，2 个旧文案断言更新后所在 hook 文件 23 测试通过；Shared 177 通过。
- 全 5 包 typecheck、Frontend/Admin production build、imports/legacy/migration lint、diff check 通过；build 只有既有 img/大 chunk 提示。
- `bash scripts/test-first-token-fallback-local.sh`：PG17 迁移重复执行、真实 PostgREST 4 测试、Grafana v1/v2 查询、身份与首次回报不可覆写通过。
- 新真实 PG 测试：server stop 未显示零扣费 pending；7.2 秒确认显示后原价 30 且重复只一次；pending→客户端超时零费用；timeout 后 observed 重放不改结论；missing 超过宽限零费用且晚到不重扣；服务端 fallback 超时零费用；免费 pending 不消耗、超时释放、正常可见只消费一次、缺报释放；并发报告/结算无 debit。
- 同一 harness 的既有 T2/T3/T4/T3A/T6/T5 钱包/VIP/退款测试与 migration ledger 协议通过。
- 代码和模拟浏览器验证不等于真实 Telegram WebView；远端 TEST/部署/配置/看板结果在发布记录中单独记录。

日志保存在 /private/tmp/st-visible-*.log；不含生产业务行或密钥。

超时回报与免费预留释放原子提交，立即重试仍可使用原有免费次数，不等待 30 秒 sync。增量文件 `20261026_first_token_receipt_quota_release.sql`，因 visible_billing 已在 TEST apply，不修改已执行迁移。
