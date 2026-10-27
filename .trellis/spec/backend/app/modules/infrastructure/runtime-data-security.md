---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/10-16-creation-plaza-video-planning/
last_verified_at: 2026-10-27
---

# 运行时、鉴权与数据访问基建

## 职责与边界

## 当前状态

Supabase 按域访问，服务日志使用 Pino；模型目录由 `platform/model-tiers.ts` 集中读取 `llm_model_catalog`，损坏时降级到 `DEFAULT_CATALOG`，不再读取旧 tiers key。PostHog capture 使用 `POSTHOG_API_KEY`/`POSTHOG_HOST`/`POSTHOG_TIMEOUT_MS`，缺 key 或非法 host 时 no-op。

`runtime-config.ts` 的单键读取支持调用方传入取消信号，供 Admin 状态读取等严格查询使用。无调用方 signal 的非严格单键和相同键集批量读取会在进程内合并同时在途的 Promise，但不跨请求缓存配置结果；严格读取和自定义 signal 始终保持独立取消边界。对话的文本后处理版本不再由进程缓存维护，而由数据库开轮事务读取权威指针并绑定。

MiniApp 已鉴权接口通过 `lib/user.ts` 把同一 Telegram 用户的并发 get-or-create 合并，并以 60 秒、最多 5000 项缓存不可变的内部 `id`/`created_at`。Telegram initData 仍逐请求验证，`source_id`、累计轮次、钱包、权益和额度不进入身份缓存；首次创建仍由 `tg_id` 唯一约束与回读保证幂等。

## 入口与调用者

## 涉及文件

| 路径                                                               | 职责                                     |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `packages/backend/src/platform/runtime-config.ts`                  | DB 运行配置入口                          |
| `packages/backend/src/platform/model-tiers.ts`                     | 模型目录读取/缓存                        |
| `packages/backend/src/middleware/auth.ts`                          | Telegram 鉴权                            |
| `packages/backend/src/lib/supabase.ts`                             | 按域数据库 client                        |
| `packages/backend/src/infrastructure/repositories/`                | 数据访问实现                             |
| `packages/backend/src/infrastructure/telemetry/posthog-capture.ts` | 服务端 PostHog capture、短超时、终态去重 |

## 关键实现链路

PostHog capture 用 Node 原生 fetch、短超时、无重试；支付按 `order_id:status:settled_by` 去重，图片按 `attempt_id:event:terminal_status|charge_status` 去重。

文本后处理版本链路为“current-postprocess RPC 读取 runtime 指针与不可变快照 → 委托显式版本 wrapper → 同事务写入消息版本”。新 RPC 不可用或当前配置非法时不回退旧 RPC；Admin 的独立严格读取超时会取消 PostgREST 请求。

## 数据、契约与外部依赖

## 关键节点与约束

用户身份缓存只减少重复映射读取，不是鉴权或业务状态真相；失败不缓存，多副本各自缓存不影响正确性。runtime-config single-flight 只共享完全相同的当前读取，失败后清理，不增加配置传播陈旧窗口，也不叠加 Supabase SDK 的 GET 自动重试。

## 验证方式

`lib/user.test.ts` 覆盖同用户合并、用户隔离、失败恢复、TTL 与容量；`platform/runtime-config.test.ts` 覆盖单键/键集、严格/自定义 signal 隔离和失败恢复。运行 Backend typecheck 与完整非 integration 测试。

## 已知缺口与待核验项

调用 ID 使用各自专表 NULL-only CAS，相同 ID 幂等、不同拒绝，写超时读回；每操作 5s、总 10s、有界两次写。缺失身份/metadata/计费/超时恢复独立预算及行失败隔离；OpenRouter NULL 不清旧事实/0 保留，无 key 不停 Venice；无新公开 API/配置。仅本地验证，部署门禁未过。

## 关联模块

`database.infrastructure.schema-security`、`database.business.conversation-storage`、`shared.business.conversation-contracts`、`backend.business.conversation-generation`,`backend.business.wallet-payment`。

## 图片创作广场 V2（2026-10-12）

图片广场目录、价格、标签、分享提示与开关从统一 runtime-config 入口读取并 fail closed；Venice 凭据只在服务端环境读取。原图和参考图存私有 bucket，HTTP 只返回短期签名 URL；worker 使用数据库租约恢复，日志只记允许字段与结果摘要。`image_plaza_tags_feature_enabled` 仅门控分享自动打标，不门控 feed 标签目录返回。

视频目录来自独立 managed key，只有 `VIDEO_PLAZA_WORKER_ENABLED=true`、Venice key 存在且启动时 ffmpeg/ffprobe 探测成功才对前端公开。视频与 poster 均在私有 `media-plaza-video` bucket；公开作品使用 24 小时稳定签名并进入同一有界 LRU，未公开产物使用短签。列表禁止返回/预签 MP4，日志不得记录下载 URL、提示词或参考图签名。

图片广场的 8 张表、3 个图片 RPC 与 PostgREST schema 暴露已在 TEST、Production 完成切换。图片 repository、视频 repository 和 seed 工具统一通过 `getDomainDb('media_plaza')` 直接访问，不探测或回退 `experience` / `miniapp_features` 旧路径；后续视频 M2/M3 以该已完成的物理迁移为前置条件。

初始数据导入器只接受 `image.civitai.com` HTTPS 源 URL，重定向逐跳限制在 `image.civitai.com`、`blobs-b2.civitai.com` 精确白名单，并设置 30 秒超时、最多 3 次安全重试、种子原图 50 MiB 流式上限、内容类型/魔数/尺寸校验；普通用户图片仍保持 20 MiB。需要代理时显式使用 HTTPS ProxyAgent，TLS 校验被关闭时拒绝执行。日志不记录提示词或源 URL；apply 需显式目标、有限批次与审核清单，Storage 路径按 Civitai Image ID 确定且禁止覆盖。

## 变更记录

- 2026-10-27：任务 `10-16-creation-plaza-video-planning` 合并已完成的图片 M1：TEST、Production 统一直连 `media_plaza`，删除双读/旧 schema 回退口径；视频 M2/M3 仍需按环境单独执行和验收。
- 2026-10-27：任务 `10-27-sentry-performance-optimization` 增加不可变用户身份 bounded cache/single-flight，并为非严格 runtime-config 读取增加无 TTL 的在途合并。

- 2026-10-15：任务 `10-15-image-plaza-tag-prompt-filter` 明确 `image_plaza_tags_feature_enabled` 只控制分享自动打标。
- 2026-10-13：任务 `10-10-image-plaza-v2` 记录种子导入的网络、内容、日志和环境门禁。

提供配置、Telegram/运营鉴权、域数据库 client、repository、日志、后台任务基座，以及非关键服务端 PostHog capture。不拥有具体业务状态机。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录 PostHog capture 泛化为服务端非关键终态事件；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）移除已删除的 Upstash 配置缓存事实并同步当前运行时配置边界；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
