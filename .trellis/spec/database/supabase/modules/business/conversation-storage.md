---
module_id: database.business.conversation-storage
title: 会话、语音与图片存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-13
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

## 变更记录

- 2026-10-13：任务 `10-10-image-plaza-v2` 增加初始作品来源模型和 2000 字约束前向迁移。

last_verified_task: .trellis/tasks/09-11-chat-image-generation-plan/
last_verified_at: 2026-09-14

## T9 专表旧别名清理（本地实现，远端未执行）

新增独立 `20261016_openrouter_chat_history_drop_legacy_aliases.sql`：删除11个重复别名，保留canonical原名列、llm_generation_id/data及UNIQUE/FK/ACL；仅填NULL原名安全字段、非空冲突/未知依赖/超过2000候选拒绝。显式删除8个旧别名CHECK，canonical CHECK保留。不把待回捞metadata空值判为失败，不改父行业务事实或Venice。可先清专表，主表DROP仍有独立历史JSON/结算和运行门禁；不搬raw JSON、不伪造结算。PG17/PostgREST双处真实删列回归见任务T9报告；真实环境覆盖与所有旧writer退出仍需独立验收。
