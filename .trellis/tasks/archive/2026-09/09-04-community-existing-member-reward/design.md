# 技术设计

## 状态与契约

- 在 `CommunityClaimStatus` 增加 `existing_member`。
- `/api/community/entry` 将 exclusion 基线映射为 `existing_member`，`unclaimed` 仍表示没有 claim 且不在既有成员基线中。
- 前端只在 `existing_member` 且未领奖时显示手动验证按钮。

## 发奖路径

- webhook 自动路径保持现状：只有活动开始后的非活跃→活跃成员事件生成 eligible receipt，并携带 `telegram_update_id` 调用 RPC。
- 手动路径先调用 Telegram `getChatMember` 确认当前有效成员，再确认用户属于 exclusion 基线，随后以空 `telegram_update_id` 调用同一原子 RPC。
- 新迁移允许 claim 的 `telegram_update_id` 为空，并更新 RPC：
  - 非空 update ID：仅接受 eligible receipt，且继续拒绝 exclusion 用户；
  - 空 update ID：仅接受 exclusion 基线用户；
  - 两条路径共享活动配置校验、claim 幂等锁、钱包入账、流水和通知事务。

## 兼容性与安全

- 不修改迁移 108，新增后续迁移。
- 自动路径参数和行为不变。
- 后端不信任前端状态，手动路径仍实时检查 Telegram 成员身份和 exclusion 基线。
- `(user_id, community_chat_id)` 唯一约束继续保证一次性奖励；空 update ID 不影响自动事件的唯一约束。
