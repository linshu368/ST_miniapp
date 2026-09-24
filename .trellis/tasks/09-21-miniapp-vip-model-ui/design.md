# 技术设计

## 1. 设计目标与边界

本设计把 VIP 作为“支付订单履约产生的时长权益”，把充值/专项星尘继续保留在现有双钱包，把每次能力调用归一为“资格判定 → 价格快照 → 钱包策略 → 成功结算/失败释放 → 必要时原路退款”。

必须同时满足：后端权威校验、支付与扣退幂等、并发不超扣、旧余额守恒、旧客户端可读、迁移可先于应用部署、支付后权益不可因回滚被抹除。

不建立通用权益规则引擎、商城系统、第三个钱包、消息队列或跨应用 UI 包。高级图片仍使用现有图片任务框架；本期只增加明确档位和受控配置，不猜测供应商/模型/价格。

详细代码证据与复用判断见 `research/current-implementation-and-reuse.md`。

## 2. 总体链路

```text
商品配置 -> 创建 payment_order（固化商品快照）
  -> 现有微信支付
  -> webhook / return / query / cron
  -> complete_payment_order（锁订单，唯一履约）
     -> credits：现有充值钱包入账
     -> vip：顺延 vip_membership；月卡 bonus 入专项钱包；写 grant fact

能力请求 -> 后端读取当前 VIP + 运行时价格
  -> 权限/可用钱包预检
  -> 固化 entitlement + price + wallet_policy 快照
  -> 上游成功
  -> 业务专用 settle RPC
     -> 免费预留成功消费，或 wallet debit 原子扣款
     -> 写 ledger + 业务 ready/charged 状态
  -> 失败：释放免费预留，不扣款
  -> 已扣后补偿：按原 debit ledger 幂等原路退款
```

VIP 资格以请求被后端接受的时刻为准。本轮生成一旦形成权益/价格快照，即使处理中跨过到期时刻也按该快照完成；下一轮重新判断，到期用户自动回落轻量模型。

## 3. Shared contracts

所有外部形状先落 `packages/shared/src/api/*` 并提供 Zod/runtime 校验；前端不消费数据库行。

### 3.1 VIP

新增 `api/vip.ts`：

- `VipPlan`：`id`、`price_cents`、`duration_days`、`bonus_credits`、展示文案和可用状态。周卡/月卡 ID 固定，条款改为读取已发布的 `vip_plans_config`；7/1399/0 与 31/2888/3000 是兼容默认值，不再作为永不可变的精确值校验。
- `VipStatus`：`active`、`valid_from`、`valid_until`、`remaining_days`、`last_plan_id`、`entry_badge_visible`。
- `GET /api/vip/status` 返回服务端时钟下的当前状态。
- `POST /api/vip/entry-viewed` 幂等记录首次点击时间并返回最新状态。

`remaining_days` 仅用于展示，按正剩余秒数向上取整；权限永远使用精确 `valid_until > now()`，不使用天数判断。

### 3.2 支付

- `PaymentOrder` 增加 `product_type: 'credits' | 'vip'`、`product_id`、`fulfillment_applied` 和 VIP 履约后的 `vip_valid_until`。
- 保留 `GetPaymentPlansData.plans` 作为星尘套餐，新增 `vip_plans`；旧消费者忽略新增字段仍可工作。
- `CreatePaymentOrderRequest` 继续只接收受控 `plan_id` 与支付方式；服务端按 plan ID解析商品类型，不接受客户端传价格、天数或奖励。
- 订单列表/详情按同一 mapper 返回新增字段，不在单一路由漏字段。

### 3.3 模型与钱包

- 模型目录的档位视图增加 `requires_vip`、`locked`、`original_credits`、`discount_rate`、`discounted_exact`、`payable_credits`。
- 模型配置响应增加当前 `vip_status` 摘要，供面板显示剩余天数；选择接口增加稳定错误码 `VIP_REQUIRED`、`MAIN_CREDITS_INSUFFICIENT`。
- 统一纯函数计算文本价：免费轮先返回 0；否则读取同一 pricing snapshot 与已发布 `vip_text_discount_rate`，有效 VIP 时 `round(original * discount_rate)`，否则原价。默认折扣率 0.95；只接受大于 0 且不超过 1 的有限值，最终文本实扣为整数。
- 钱包明细增加 `main_delta`、`bonus_delta`、`original_amount`、`discount_rate`、`refund_of` 和展示标签；保留现有字段以兼容旧 UI。
- 签到响应保留 `reward_credits` 作为总数，并增加 `base_reward_credits`、`vip_reward_credits`，避免旧客户端解析失败。

