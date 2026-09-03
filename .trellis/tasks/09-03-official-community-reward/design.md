# 技术设计：官方社群入口与入群奖励

## 1. 方案摘要

采用“Webhook 记录活动期新入群事实 + MiniApp 主动辅助验证 + 数据库原子发奖”：

1. 前端获取官方群配置和当前账户领取状态。
2. 用户从“我的”页打开底部 Sheet，再由同步点击调用 Telegram SDK 打开群链接。
3. Bot 管理员接收 `chat_member` 更新并记录活动启用后的合格新入群事实；用户返回 MiniApp 点击验证时，后端调用 `getChatMember`，同时查询该合格事件。
4. 后端只接受目标群、有效成员状态和可映射的 Telegram user id。
5. 数据库 RPC 以 `(user_id, community_chat_id)` 唯一键，在同一事务写领奖事实、bonus 钱包、wallet ledger 和官方定向通知。

外链打开结果不是入群结果；`getChatMember` 也不提供加入时间，不能单独区分既有成员。身份只用 Telegram 数字 user id；新成员资格来自活动启用后的 Telegram 事件，发奖幂等由数据库唯一约束和事务保证。

## 2. 现有能力与复用点

- `profile/page.tsx` 已有独立 22px 圆角列表；入口插在消息中心和消费明细之间。
- 前端已有 Radix `Sheet`，可使用 `side="bottom"`；服务端数据必须走 `src/lib/api/` React Query hooks。
- Telegram 登录态已通过 `X-Init-Data` 验签，`app_core.users.tg_id` 唯一映射 App UUID。
- `/api/telegram/webhook` 已校验 secret，但当前只处理 message，需要增量扩展，保留原有行为。
- 消息中心已支持 `scope='official' AND user_id=<当前用户>` 的定向官方消息。
- 邀请奖励提供“业务事实唯一键 + 原子 bonus 入账 + ledger”先例；运营赠送提供“钱包 + 通知同事务”先例。

## 3. 模块设计

### 3.1 Shared 合同（先于消费者）

新增 `packages/shared/src/api/community.ts`：

- `CommunityEntryData`：`enabled`、公开 community id、标题/说明、`reward_credits`、`telegram_url`、`fallback_handle`、`claim_status`、`rewarded_at`。
- `VerifyCommunityMembershipData`：`status`（rewarded/already_rewarded/not_member/pending/disabled）、奖励金额、到账时间和钱包 DTO。

不把 Telegram 原始响应或数据库行暴露给前端。

### 3.2 Frontend

- `src/lib/api/community.ts`：入口 query 与主动验证 mutation；到账后失效 wallet、community、notification unread queries。
- telegram lib：新增 `openTelegramCommunity(url)`，优先 SDK `openTelegramLink`，异常时返回可展示兜底的结果；业务页不直调 SDK。
- 推荐拆出 `components/profile/community-sheet.tsx`。
- `ProfileRow` 扩展为 Link/Button 判别联合类型，不使用假 `href`。
- UI 本地状态只表示交互阶段；服务端 `claim_status` 才是领奖真相。
- 打开 Telegram 必须处于用户点击的同步调用栈，不能先 `await`。

### 3.3 Backend

新增 `features/community/`：

- 通过 `platform/runtime-config.ts` 读取开关、奖励、chat id、链接、备用账号；Bot token/secret 不下发前端。
- `CommunityMembershipService` 负责目标群/成员状态过滤、tg id 映射和调用原子 RPC。
- Telegram client 增加 `getChatMember(chatId,userId)`，设置超时和错误归一化；该接口只确认当前状态，不直接生成领奖资格。
- 新增 `GET /api/community/entry` 与 `POST /api/community/verify-membership`，均使用 `requireTelegramAuth` 并带 `@frontend-ready` 注释。
- 扩展 `/api/telegram/webhook` 解析 `update_id/chat_member`，不得重写或简化现有 message 逻辑。
- Webhook 对从未登录 MiniApp 的活动期新成员记录待匹配合格事件，不盲目创建奖励账户；后续登录可主动验证并匹配。

### 3.4 Database

新 migration 放 `packages/shared/migrations/`，业务事实归 `miniapp_features`。

#### `community_reward_claims`

- `id uuid primary key`
- `user_id uuid`，引用 `app_core.users`
- `community_chat_id text`
- `telegram_user_id text`（审计快照）
- `reward_credits numeric check (>0)`
- `source`：`chat_member_webhook | active_verify`
- `telegram_update_id bigint null`
- `notification_id uuid`、`wallet_ledger_id uuid`
- `granted_at timestamptz`
- `unique(user_id, community_chat_id)`：终身一次
- `telegram_update_id` 条件唯一索引：事件重放审计

