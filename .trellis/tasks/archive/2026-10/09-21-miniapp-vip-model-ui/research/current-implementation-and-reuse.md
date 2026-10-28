# 现有实现与复用调研

## 1. 调研范围与结论

已检索根文档、Trellis 工作流、前端/后端/Shared/数据库/跨层规范及对应模块知识，并沿用户可见链路核对模型、生成计费、钱包、签到、支付、语音、图片、通知和页面实现。

结论：仓库已有大部分基础设施，但没有 VIP 权益实体或统一资格判断。应在现有支付结算、钱包账本和媒体成功结算上做兼容扩展，不另建支付系统、钱包系统或第二套模型目录。当前扣费语义与需求存在实质差异，不能只改 UI：LLM、语音、图片现状均允许专项余额参与，LLM 还可能部分扣款；新需求要求按能力选择钱包、禁止部分扣款并支持原路幂等退款。

## 2. 复用、扩展与不复用清单

| 领域          | 已检索实现                                                                                          | 当前事实                                                                                | 决策                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 双钱包        | `MiniappWalletRepository`、`billing.user_wallets`、`wallet_ledger`、`shared/api/wallet.ts`          | 已有 `main_credits`、`bonus_credits`、合计余额和流水拆分                                | 直接把现有字段解释为充值/专项钱包，不搬余额；扩展统一扣款/退款能力与明细 DTO                             |
| LLM 扣费      | `generation/precheck.ts`、`apply-charge.ts`、`settle.ts`、`sync-job.ts`、`billing.charge_llm_usage` | 固定档位快照和 finish_reason 闸门可复用；当前总余额预检、专项优先、允许 partial         | 保留生成状态机和计费快照；改为能力策略驱动、轻量充值优先、付费高级档仅充值、余额不足零扣款               |
| 原路退款      | 历史 `refund_chat_message_charge`、现行 `wallet_ledger`                                             | 旧退款 RPC 已被删除；现行 ledger 已保存 `main_delta/bonus_delta`                        | 不恢复旧聊天专用表；新增按 debit ledger 拆分原路恢复的通用幂等退款入口                                   |
| 模型目录      | `shared/api/models.ts`、`platform/model-tiers.ts`、`routes/models.ts`                               | 已有稳定 model ID、档位、价格配置、持久化选择与后端选择路由                             | 扩展公开目录为用户态价格/锁定视图；生成时仍重新做权威权限与价格快照                                      |
| 模型 UI       | `ChatModelSwitcher`、`ChatToolsSheet`、`ChatTopBar`                                                 | 现有面板结构、React Query hooks 和选模 mutation 完整，但入口藏在工具箱                  | 复用面板和 mutation；移动触发器到顶部角色名下，移除工具箱入口，增加 VIP 锁定与折扣展示                   |
| VIP           | 全仓 VIP/membership 搜索                                                                            | MiniApp 无会员表、权益服务、路由或页面                                                  | 新增最小会员投影、订单履约事实和复用型后端资格服务；不建立等级/成长框架                                  |
| 支付          | `RechargeUseCase`、`PaymentSettlement`、`MiniappPaymentOrderRepository`、`routes/payment.ts`        | webhook/return/query/cron 四路已收敛到 `complete_payment_order`；信用充值商品为单一形状 | 保留网关和四路结算；订单增加商品/权益快照，结算 RPC 按商品类型原子履约；不新增支付通道                   |
| 签到          | `routes/wallet.ts`、`claim_daily_checkin`、`grant_bonus_credits`                                    | 奖励进入 bonus；配置与部分 fallback 并非都固定 60，首次并发领取仍需加强                 | 复用同一签到动作与奖励入口；一次事务发 60/120，并以用户级锁和既有记录防并发重复                          |
| 语音          | `features/voice/*`、`billing.charge_voice_usage`                                                    | 已是“产物可播放后扣款+ready”原子收口；当前专项优先且无免费次数                          | 保留生成/存储链路，扩展为免费预留/成功消费或充值钱包扣费，失败释放预留                                   |
| 图片          | `features/image/*`、`ChatMessageImageRepository`、`billing.settle_image_generation`                 | 已有 attempt/job、存储元数据、成功结算和幂等；只有一个图片产品，无初级/高级类型         | 现有产品兼容默认为初级；增加显式 tier 快照。高级入口仅在模型、价格、权限配置完整时开放                   |
| 免费次数      | 角色免费聊天 quota、语音/图片结算                                                                   | 聊天 quota 是用户×角色，语义不同；媒体无全局 quota                                      | 不复用聊天 quota；新增用户×媒体能力的服务端预留/消费事实，语音与初级图片分开计数                         |
| 消息中心      | `notifications`、`notification_reads`、`routes/notifications.ts`、消息页                            | 支持定向官方消息、未读表和按 ID 标记；当前列表打开会按 scope 批量已读，无详情页/业务键  | 复用表和 official 定向可见性；增加 VIP 类型/业务去重键/动作元数据、单条详情 API 和页面，取消自动批量已读 |
| 定时任务      | Backend 启动任务、支付 reconciliation/expire 脚本、Railway cron                                     | 已有定时执行和多实例处理经验                                                            | 使用数据库幂等 RPC + 有界每日扫描；沿用现有部署方式，不引入队列平台                                      |
| 我的页/充值页 | profile、recharge、PlanCard、payment hooks                                                          | 已有星尘卡、套餐互斥状态、支付外跳与订单等待页                                          | 扩展现有卡片和支付 hook；新增 VIP 详情页，不建立新的结账流程                                             |
| 运行时配置    | `runtime-config.ts`、`app_core.runtime_config`、配置 schema                                         | 模型、价格、媒体开关均有集中入口                                                        | VIP 商品、权益文案和高级图片配置沿用集中读取；禁止散落 `process.env` 或客户端权威配置                    |

