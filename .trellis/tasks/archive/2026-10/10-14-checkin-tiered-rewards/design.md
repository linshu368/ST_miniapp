# Design: 签到分档与 VIP 绝对额

## 复用调研

| 资产                                                 | 结论                              |
| ---------------------------------------------------- | --------------------------------- |
| `billing.grant_bonus_credits`                        | 复用，仍为唯一加 bonus 入口       |
| `miniapp_features.claim_daily_checkin`               | 扩展替换，权威发奖                |
| `vip_checkin_bonus_config` + Admin VIP 策略草稿/发布 | 复用键名，值类型改为非负整数      |
| `miniapp_daily_checkin_bonus_credits`                | 保留 Admin，发奖不读              |
| `quoteDailyCheckinReward` / `readVipBenefits`        | 改口径对齐 RPC                    |
| 新建通用框架                                         | 拒绝；仅两档新 runtime_config key |

## 配置与发奖

```
if vip_active:
  reward = vip_checkin_bonus_config  # absolute int, default 150
elif floor((now - users.created_at)/86400) <= 14:
  reward = miniapp_checkin_new_user_credits  # default 60
else:
  reward = miniapp_checkin_veteran_credits  # default 15
```

响应：VIP → `(0, reward, reward)`；非 VIP → `(reward, 0, reward)`。

## 可靠性

- 超时：沿用现有 RPC/配置读取。
- 重试：签到去重靠 `daily_checkins` 唯一约束，不可盲目重试发奖。
- 幂等：同日二次 claim 仍 409。
- 配置损坏：VIP 绝对额 fallback 150；分档缺失 fallback 各自默认；旧基础键忽略。
- 可观测：metadata 记录档位、配置 version。

## 演进与恢复

- Migration 一次性改 validator + RPC + seed；旧 object 配置强制写成 150。
- 回滚：保留旧 migration 文件可反向 REPLACE 函数（需运维执行）；代码侧需同步回滚。
- 灰度：配置发布即生效；已领取当日不重算。

## 可验证性

- Unit：shared helper、checkin-reward、vip-status、admin form。
- SQL scenarios：T3 / T3a 期望值更新。
- 人工：Admin 改三档发布后，三类用户预览=领取。