### 3.4 语音、图片与通知

- 语音/图片配置响应增加按 feature 读取的 `free_trial_limit`、`free_trials_used`、`free_trials_remaining`、`next_trial_ordinal` 和本次价格展示；语音/basic 图片默认上限均为 3。
- 图片请求增加 `tier: 'basic' | 'advanced'`，缺省为 `basic` 兼容旧调用；高级配置不可用时返回稳定的 `ADVANCED_IMAGE_UNAVAILABLE`。
- 通知增加 `kind`、`action_path` 和只含非敏感展示数据的 metadata；新增 `GET /api/notifications/:id`。VIP 提醒使用 `kind='vip_expiry'`。
- 列表页不再按 scope 自动已读；点击条目后仅用现有 `ids` 形状标记该条，再进入详情。

### 3.5 Admin「VIP策略」配置契约

复用现有 `app_core.runtime_config`、Admin managed-key 白名单、草稿/发布/版本/回滚 RPC 和编辑器框架。Admin 新增独立业务视图/tab“VIP策略”，不把这些 key 散落到通用配置列表：

- 复用既有 key：`vip_purchase_enabled`、`vip_reminders_enabled`。
- 新增 `vip_plans_config`：固定包含 `week`、`month`。两者均有 `price_cents`、`duration_days`、`title`、`description`、`badge_text`；month 另有可配置 `bonus_credits`，week 的 bonus 保持 0。
- 新增 `vip_text_discount_rate`：默认 0.95，范围 `(0, 1]`。
- 新增 `vip_checkin_bonus_config`：`mode='same_as_base'|'fixed'`；`fixed` 模式必须提供非负整数 `fixed_credits`，默认 `same_as_base`。
- 新增 `feature_free_trial_limits`：分别保存 `voice` 与 `basic_image` 的整数上限，取值范围统一为 `0..20`，默认均为 3；0 表示关闭对应功能的免费体验。Shared、Admin 和数据库发布校验必须使用同一范围。

Shared 提供 runtime schema、默认值与 browser-safe DTO；Admin 和 Backend 复用同一 schema。数据库发布 RPC再次校验同样的业务不变量，不能只依赖浏览器校验。配置内不包含 provider URL、token、密钥、任意 wallet policy 或 SQL。

配置读取失败或值非法时：购买与提醒开关 fail closed；其余字段使用随代码发布且与首次迁移一致的安全默认值并记录允许字段告警。任何实际支付、签到、文本生成或媒体受理都要固化当次配置快照，避免运营修改导致进行中业务重定价。

## 4. 数据模型与对象归属

迁移只新增到 `packages/shared/migrations/`，按兼容性拆成可单独执行和验证的文件，不改历史 migration。

### 4.1 `billing.vip_memberships`

- `user_id uuid primary key`，引用用户权威表。
- `valid_from timestamptz not null`、`valid_until timestamptz not null`、`last_plan_id text not null`、`version bigint not null`、时间戳。
- 这是当前权益投影，不承担订单审计；续费对行 `FOR UPDATE`，以 `greatest(now(), valid_until)` 为基准顺延。
- `valid_until > now()` 是唯一权限判定，不缓存为易漂移的布尔列。

### 4.2 `billing.vip_purchase_grants`

- `order_id text primary key`，并唯一关联支付订单。
- 保存 `user_id`、plan/金额/时长/赠送快照、履约前后有效期、`granted_at`。
- 它是订单只履约一次的审计事实；同一订单重放返回现有结果，两笔不同订单在会员行锁下依次顺延。

### 4.3 `billing.payment_orders` 兼容扩展

