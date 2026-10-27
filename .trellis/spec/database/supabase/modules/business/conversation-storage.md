---
module_id: database.business.conversation-storage
title: 会话、语音与图片存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/10-27-chat-preparation-db-pressure/
last_verified_at: 2026-10-27
---

# 会话与语音存储

## 职责与边界

## 当前状态

新发送与重生成使用 `experience.start_chat_history_*_with_current_postprocess`：在开轮事务内读取 `app_core.runtime_config` 当前正式指针、校验不可变 artifact 快照，再复用既有显式版本 wrapper 写入非空 `chat_history.postprocess_version`。旧 wrapper 的 `NULL=不绑定` 保留兼容，旧行不回填。

## 入口与调用者

## 涉及文件

| 路径                                                                                  | 职责                                |
| ------------------------------------------------------------------------------------- | ----------------------------------- |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql`                            | 会话基线                            |
| `packages/shared/migrations/077_context_window.sql`                                   | 上下文水位                          |
| `packages/shared/migrations/080_chat_message_voice.sql`                               | 语音元数据                          |
| `packages/shared/migrations/20260914_chat_message_images.sql`                         | 图片 attempt、租约与 Storage bucket |
| `packages/shared/migrations/20260930_bind_current_text_postprocess_on_turn_start.sql` | 开轮原子绑定当前正式展示版本        |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

`experience.openrouter_chat_history` 按唯一 `chat_history_id` + 父 FK `ON DELETE CASCADE` 保存 OpenRouter 调用元数据。`20261016_openrouter_original_metadata_fields.sql` 以 expand 方式将 11 列改用厂商原名；`llm_generation_id`、`llm_generation_data`、主键与审计字段保持现名。旧别名仅用于迁移窗口兼容；新 Backend 不读写别名，旧 writer 退出后需补核窗口数据，清理另交 contract migration。主表业务 `llm_finish_reason` 和计费事实保持原归属；Venice 表不调整。文件声明不等于目标环境已执行。

“当前”只认 `miniapp_text_postprocess_config` 指针，不使用 `MAX(version)`。配置缺失、协议错版、artifact 快照不可用或 RPC 未部署时整轮失败，不留下 history 半写；发布顺序为 migration → Backend。

## 验证方式

## 已知缺口与待核验项

已交付主表12调用列与专表11重复别名的独立contract，保留主表业务llm_finish_reason/计费及专表ID/data；PG17+PostgREST双处真删列后实际repository/视图读写通过。TEST catch-up/views已记账，两个DROP未执行；Production状态独立复核。旧raw JSON/历史分类及共享旧消费者退出仍是门禁，Venice旧账本漂移不修复。

## 关联模块

`backend.business.conversation-generation`、`backend.infrastructure.runtime-data-security`。

## 图片创作广场 V2（2026-10-12）

图片广场持久化位于 `experience` 域，覆盖会话/消息、短期报价、参考资产、生成 attempt、artifact 和公开作品；生命周期由 Backend service-role 和受限 RPC 权威写入，客户端不直接读表。生成任务通过 `FOR UPDATE SKIP LOCKED` 租约领取，过期不确定任务可收口为 `failed_unknown`。

`20261013_image_plaza_seed_catalog.sql` 将提示词约束前向扩至 2000 字，并为 artifact/work 增加互斥的 `generated`/`civitai_seed` 来源不变量。种子作品可无用户和 attempt，只能由 service-role 导入 RPC 原子创建；Civitai ID 唯一，源 URL/源热度仅内部保存，站内点赞从 0 独立累计。`20261013_image_plaza_seed_large_assets.sql` 仅将经审核 seed 所需的 artifact/bucket/RPC 容量扩至 50 MiB，普通用户图片仍由 Backend 限制为 20 MiB；三份 migration 已在 test 验证。

## 影像广场视频与目标域（2026-10-27，本地实现，远程未执行）

`20261027_media_plaza_schema_move.sql` 计划把八张广场表和相关函数迁到独立 `media_plaza` 域；Backend 的 `plazaDb()` 在启动时探测新域，迁移前继续使用旧域。`20261027_media_plaza_video.sql` 增加视频 quote/attempt/artifact、租约 worker RPC、预扣/退款及共用首次分享奖励；视频资源上限 200 MiB，账务继续归 `billing`。M1 有仅限尚无视频对象时使用的配对回滚；M2/M3 产生视频写入后只允许停入口并 forward-fix。

视频 seed 以两份 xlsx 哈希、翻译逐行一致性和 5,097→5,082 基线为门禁；先对所有源 URL 做并发 10 的 HEAD 体积报告，人工确认报告 SHA 与 bucket 配额后才允许 test 小批 apply。迁移和脚本存在不代表数据库或 Storage 已被修改。

## 变更记录

- 2026-10-19：增加离线 TEST seed 导出与目标初始化模板，复用既有 RPC，不增加永久对象；仅导出 active seed 内容与图片元数据，目标重新分配 UUID，排除用户行为。真实数据不入 Git，Storage 实体复制和生产执行独立审批。见 `ops/image-plaza-seed-migration.md`；未进行生产导入。

- 2026-10-13：任务 `10-10-image-plaza-v2` 增加初始作品来源模型和 2000 字约束前向迁移。

last_verified_task: .trellis/tasks/10-27-chat-preparation-db-pressure/
last_verified_at: 2026-10-27

- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除重复的历史变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## T9 专表旧别名清理（本地实现，远端未执行）

新增独立 `20261016_openrouter_chat_history_drop_legacy_aliases.sql`：删除11个重复别名，保留canonical原名列、llm_generation_id/data及UNIQUE/FK/ACL；仅填NULL原名安全字段、非空冲突/未知依赖/超过2000候选拒绝。显式删除8个旧别名CHECK，canonical CHECK保留。不把待回捞metadata空值判为失败，不改父行业务事实或Venice。可先清专表，主表DROP仍有独立历史JSON/结算和运行门禁；不搬raw JSON、不伪造结算。PG17/PostgREST双处真实删列回归见任务T9报告；真实环境覆盖与所有旧writer退出仍需独立验收。

## T10 历史处置（本地实现，未远端执行）

新history_disposition只保全类型化原名调用字段/受控诊断，清父表raw并规范化已有OR诊断；不存未知JSON、自由文本错误或原始归档，Venice/业务/账务不写。LIMIT2001先预算、最多2000、指纹CAS/事务/ID/provider/类型守卫。主表DROP仅在两库未执行证明后修正：以真实snapshot schema账本边界分类旧终态账单/dedup/失败/真实pending，旧pending原样保留不伪造结算；现代未知/漏快照/身份或状态冲突/关联reserved继续阻断。先处置文件成功记账再主表DROP，TEST证据不替代Production；超窗旧账务停止自动回捞、独立核验。

## 主动停止原因与政策（2026-10-26）

chat_generation_requests.user_stop_billing_enabled在创建请求时确定：存量false、新轮true。service-only experience.cancel_chat_generation锁定具体session/history并裁决终态原因；新请求省略reason也按手动停止处理，不允许参数直接写入免费timeout。真实primary/fallback/global阶段截断优先免扣，未验证自动截止由现有watchdog确认。报价前不伪造账单；业务原因user_cancelled由billing资格读取，原报价和charge_id不改，历史无回填。

## 可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。

## 聊天准备阶段减负（2026-10-27）

新增 migration 20261027_chat_charge_lookup_index.sql，为高频 llm_charge_id 等值查找建立非空部分 B-tree。生产原查询计划为全表扫描；索引 CONCURRENTLY、无外层事务、有限资源/超时，失败无效索引先核验再恢复。不改收费函数、历史数据或权限。执行证据见任务 release-review。
