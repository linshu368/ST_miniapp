# 当前实现调研（2026-09-09）

## 证据口径

- `SOURCE`：当前仓库源码事实。
- `MIGRATION`：migration 声明，不代表远端已执行。
- `DOC`：用户提供需求稿/交互演示或仓库文档。
- `GAP`：需求稿与源码/当前架构不一致。

## 链路 A

- [SOURCE] `ConversationPanel` 仅渲染 `message.content`，只调用 `csApi.sendMessage` 发送文本。
- [SOURCE] `cs-platform.ts` 先落 pending，再调 Telegram `sendMessage`，最后收口 sent/failed；已有 `idempotency_key` 和失败重试基础。
- [SOURCE] `bot.ts /api/telegram/webhook` 只解析 `message.text`；另有 `/api/cs/telegram/webhook`，存在双入口只改一处的风险。
- [SOURCE] Telegram fetch 当前部分调用未设置超时，是本次必须修复的既有可靠性缺口。
- [SOURCE] `CsPlatformRepository` 已承载文本入站、出站消息和 session/waiting 状态，适合兼容扩展。

## 链路 B

- [SOURCE] Frontend SupportPage 已有文本 pending outbox、稳定 `client_msg_id`、失败重试、5 秒轮询和已读水位推进。
- [SOURCE] Backend support route 用 `(conversation_id,client_msg_id)` upsert 去重并维护 agent unread。
- [SOURCE] CS SupportConversationPanel 只支持文本，query key 包含 `env` 与 conversation ID。
- [SOURCE] Shared `SupportMessage`/请求和 CS support DTO 均只有 body 文本。

## 数据库与 Storage

- [MIGRATION] 024 创建 `cs_platform.outreach_messages`，`content` 必填，无图片字段。
- [MIGRATION] 064 创建原 `miniapp.support_messages`，`body` 必填，无图片字段。
- [MIGRATION] 099 已将 support 两表迁至 `cs_platform`；新需求稿仍写 `miniapp.support_messages`，属于过期 schema 名。
- [SOURCE] 仓库不存在 `support-image.ts`、`storeSupportImage`、`decodeUploadedImage`、客服图片 bucket 或客服图片路由。
- [SOURCE] `user-avatar.ts` 可复用 Base64 预检、magic-byte、限流下载和 Storage 模式，但只支持 jpeg/png/webp 且限制 2 MiB，不能直接满足本需求。
- [SOURCE] Backend 当前没有 Sharp 等通用图片处理依赖。

## 主要风险

1. 公开 bucket 会让私密客服截图变成持链接永久可读，规划改用 private bucket + 短时签名 URL。
2. Base64 放大约 1/3，默认 bodyLimit 可能在 5 MiB 原图前先拒绝，route 必须显式有界配置。
3. Storage、DB、Telegram 是跨系统写入，无法单事务；需 pending、确定路径幂等和补偿删除。
4. Telegram webhook 重投需要 `(telegram user,message_id)` 数据库去重，不能只靠内存。
5. CSS 缩小原图不减少带宽，不能满足“缩略图 <1s”；必须生成真实缩略图。
6. GIF/WebP 解码、像素炸弹和损坏图片需要实际解码校验，不只检查文件头。
7. 当前没有内容审核能力；必须作为上线风险确认，不把“如有”写成已具备。