- 新增 `product_type`，默认 `credits` 且历史行回填为 `credits`；新增 `product_id`、`vip_duration_days`、`vip_bonus_credits`、`fulfillment_applied`、`vip_valid_until`。
- 通过 CHECK 约束商品快照：credits 保持现有额度字段；vip 必须有受支持时长，不能伪造 credits 主余额入账。
- `credits_added` 暂时保留原语义；新代码以 `fulfillment_applied` 判断所有商品履约。旧订单映射 `fulfillment_applied=credits_added`。
- 迁移先部署时旧应用仍只能创建 credits 订单；`vip_purchase_enabled` 默认 false，避免旧 Backend 遇到新商品。

### 4.4 媒体免费体验

新增 `billing.feature_free_trials`：

- `user_id`、`feature in ('voice','basic_image')`、稳定 `reference_id`、正整数 `ordinal`、`status in ('reserved','consumed','released')`、`reserved_until`、`consumed_at`。已应用的 `ordinal 1..3` CHECK 通过独立 forward-fix migration 演进，禁止改写 T2 文件。
- `reference_id` 全局幂等；同一用户/feature/ordinal 在 reserved 或 consumed 状态下唯一。
- `reserve_feature_free_trial` 用用户+feature 事务级 advisory lock，先回收确定过期的 reservation，再分配最小可用 ordinal。预留 TTL 必须大于上游硬超时并由长任务续租。
- 成功结算与业务 ready 在同一事务把 reservation 置 consumed；明确失败、取消和 failed_unknown 释放。已经过期且被其他请求占用的迟到成功不得静默转为付费，按失败收口，避免用户未同意的意外扣款。
- 免费次数从功能启用后的成功事实开始，存量用户同样从 0 开始；不回溯历史媒体调用。调低上限保留已有事实且停止继续分配，调高上限允许继续分配新的最小 ordinal。

### 4.5 原路退款事实

新增 `billing.wallet_refunds`：`refund_key` 唯一、`debit_ledger_id` 唯一、`user_id`、`main_amount`、`bonus_amount`、reason 和时间戳。

`refund_wallet_debit` 锁原 debit ledger、退款事实和钱包，只接受负向 debit，分别以 `abs(main_delta)`、`abs(bonus_delta)` 恢复余额，并写一条关联原 debit 的 refund ledger。重复 key 或重复 debit 返回 `already_refunded`；任何校验失败都不改变余额。

### 4.6 通知与用户设置

- `miniapp_features.notifications` 增加 nullable `kind`、`business_key`、`action_path`、受限 metadata；对非空 `business_key` 建唯一索引。
- VIP reminder key 固定包含 `user_id + observed_valid_until + reminder_kind`，使同周期同类型去重。
- `app_core.user_settings` 增加 nullable `vip_entry_seen_at`，由鉴权后的幂等接口写入。
- 图片 attempt 增加 `image_tier`、资格/价格/免费预留快照；语音 attempt 增加免费预留关联。历史行默认 basic/paid-compatible，不回写余额。

### 4.7 RLS、权限与跨 schema

- 新 billing 表开启 RLS，anon/authenticated 无直接权限；只授予 service_role/postgres，公开访问只走鉴权路由。
- SECURITY DEFINER 函数固定安全 `search_path`，校验 user/attempt/order owner，不把任意钱包策略暴露给客户端。
- reminder RPC 读取 billing 会员并写 miniapp_features 通知；migration preflight/postflight 必须校验两个 schema、函数签名、grant、索引和跨 schema 依赖。

## 5. 钱包原子扣款与幂等退款

### 5.1 统一分配原语

在 billing 内新增不直接暴露给客户端的 `apply_wallet_debit`，由 LLM/voice/image 业务结算 RPC 调用：

1. 用稳定业务键检查既有 debit；已存在则返回同一结果。
2. 创建并 `FOR UPDATE` 锁钱包行。
3. 按已由服务端决定的策略计算：
   - `main_then_bonus`：仅轻量文本；先 main，再由 bonus 补差额。
   - `main_only`：标准/旗舰文本、初级/高级图片、语音。
