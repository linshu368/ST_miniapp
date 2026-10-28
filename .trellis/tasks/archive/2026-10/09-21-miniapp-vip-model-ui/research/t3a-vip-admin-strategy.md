# T3A VIP 策略 Admin 需求补丁

日期：2026-09-22。证据范围：当前 `dev_vip_0920` 仓库与正式 test 项目 `zoqelpfhurwehlvypryl` 的只读配置查询。未读取业务行，未修改 test/Production。

## 1. 已确认纳入 Admin

Admin 新建业务 tab“VIP策略”，纳管：

1. VIP 购买总开关 `vip_purchase_enabled`。
2. VIP 到期提醒开关 `vip_reminders_enabled`。
3. 周卡/月卡价格。
4. 周卡/月卡有效天数。
5. 月卡赠送专项星尘。
6. VIP 文本折扣率。
7. 周卡/月卡标题、说明和角标。
8. VIP 签到加成模式：与当次基础奖励相同，或独立固定数值。
9. 语音与 basic 图片各自的免费成功次数。

首次 seed 必须保持当前行为：两个开关 false；周卡 1399 分/7 天/0 赠送；月卡 2888 分/31 天/3000 专项星尘；折扣率 0.95；签到为 `same_as_base`；voice/basic_image 上限均为 3。

## 2. 明确不纳入本次

- 到期提醒提前天数、提醒文案与 `Asia/Shanghai` 时区保持固定。
- 语音价格、计费开关与提示文案待产品复核后另定。
- 高级图片完整配置尚不存在，待产品复核后另定；不得用 basic 配置冒充 advanced。
- 钱包策略、VIP 有效判断、幂等、退款、提醒去重、数据库权限不是运营配置。

## 3. 当前实现差异

- `vip_purchase_enabled` / `vip_reminders_enabled` 已在 `app_core.runtime_config`，但 T2 migration 明确未纳入运营 UI，Admin managed-key 列表也没有这两个 key。
- 周/月商品条款与 0.95 折扣当前是 Shared/Backend 常量，`VipPlanSchema` 还会拒绝不同条款。
- 签到 RPC 当前把 VIP 加成固定为基础奖励同额。
- `FEATURE_FREE_TRIAL_LIMIT=3` 是 Shared literal；`billing.feature_free_trials.ordinal` 也受 1..3 CHECK 约束。
- Admin 已有成熟的 managed config 草稿、发布、版本、回滚和环境切换能力，应扩展现有路径，不新建直写 `runtime_config` 的旁路。

## 4. 最小配置拆分

- 复用：`vip_purchase_enabled`、`vip_reminders_enabled`。
- 新增：`vip_plans_config`、`vip_text_discount_rate`、`vip_checkin_bonus_config`、`feature_free_trial_limits`。
- `vip_plans_config` 固定只有 week/month；week bonus 固定 0，month bonus 可配置。
- `feature_free_trial_limits` 分别保存 voice/basic_image，不能合并成一个共享计数。

## 5. 演进与恢复

T2/T3 migration 已在 test 应用。T3A 只能新增 forward-fix migration：seed/纳管 key、扩展数据库发布校验、演进 ordinal 约束和相关 RPC。不得修改或重放已应用的 `20260921_*`、`20260922_daily_checkin_vip_bonus.sql`。

商品配置在创建订单时固化；折扣在生成受理时固化；签到在一次原子领取内读取同一配置版本；免费上限在 reservation 事务内读取。配置回滚只影响后续业务，不改历史订单、会员、ledger、签到或免费消费事实。

配置异常时购买/提醒 fail closed；其他字段回退首次 seed 同款默认并记录安全日志。错误发布先回滚配置版本并关闭购买，不手工修改历史订单或钱包。

## 6. 已收口的免费次数范围

语音与 basic 图片免费次数分别限制为 `0..20` 的整数，默认均为 3；0 表示关闭对应功能的免费体验。Shared、Admin 与数据库发布校验必须使用同一范围。调低上限不删除历史事实，已使用次数达到或超过新上限时停止新增；调高后从最小可用 ordinal 继续。