建议独立 `telegram_update_receipts(update_id primary key, update_type, telegram_user_id, community_chat_id, old_status, new_status, occurred_at, received_at, processed_at, result)`，既避免重放，也保留活动启用后“新入群”的资格事实。

运行时配置增加 `miniapp_official_community_reward_started_at`。只有 Telegram 事件时间不早于该时间、目标群匹配、状态由非成员迁移为有效成员时，才生成合格事件。主动 `getChatMember` 不得绕过这一事实。

#### `grant_community_join_reward` RPC

在单事务中：

1. 校验账户、群标识和金额。
2. 插入 claim 占位；唯一冲突返回 `already_rewarded`。
3. 锁定/创建 `billing.user_wallets`，增加 bonus。
4. 写 `billing.wallet_ledger`：`entry_type='community_reward'`、`reference_type='community_join'`。
5. 写 `miniapp_features.notifications`：`scope='official'`、`category='system'`、定向当前用户。
6. 回填 claim 的 ledger/notification id，返回余额和到账时间。

任一步失败整笔回滚。RPC 固定 `search_path`，仅授权 `service_role/postgres`。

## 4. 数据流

### 页面与跳转

`ProfilePage → GET community/entry → 展示入口 → Sheet → openTelegramLink`

打开动作不调用发奖 API。

### Webhook 实时发奖

`Telegram chat_member → secret/update_id 校验 → chat_id/活动开始时间/状态迁移过滤 → 记录合格事件 → tg_id 查 App 用户 → RPC → 到账+通知`

### 主动补偿

`POST verify（X-Init-Data） → 当前 tg id → Telegram getChatMember + 合格事件查询 → 两者均通过 → RPC → rewarded/already_rewarded`

因为 Bot API 的 `getChatMember` 不返回加入时间，若活动期新入群的 `chat_member` 事件完全丢失，则系统无法在“不误发给既有成员”的前提下仅靠主动查询自动补发。Webhook 应返回可重试状态并保留 update 去重/失败日志；漏事件个案进入后续人工核查范围，本期不提供用户侧人工补发入口。

## 5. 安全、可靠性与日志

- 用户 id 只取签名登录态，不接受前端提交 user id/member=true。
- Webhook secret 恒定时间比较；日志不得输出 token 或完整 initData。
- 只处理配置中的 chat id；配置非法时默认关闭。
- Telegram API 超时/限流不发奖，返回可重试状态。
- DB 唯一键为最终幂等屏障，应用层查询只用于改善响应。
- 结构化日志覆盖 received、ignored、unmatched、not_member、granted、duplicated、failed；错误保留 `{ err }`。

## 6. 运行时配置

- `miniapp_official_community_enabled`
- `miniapp_official_community_chat_id`
- `miniapp_official_community_url`
- `miniapp_official_community_fallback_handle`
- `miniapp_official_community_reward_credits`
- `miniapp_official_community_reward_started_at`
- 可选 JSON 文案配置

Bot token 和 webhook secret 继续使用服务端机密。若配置需运营管理，加入 managed-config 白名单及完整校验链路。

## 7. 测试设计

- Shared：合同合法/非法值。
- Frontend：入口顺序、Sheet、跳转分支、复制兜底、服务端状态、query invalidation。
- Backend：成员状态映射、目标群过滤、关闭配置、未知用户、Telegram 超时、RPC 状态映射。
- Webhook：secret 错误、非目标群、重复 update、member/admin/creator、left/kicked/restricted/pending。
- DB：首次、顺序重放、并发、不同群/用户、失败回滚、claim/wallet/ledger/notification 四方对账。
- UAT：真实测试群加入、申请待审批、审批后到账、待匹配事件后续验证、退群再入群、既有成员拒绝、跳转失败复制。

## 8. 发布与回滚

1. 先部署 migration 和后端，入口开关关闭。
2. 测试群配置 Bot 管理员、allowed updates、chat id 与链接。
3. 完成自动化、测试环境 UAT 和账务对账。
4. 部署前端，生产仍关闭。
5. 经年确认后启用，观察 granted/duplicated/unmatched/failed。

异常时优先关闭总开关并停止新发奖。代码可回滚，但已发奖励、ledger、claim 和通知作为审计事实保留，不做破坏性删除或自动追回。

## 9. 方案取舍

- 不采用“打开群即发奖”：无法证明入群且易作弊。
- 不只依赖 Webhook 自动匹配：事件可先落为待匹配事实，再由用户登录后的主动验证完成账户匹配。
- 不只依赖主动验证：实时体验差且用户未必返回。
- 不把 `getChatMember` 当作漏事件的无条件补偿：它没有加入时间，会误发给活动前既有成员。
- 不复用 `insertUserNotification`：固定 personal 且与钱包非同事务。
- 不直接复用运营赠送 RPC：其幂等语义不是账户+社群。