4. 在更新前检查相应可用余额覆盖全部金额；不足只返回错误，不写钱包、ledger 或业务成功态。
5. 一次 UPDATE 同时扣两个列，一次 ledger 写入保存拆分、资格/价格快照和业务引用。

不保留 `partial` 作为新结算结果；历史 partial 记录只读兼容。前端总余额只能展示，预检必须按 wallet policy 使用 main 或 main+bonus。

### 5.2 各业务收口

- LLM：保留 finish_reason=stop 闸门和 deferred sync；charge 先固化 model tier、VIP 截止时间、原价、折扣和 payable，再调用 allocator。非 billable 仍为 0。
- Voice：Storage 已有可播 URL后，消费免费 reservation；无免费 reservation 时 main-only 扣款；随后与 ready 同事务收口。
- Image：basic 可免费或 main-only 付费；advanced 必须校验请求时 VIP snapshot 且 main-only。Storage 元数据、扣款和 current ready 保持同事务。
- 退款：仅在业务已产生 debit 后需要补偿时调用通用 refund；退款成功后同步把对应业务记录标为 refunded/failed，不删除历史产物或账本事实。

## 6. VIP 资格、价格与模型回落

新增 Backend `features/vip` 服务和 repository，提供 `getVipStatus(userId, at)` 与只读展示 mapper；支付、签到和最终资金裁决仍在数据库事务内完成。

- 模型目录 GET：把运行时原价与当前 VIP 状态合成用户态视图。
- 模型选择 POST：标准/旗舰先要求 VIP，再检查充值钱包可覆盖本档折后价；轻量按主+专项可覆盖判断。
- 生成入口：每轮重新解析持久化选择。若已过期且选择为标准/旗舰，权威解析返回默认轻量并 best-effort 修正持久化设置；修正失败不阻断本轮轻量回复，但记允许字段日志。
- 折扣计算只在 Backend 纯函数做一次并固化；同步结算不得读取更新后的目录重定价。
- 当前流式回复已经持有自己的 resolved model，因此 UI 切换只更新下轮设置；前端根据 generating 状态展示“本次回复不受影响，下一条回复使用新模型”。

## 7. 支付履约

扩展现有 `complete_payment_order`，继续作为四路确认的数据库唯一出口：

1. 锁订单并验证状态、金额和快照；已履约直接回读。
2. credits 商品执行现有主/赠送入账和 ledger 行为，并设置 fulfillment。
3. vip 商品锁/创建会员投影，按 `greatest(now(), valid_until)` 顺延；写 purchase grant。
4. 月卡在同一事务调用既有 bonus grant 原语，以 `payment_order + order_id` 为唯一引用写订单快照中的赠送专项星尘和 ledger；周卡为 0。运营后续改值不得改变已创建订单快照。
5. 写订单 completed、settled_by、paid_at、fulfillment 和新截止时间；任一步失败整单回滚。

应用层支付成功通知按商品类型生成文案。通知失败只记录 `{ err }`，不回滚已完成的资金/权益交易。邀请首次付费规则是否把 VIP 算作“首次付费”沿用现有“任意成功现金支付”口径，并在现有回归测试中锁定。

## 8. 签到

`claim_daily_checkin` 增加用户级事务锁，解决首次签到没有既有行可锁的竞态。函数在同一 `now()` 快照下锁定/读取 VIP：

- 普通或过期：只发当次基础奖励。
- 有效 VIP：按已发布 `vip_checkin_bonus_config` 计算加成；`same_as_base` 取当次基础奖励，`fixed` 取发布的固定数值。metadata 记录 base、vip、配置模式/版本和 entitlement valid_until。

一次 `grant_bonus_credits` 将总数进入专项钱包，一条 daily_checkin 记录完成 24 小时去重；响应拆出基础/VIP金额用于两行提示。重复、并发或任一写入失败都不会产生第二次/部分奖励。

基础奖励当前收敛为 60，VIP 策略首次迁移保持 `same_as_base`，因此当前仍为 60/120。migration 前分别只读核验 test/production 的 runtime config；不得把 test 值当作 Production 事实。

## 9. 高级图片与媒体免费体验