## 3. 关键差异证据

### 3.1 钱包和扣费

- `GetWalletBalanceData` 已同时返回主余额、奖励余额和合计，前端无需推导数据库行。
- 当前 `charge_llm_usage` 使用 `LEAST(应扣, 总余额)`，因此会形成 `partial`；且按 bonus 再 main 扣除，与新规则相反。
- 当前 `charge_voice_usage` 和 `settle_image_generation` 都按 bonus 再 main 扣除，与“媒体只用充值钱包”冲突。
- 三条链路都已有稳定业务 ID 和 ledger 关联，可作为幂等扣款键；ledger 的 `main_delta/bonus_delta` 足以成为退款真相。

### 3.2 支付和会员履约

- `PaymentSettlement` 是四条确认路径的唯一应用层出口，数据库 `complete_payment_order` 锁订单并用状态/入账标志防重复。
- 当前 `PaymentPlan` 和订单只有星尘充值字段，没有商品类型、会员时长或权益履约状态。
- VIP 商品必须在订单创建时固化快照；支付成功后在同一数据库事务内更新订单、会员期限、月卡赠送余额和账本，不能先完成订单再异步补会员。
- `RechargeUseCase` 当前对所有套餐使用“VIP会员”网关商品名，但这不代表已有 VIP 产品；实现时需按真实商品类型生成受控名称。

### 3.3 权限和模型

- `routes/models.ts` 对付费模型只检查总余额，没有 VIP 门禁；`resolve-model.ts` 每轮从持久化选择解析模型，是加入到期回落的正确入口。
- 模型原价来自运行时 `fixedDeduction`，不得把原型示例数字写死。折扣应由后端输出原价、折前小数与最终整数，前端只展示。
- 模型在回复开始时已形成生成/计费快照，因此输出中切换可自然保持本轮不变、下轮生效。

### 3.4 免费体验

- 语音和图片都在上游成功并完成 Storage 后才进入最终结算，这是“失败不计次”的可复用边界。
- 仅用成功计数器无法安全处理并发：多个请求可能同时看到剩余一次。需要先原子预留免费名额，成功时消费、失败/超时时释放，并按 attempt/audio ID 幂等。
- 角色免费聊天额度是用户×角色的文本业务规则，不能拿来承载账号全局、按能力分开的媒体额度。

### 3.5 通知

- migration 066 已允许 `scope='official'` 且带 `user_id` 的定向官方消息，并且读取路由按用户过滤，可直接承载 VIP 提醒。
- 当前通知没有业务去重键或动作元数据；列表页面加载后会把整个 scope 标记已读，不符合“点击条目才已读”。
- 需要服务端在插入前再次比对所观察的 `valid_until`，否则续费与扫描并发时会发出旧周期提醒。

## 4. 数据归属与迁移判断

- VIP 会员期限、购买履约事实、支付订单快照、媒体免费额度和钱包扣退属于 `billing`：它们是交易事实、付费权益或计费裁决。
- 语音/图片 attempt 的展示与产物状态继续属于 `experience`；只增加 tier、免费预留或结算关联等必要快照。
- 定向提醒、提醒业务键和已读状态继续属于 `miniapp_features`，不复制会员真相。
- VIP 入口角标的永久已看状态属于 `app_core` 用户设置。
- 不创建 `public` 对象，不新增平行 migration 目录；只在 `packages/shared/migrations/` 添加向前兼容 migration，并逐文件手工执行。
- 新增跨 schema 函数依赖必须在 migration 的前置/后置自检和架构文档中显式记录。

## 5. 发现的文档或实现缺口

- 相关 Backend 规范引用的 `docs/log_system.md` 在当前工作树不存在。实施时应以现有 pino 规范、根规则和真实 logger 实现为准，并单独修正文档引用，不能假设该文档存在。
- 源需求将基础签到描述为现有固定 60，但仓库代码/历史 migration 仍有 10/40 fallback；实施必须把 test/production 当前配置分别核验并收敛到 60，不能用 test 结论代替 production。
- 仓库目前只有一个图片产品。高级图片的 provider/model/价格未在代码中定义；设计允许新增受控配置，但配置未完整、未验证时必须保持入口关闭，不能猜测价格或模型。
- 原型给出的模型价格是计算示例；实际原价来自环境运行时目录。实现必须保持原价不变并基于同一快照计算折扣。

## 6. 最小充分方案结论

需要新增的核心能力只有：会员投影与履约事实、订单商品快照、统一钱包分配/退款原语、媒体免费预留、VIP 状态契约和到期提醒业务键。其他部分全部扩展现有 route、repository、React Query、模型面板、支付 settlement、媒体 attempt/job 与通知表。

明确拒绝：第三个钱包、第二套支付流程、客户端扣款、通用权益规则引擎、消息队列平台、会员等级框架、为未来商品预建商城、在前端硬编码模型价格、为高级图片猜测供应商或价格。
