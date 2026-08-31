# Schema 归属地图

> 时间：2026-08-25。姊妹篇：`docs/schema划分专项.md`（miniapp 表盘点与 chat_history 字段审计）。
> 来源：PM 的《数据库模块划分》plan，经 2026-08-25 对 6 处争议表逐一拍板后修订成本文。
>
> **本文档是逻辑归属地图，不是物理迁移方案。** 所有存量表的物理位置维持现状
> （绝大多数在 `miniapp` schema），物理拆分的执行策略见 §5。
> 归属域决定的是：谁拥有这张表、代码评审时按哪个域的规则审、跨域访问走什么通道。

---

## 一、归属域定义与判定标准

| 域                 | 定义                         | 判定                                                                          |
| ------------------ | ---------------------------- | ----------------------------------------------------------------------------- |
| `app_core`         | 跨模块共享的根数据           | 多个领域都把它当成身份或配置基础；**删除任何单个功能，它必须仍然存在**        |
| `miniapp_features` | 具体产品功能产生的状态       | 某个功能开关决定它是否存在；关掉功能，表可以跟着删                            |
| `experience`       | 用户核心互动产生的大体量内容 | 文本对话、语音、（将来的）图片产物                                            |
| `billing`          | 涉及钱、余额、免费权益       | 支付事实、账本、余额投影、LLM 计费、免费额度                                  |
| `admin`            | 运营人员管理和发布           | 现有 `admin` schema，边界不变                                                 |
| `cs_platform`      | 客服、画像和触达             | 现有 `cs_platform` schema，边界不变                                           |
| `acquisition`      | 渠道投放和归因               | **即现有 `miniapp_traffic` schema，名称不改**，边界现状已符合定义             |
| `analytics`        | 只用于看数和计算指标         | **即现有 `miniapp_analytics` schema，名称不改**；红线：不得成为任何运行时依赖 |

`app_core` 与 `miniapp_features` 的一句话边界：
**如果删除某个具体功能后这张表仍然必须存在，它属于 core；如果功能下线表也可以一起删，它属于 features。**

不在地图内：旧 bot 的 `public` / `analytics`（B 类，随 bot 迁出，见瘦身专项 §5）；
Supabase 系统 schema。

---

## 二、存量表归属（miniapp schema 22 表 + 1 视图，物理位置均不动）

### app_core（4 表）

| 表                      | 说明                                                   |
| ----------------------- | ------------------------------------------------------ |
| `users`                 | 用户根实体                                             |
| `miniapp_user_settings` | 用户资料与偏好（users 的 1:1 扩展）                    |
| `characters`            | 角色卡根实体：对话、额度、收藏、排序、运营管理共同引用 |
| `runtime_config`        | 全局 KV 配置                                           |

将来的 `experiment_assignments`（A/B 实验固定分桶）也归此域。

### miniapp_features（6 表）

| 表                                     | 说明                               |
| -------------------------------------- | ---------------------------------- |
| `character_favorites`                  | 收藏                               |
| `character_ranking_scores`             | 大厅推荐排序得分缓存【裁决 5】     |
| `daily_checkins`                       | 签到                               |
| `wish_roles`                           | 许愿池【裁决 3】                   |
| `notifications` / `notification_reads` | 消息中心站内信与已读状态【裁决 4】 |

### experience（3 表 + 1 视图）

| 表                             | 说明                     |
| ------------------------------ | ------------------------ |
| `chat_sessions`                | 会话头                   |
| `chat_history`                 | 逐轮生成日志（核心资产） |
| `current_chat_history`（视图） | 当前版本投影             |
| `chat_message_audio`           | 语音产物元数据           |

### billing（7 表）

| 表                                                                   | 说明                             |
| -------------------------------------------------------------------- | -------------------------------- |
| `payment_orders`                                                     | 人民币/Stars 支付事实            |
| `wallet_ledger`                                                      | 星尘增减的永久账本               |
| `user_wallets`                                                       | 当前余额投影（可从流水重建）     |
| `llm_usage_charges` / `llm_usage_charge_dedup`                       | LLM 计费明细与幂等墓碑【裁决 1】 |
| `character_free_chat_quotas` / `character_free_chat_quota_decisions` | 免费权益余量与判定审计【裁决 2】 |

三张钱表的口径纪律：**支付金额以订单为准，星尘变动以流水为准，钱包余额只是可重建的当前状态。**