- 现有图片产品兼容为 `basic`；请求不传 tier 时仍走 basic。
- `advanced` 必须有完整 runtime config（enabled、provider/model、price、展示文案）且用户 VIP 有效。配置缺失时接口返回不可用，前端隐藏或禁用，不回退为 basic 冒充高级。
- Basic image/voice 在调用上游前按各自已发布上限尝试预留免费 ordinal；无法预留说明配置额度已占用/消费，执行 main-only 余额预检。
- 上游和 Storage 失败释放 reservation；成功在 domain settlement 中消费。网络模糊结果遵循现有 failed_unknown“不扣费”口径。
- Advanced 在受理时校验当前 VIP 并固化权益/配置快照；最终结算验证的是这份已受理快照及其完整性，而不是用结算时钟推翻处理中刚到期的请求。下一次请求再按最新会员状态判断。
- 请求频率沿用现有媒体限流，并增加每用户同时 reserved 数量上限；不允许通过并发占用无限任务容量。

## 10. 到期提醒

新增每日有界脚本，复用现有 Backend 脚本/Railway Cron 运行方式；不引入常驻队列。

- 业务时区固定 `Asia/Shanghai`。扫描“有效期本地日期为今天+3天”和“有效期本地日期为今天”的当前会员。
- 数据库 reminder RPC 对候选会员行加锁，使用当前 `valid_until` 生成 business key 并插入定向 official 消息；续费若先完成，扫描只看到新周期；扫描若先拿锁，则消息代表发送时真实状态。
- 唯一索引兜住脚本重跑、多实例和超时重试。每批有限条数并输出 scanned/inserted/skipped/failed，不记录正文或用户隐私。
- `vip_reminders_enabled` 默认 false；先用 dry-run 统计验证窗口，再启用写入。
- Admin 只管理该开关；提前 3 天、到期当天、提醒文案和 `Asia/Shanghai` 本期保持代码/需求固定值，不进入“VIP策略”。
- 详情页实时请求当前 VIP 状态，因此历史提醒在续费后仍展示最新状态，而正文保持发送时事实。

## 11. 前端页面与状态

- Profile：复用 wallet/vip queries；总额下显示专项余额；VIP 按钮状态由服务端 status 决定，首次点击先幂等 mark-seen 再导航。
- VIP 页面：新增窄页面和包内组件，复用 payment create/open/waiting 链路；权益头卡由 CSS 渐变、图标和文本直接渲染，无外部图片依赖。
- Recharge：保持一个 `selectedProductKey`，credit/vip 共用互斥选择和支付按钮；不建立第二个结账状态机。
- Chat：`ChatTopBar` 承载模型胶囊，现有 `ChatModelSwitcher` 放入 sheet/popover；`ChatToolsSheet` 删除模型行。
- Notifications：列表卡变为可点击链接，点击只标记该 ID；详情页独立查询 notification 和 VIP status，返回后 query cache 保持一致。
- Admin：新增“VIP策略”业务视图，按“功能开关 / 商品 / 文本折扣 / 签到加成 / 媒体免费次数”分区；复用现有草稿、发布、版本、回滚和环境切换，不新增直写 `runtime_config` 的客户端路径。
- 所有服务器数据继续通过 `src/lib/api/` React Query hooks，不在组件直接 fetch。

## 12. 故障模型与可靠性设计

| 关注点    | 设计                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 超时      | 支付网关、LLM、语音、图片和 Storage 沿用/补齐明确超时；reminder 批次和 DB statement 有上限                                         |
| 有限重试  | 只重试幂等查单、稳定业务键结算、通知扫描和可安全媒体任务；不重试支付创建或不确定的非幂等上游调用                                   |
| 幂等      | order_id 履约、charge/attempt/audio ID扣款、refund_key退款、reference_id免费预留、business_key提醒均有数据库唯一事实               |
| 并发      | 订单、会员、钱包和签到行/用户锁；免费 quota 用 user+feature 锁；双钱包一次 UPDATE，禁止 partial                                    |
| 事务      | 支付履约+会员+月卡赠送、签到+钱包、媒体 ready+免费消费/扣款、退款+ledger 分别在单事务收口                                          |
| 降级      | VIP 状态读取失败时付费专属能力 fail closed；轻量模型仍可按可验证规则工作；通知失败不影响会员；高级图片配置不全保持关闭             |
| 补偿      | 外部成功但 DB 未收口由既有 job/查单幂等重放；已扣后业务补偿走原 ledger 退款；不手工改余额                                          |
| 限流/容量 | 复用媒体/生成限流；限制免费 reservation 和 reminder 批次；为会员/订单索引验证查询计划                                              |
| 可观测性  | pino 记录 operation、内部 ID、product/tier、entitlement result、wallet split、source、duration、retry/result；原始错误用 `{ err }` |

