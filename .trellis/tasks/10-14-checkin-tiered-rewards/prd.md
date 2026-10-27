# 签到分档与 VIP 绝对额配置

## Goal

将每日签到奖励改为可运营配置的三档策略：VIP 发放绝对总额；非 VIP 按注册天数分新用户/老用户两档；旧「全员基础签到」配置保留但默认 0 且发奖不再读取。

## Requirements

- VIP：每日签到发放 Admin「VIP策略」配置的绝对星尘额（默认 150），不再是基础+加成。
- 非 VIP 且注册 ≤14 天：发放 `miniapp_checkin_new_user_credits`（默认 60）。
- 非 VIP 且注册 >14 天：发放 `miniapp_checkin_veteran_credits`（默认 15）。
- 注册天数以 `app_core.users.created_at` 为准：`floor((now - created_at) / 24h)`；14 天阈值写死。
- 旧键 `miniapp_daily_checkin_bonus_credits` 保留可编辑（不下架），默认/已发布改为 0，发奖与预览不读。
- 签到功能本身不下架；钱包 checkin API 三分字段保持 `base + vip = reward`。
- VIP benefits / 前端文案改为绝对额主表达。

## Acceptance Criteria

- [ ] Admin 可配置 VIP 绝对额、新用户档、老用户档；旧基础键仍可见且默认为 0。
- [ ] `claim_daily_checkin` 与预览口径一致：VIP / ≤14 / >14 三档正确。
- [ ] VIP 领取：`base=0`，`vip=绝对额`，`reward=绝对额`。
- [ ] 非 VIP：`base=分档额`，`vip=0`，`reward=分档额`。
- [ ] 前端 VIP/充值相关文案不再写「基础+额外加成」。
- [ ] 受影响包 typecheck 与既有相关测试通过。

## Notes

- 已发布的旧 `vip_checkin_bonus_config` object 统一迁移为 `150`，不按旧 base+bonus 换算。