### cs_platform 域（2 表，物理仍在 miniapp）

| 表                                           | 说明                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `support_conversations` / `support_messages` | 客服会话。按「客服 → cs_platform」判据归类；如要比照 notifications 改判 features，改本行即可 |

### acquisition（miniapp_traffic，2026-08-31 新增 3 表）

| 表                                                         | 说明                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invite_codes` / `invite_relations` / `invite_reward_logs` | 裂变邀请：专属码、邀请归因关系、发奖业务明细（migration 105）。裂变属可删功能且语义为拉新归因，故归 acquisition 而非 app_core；星尘到账本体仍记 `billing.wallet_ledger`（经 `grant_invite_reward` RPC，符合跨域规则） |

---

### 未入库的库内对象（登记备查，不作为归属结论）

| 对象                                 | 归属域    | 状态                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `miniapp.charge_voice_usage`（函数） | `billing` | **只在 test 存在**，生产没有，仓库里也没有对应迁移，代码里没有任何调用方。写 `user_wallets` / `wallet_ledger`，按「涉及钱」判据归 billing。来源不明，2026-08-25 盘点之后才出现。migration 099 按**可选对象**处理（有则搬走，没有则跳过），**不在 099 里删除，也不补进仓库当正式 RPC**——那要另开评审。取证脚本 `ops/schema-split/probe-charge-voice-usage.sql` |

---

## 三、6 处争议表的裁决记录（2026-08-25）

| #   | 表                                                | 裁决             | 理由                                                                                    |
| --- | ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| 1   | `llm_usage_charges` + `dedup`                     | billing          | 涉及钱优先；接受 experience→billing 的运行时耦合（`chat_history.llm_charge_id` 软引用） |
| 2   | `character_free_chat_quotas` + `decisions`        | billing          | 免费权益属钱的范畴；对话链路跨域调用属正常 RPC 通道                                     |
| 3   | `wish_roles`                                      | miniapp_features | 功能衍生表；奖励发放经 RPC 写 `wallet_ledger`，符合跨域规则                             |
| 4   | `notifications` / `notification_reads`            | miniapp_features | 属 miniapp 功能，不按「触达」归 cs_platform                                             |
| 5   | `character_ranking_scores`                        | miniapp_features | 是大厅运行时的产品依赖，不是分析数据；analytics 域必须保持零运行时依赖                  |
| 6   | `users.total_round` / `user_settings.total_round` | 保留现状         | 接受 experience 链路对 core 表的跨域写入                                                |

---

## 四、评审规则

> **新表必须声明归属域；跨域访问只准走 RPC / API。**

落地细则：

1. **声明方式**：新建表的迁移文件头部注释声明归属域（例：`-- domain: billing`），PR 描述同步写明。评审时无归属声明的建表迁移不予合并。
2. **跨域访问通道**：一个域的代码不得直接 SELECT / JOIN / 写入另一个域的表；需要对方数据时，走对方域提供的 RPC、repository 封装或 API。
3. **允许的例外**：指向根实体（`users` / `characters`）的 FK 是全库惯例，不算违规；`analytics` 域只读其他域（单向），任何域不得反向读 analytics。
4. **存量豁免清单**（历史形成的跨域直连，收口前不再新增同类）：
   - `users.total_round` / `miniapp_user_settings.total_round` 由 experience 链路回写（裁决 6，永久保留）；
   - `character_ranking_scores`（features）由 lobby 定时任务直接聚合 experience 的 `chat_history` 重算；
   - `chat_history.llm_charge_id` 软引用 billing 的 `llm_usage_charges`（logger / sync-job 对账用）；
   - `notifications.created_by`、`support_messages.agent_user_id` FK → `admin.admin_users`。

---

## 五、物理执行策略（2026-08-25 更新）

bot 的 `public` / `analytics` 数据已迁出，存量物理迁移的前置里程碑已经完成。
项目正式进入八域物理划分的一阶段：创建 `app_core` / `miniapp_features` / `experience` /
`billing`，迁移存量表与视图，`support_*` 迁入 `cs_platform`，其余四域保持现有 schema 名称。

具体批次、函数归属、割接方法、验证及回滚要求以
`docs/schema划分-一阶段执行计划.md` 为准；本文档继续作为表和函数归属的权威来源。