### 停止条件

出现任一情况停止启用或发布：余额不守恒、重复履约/扣款/退款、权限可绕过、免费次数超领、已有付费会员权益丢失、支付金额/商品快照不匹配、reminder 大量重复、migration 锁超预算、test/production schema 前置不一致、高级图片配置无法验证。

## 13. 演进、发布顺序与恢复

### 13.1 向前发布

1. 冻结需求与审查本设计；确认 test 连接和高级图片配置来源。
2. 在 test 只读采集相关表/函数/索引/RLS/grants/config shape，不读取业务行；记录双环境未知差异。
3. 执行 additive migration：新表、nullable/default 列、唯一索引、兼容 RPC、开关默认关闭。验证旧 Backend 和旧 Frontend 仍可使用 credits 支付及现有能力。
4. 由于 T2/T3 已在 test 应用，新增“VIP策略”必须使用新的 forward-fix migration：添加/纳管 managed keys、发布校验和动态免费 ordinal 约束，按当前规则 seed；不得修改 `20260921_*` 或 `20260922_daily_checkin_vip_bonus.sql`。
5. 发布 Shared + Backend + Admin，新功能入口和购买仍关闭；验证旧 Backend 在配置 migration 后仍按默认规则工作，再运行 DB/route/并发/故障测试。
6. 执行受控行为切换 migration 或启用新版 RPC 路径，验证钱包矩阵、退款、签到、免费次数和四路支付。
7. 发布 Frontend；先只对 test 打开 UI，完成全部人工场景和体验终审。
8. 启用 test 的 VIP purchase、advanced image（仅配置完整时）与 reminder dry-run，再启用 reminder write。
9. 测试通过后由产品明确批准 Production；Production 重复逐文件 migration → Backend → Admin/Frontend → smoke → 分项开关，不批量套用 test 结论。

### 13.2 回滚与 forward-fix

- 最先关闭新 VIP 购买和高级图片新请求，暂停 reminder 写入；不撤销已完成订单、不缩短会员期、不删除月卡赠送或消费事实。
- 前端可回滚到隐藏新入口，但 Backend 必须继续识别并兑现已售会员；若旧版本不认识 VIP 订单，不得直接回滚 Backend，先发布兼容 forward-fix。
- 计费异常时暂停对应生成/媒体能力，按 ledger 查出受影响 debit 并用幂等退款 RPC恢复，不运行手工余额 UPDATE。
- additive 列/表和真实支付数据不做紧急 down migration。待停止新写、备份并确认无消费者后，才可用独立审查的清理 migration。
- migration 失败在提交前依靠事务回滚；已提交后优先 forward-fix。每个生产 migration 一次一个文件，记录前后 shape、权限、锁时间、关键读写与恢复点。
- 配置发布错误先回滚到上一已发布版本并关闭 `vip_purchase_enabled`；已创建订单、已受理生成和已领取签到继续使用各自快照，禁止通过回滚配置改写历史事实。

## 14. 可验证性与文档同步

计费、权限、并发、支付、契约和 migration 属于高风险范围，实施时必须增加/扩展回归测试文件。测试至少覆盖：

