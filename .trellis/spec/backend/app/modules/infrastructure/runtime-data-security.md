---
module_id: backend.infrastructure.runtime-data-security
title: 运行时、鉴权与数据访问基建
scope: backend
category: infrastructure
status: active
owners: [backend]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-13
---

# 运行时、鉴权与数据访问基建

## 职责与边界

## 当前状态

Supabase 按域访问，服务日志使用 Pino；模型目录由 `platform/model-tiers.ts` 集中读取 `llm_model_catalog`，损坏时降级到 `DEFAULT_CATALOG`，不再读取旧 tiers key。PostHog capture 使用 `POSTHOG_API_KEY`/`POSTHOG_HOST`/`POSTHOG_TIMEOUT_MS`，缺 key 或非法 host 时 no-op。

`runtime-config.ts` 的单键读取支持调用方传入取消信号，供 Admin 状态读取等严格查询使用。对话的文本后处理版本不再由进程缓存维护，而由数据库开轮事务读取权威指针并绑定。

## 入口与调用者

## 涉及文件

| 路径                                                               | 职责                                     |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `packages/backend/src/lib/supabase.ts`                             | 按域数据库 client                        |
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

## 验证方式

## 已知缺口与待核验项

## 关联模块

`database.infrastructure.schema-security`、`database.business.conversation-storage`、`shared.business.conversation-contracts`、`backend.business.conversation-generation`,`backend.business.wallet-payment`。

## 图片创作广场 V2（2026-10-12）

图片广场目录、价格、标签、分享提示与开关从统一 runtime-config 入口读取并 fail closed；Venice 凭据只在服务端环境读取。原图和参考图存私有 bucket，HTTP 只返回短期签名 URL；worker 使用数据库租约恢复，日志只记允许字段与结果摘要。`image_plaza_tags_feature_enabled` 仅门控分享自动打标，不门控 feed 标签目录返回。

初始数据导入器只接受 `image.civitai.com` HTTPS 源 URL，重定向逐跳限制在 `image.civitai.com`、`blobs-b2.civitai.com` 精确白名单，并设置 30 秒超时、最多 3 次安全重试、种子原图 50 MiB 流式上限、内容类型/魔数/尺寸校验；普通用户图片仍保持 20 MiB。需要代理时显式使用 HTTPS ProxyAgent，TLS 校验被关闭时拒绝执行。日志不记录提示词或源 URL；apply 需显式目标、有限批次与审核清单，Storage 路径按 Civitai Image ID 确定且禁止覆盖。

## 变更记录

- 2026-10-15：任务 `10-15-image-plaza-tag-prompt-filter` 明确 `image_plaza_tags_feature_enabled` 只控制分享自动打标。
- 2026-10-13：任务 `10-10-image-plaza-v2` 记录种子导入的网络、内容、日志和环境门禁。

提供配置、Telegram/运营鉴权、域数据库 client、repository、日志、后台任务基座，以及非关键服务端 PostHog capture。不拥有具体业务状态机。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）记录 PostHog capture 泛化为服务端非关键终态事件；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-09-23：任务 `Admin VIP media configuration`（`.trellis/tasks/archive/2026-09/09-23-admin-vip-media-config/`）Admin ?? VIP ??????????????????/????????????；commit：`5413afeaae67e9ef168831ec050d3b8514df33dd`。