- 价格纯函数的免费优先、95 折、0.5 边界和运行时快照不漂移。
- 轻量组合扣、main-only、余额不足零扣、重复扣、并发扣、原路退款和重复退款。
- payment 四路竞态、两笔续费并发、月卡赠送一次、过期订单迟到确认。
- 签到普通/VIP/到期边界、首次并发、重复请求。
- 语音/图片免费 reservation 并发、失败释放、迟到成功、两能力隔离、高级图片门禁。
- Admin“VIP策略”的字段校验、草稿/发布/回滚、旧 Backend 兼容、缺失/损坏降级、商品/折扣/签到/免费次数改值后只影响后续业务，以及免费上限调高/调低边界。
- reminder 两窗口、时区边界、重跑、多实例、续费竞态、单条已读与详情鉴权。
- 所有 Shared 消费者 typecheck，Frontend build，Backend 相关测试，migration pre/postflight 与 test 回滚演练。

同步更新 README、ARCHITECTURE、相关前后端/Shared/数据库 spec 和模块知识。当前缺失的 `docs/log_system.md` 引用需修正或补回，不能在本任务中继续留下无效入口。

父任务保留支付履约、权益、钱包/免费额度公共底座、发布顺序和最终集成验收；语音与图片的领域状态机是可独立验证且由原模块工程师维护的交付物，因此拆为 `09-21-vip-voice-free-trials` 与 `09-21-vip-image-free-trials` 两个子任务。子任务不能自行改写公共计费规则：语音和 basic 图片在父 T2 稳定后即可开始，advanced 图片额外等待父 T3 权益接口，二者均不依赖父 T4 的 LLM 改造。

## 2026-09-23 T7 修订设计

复用 VipStatusService、runtime-config、现有 VIP queries、ChatModelSwitcher、支付 mutation/openCreatedPayment、voice/image session 轮询；不新增接口、状态库、媒体计数器或数据库对象。Shared 的 VIP status 兼容新增可选 benefits（text_discount_rate、checkin_base_credits、checkin_vip_credits），GET 和 mark-viewed 返回相同形状，避免写缓存丢失展示信息。模型计费 discount_rate 语义保持不变。

媒体额度仍以后端为真相，在已有查询层观察受理与终态，失效 config/wallet 缓存；请求去重由 React Query 管理，不按消息组件各自轮询。失败释放后也刷新；加载/错误使用中性提示，不沿用过期免费承诺。继续使用既有请求超时、有限重试、免费预留及原子扣款，展示层不重试生成、不改计费事务。并发预估可能变化，最终以请求快照为准。

发布 Backend 后 Frontend；旧 Backend 无 benefits 时只显示权益数据加载提示而不伪造数字。可回滚展示代码，不改会员、钱包、配置和历史订单。没有 migration、外部供应商、新限流/补偿需求；停止条件为显示价与权威报价不一致或重复请求。保留既有 pino 错误与 API 查询失败提示，不记录用户内容。

## 2026-09-24 真机反馈修正设计

### 免费体验展示状态

`next_billing` 只用于尚未提交的下一次动作。语音 `MessageVoice` 和图片 `MessageImageAttempt` 已包含受理时固化的 `billing_mode`、`free_trial_ordinal`、`price_label`，终态内容必须使用这些快照。失败 attempt 已由后端释放额度，重试入口在额度刷新完成前也使用失败 attempt 的序号，避免短暂显示下一序号；刷新完成后服务端下一次报价仍应返回同一序号。

不新增状态源，不改变预留、结算或退款状态机。前端只补充一个 attempt 快照格式化函数，并在语音/图片现有组件中区分“本次结果”和“下一次操作”。

### VIP 说明与权益

复用 `useVipStatusQuery` 和 `usePaymentPlansQuery`。弹窗的签到数、套餐名称和价格来自接口；加载失败时保留基础 VIP 说明和跳转，不写死运营价格。详情页继续读取 `VipStatus.benefits` 与套餐数据，调整为 Demo 的四条信息结构，当前折扣仍由运行时配置产生。

顶部胶囊只增加一个 `aria-hidden` 的绿色状态点，原有文本、展开状态、焦点与动画逻辑不变。

### TEST 开关

使用已确认 TEST Supabase 项目 `zoqelpfhurwehlvypryl`，先回读 `admin.current_environment()` 与 `vip_purchase_enabled` 的 key/value/version，再以旧 value/version 为条件原子更新这一行。不新增 migration，不改商品条款。更新后再次回读；异常时停止，不触碰 Production。恢复方案是对同一 TEST key 做相同条件保护的 `false` 更新。
