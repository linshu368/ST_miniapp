# 技术设计：客服图片双向收发双链路

## 1. 设计原则与边界

保持两条业务流隔离，但共享 Backend 内部的图片校验、缩略图、Storage 和签名 URL能力：

```text
Telegram photo -> webhook -> Telegram media adapter -> support image service
  -> private Storage + cs_platform.outreach_messages -> CS 回访面板

Frontend file -> user upload API -> support image service
  -> private Storage -> support image message API -> cs_platform.support_messages
  -> CS 客服工作台

CS file -> CS upload/send API -> support image service
  -> outreach: Telegram sendPhoto + outreach_messages
  -> support: support_messages -> Frontend polling
```

共享的是“媒体基础能力”，不是消息表或业务状态机。`outreach_messages` 与 `support_messages` 的 ID、幂等、发送状态、query key 继续隔离。

## 2. 复用调研

| 检索对象                                                      | 结论                                                        | 决策                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `frontend/src/lib/api/support.ts`、SupportPage pending outbox | 已有文本 query/mutation、5 秒轮询、`client_msg_id` 重试去重 | 扩展现有 hooks/outbox，不新建第二套 client/store                               |
| `cs-platform/src/api.ts`、两个 ConversationPanel              | 所有请求已集中、React Query key 已区分 support/outreach/env | 扩展现有 API helper和组件，不直接 fetch                                        |
| `support.ts`、`cs-platform.ts` routes                         | 文本、鉴权、会话状态、未读和 Telegram 发送状态已存在        | 兼容扩展原 route；上传/图片发送用窄接口                                        |
| `CsPlatformRepository`                                        | 有 pending/sent/failed、幂等键、Telegram 入站落库           | 扩展输入/映射，不另建 outreach repository                                      |
| `lib/user-avatar.ts`                                          | 有 Base64 长度预检、magic bytes、限流下载、Storage 模式     | 提取/复用模式；客服图片单独 helper，避免头像业务耦合                           |
| `support-image.ts`                                            | 当前不存在                                                  | 新建最小 `lib/support-image.ts`，不建立通用媒体框架                            |
| 图片处理依赖                                                  | 当前无 Sharp/图像尺寸库                                     | 引入 `sharp` 仅用于校验可解码及生成静态缩略图；GIF 原图保留，缩略图取首帧 WebP |
| Storage bucket/policy                                         | 当前无客服图片 bucket，也无仓库内 objects policy            | 新 migration 创建 private bucket；浏览器只拿短时签名 URL                       |
| 内容审核                                                      | 当前没有现成服务                                            | 本期不虚构；作为上线风险确认/停止条件                                          |

## 3. 数据模型

在同一个新 migration 中对两表做兼容扩展；不改历史 migration。

### `cs_platform.support_messages`

- `message_type text not null default 'text' check in ('text','image')`
- `image_path text null`：private bucket 原图对象路径，不存签名 URL
- `thumbnail_path text null`：缩略图对象路径
- `image_meta jsonb null`：仅允许 `{mime_type,size_bytes,width,height,thumbnail_width,thumbnail_height}`
- 放宽 `body` 为 nullable，并改约束：text 必须 1..4000；image 必须有两个 path，body 必须 null。
- 保留 `(conversation_id, client_msg_id)` 唯一索引作为用户图片消息幂等真相。

### `cs_platform.outreach_messages`

- 同样增加 `message_type/image_path/thumbnail_path/image_meta`。
- `telegram_file_id text null`：仅入站 Telegram 图片需要。
- 复用现有 `telegram_message_id`，不再新增语义重复的 `telegram_sent_message_id`。
- 放宽 `content` 为 nullable，并增加按 message_type 的完整性约束。
- 保留现有 `(persona_id,user_id,idempotency_key)` 唯一索引。

### 数据约束与兼容

- 默认 `text` 使所有历史行无需回填即可读取。
- 不在表中存 `image_url/image_original_url`：签名 URL会过期，不应成为数据库事实。Shared DTO 在读取时返回临时 `image_url/image_original_url`。
- migration 使用短事务做 metadata-only 加列/约束调整；实施前在 test 记录表大小、锁等待与执行时长。约束可先 `NOT VALID` 再验证，避免长时间阻塞；最终是否采用由 test 实测决定。

## 4. Storage 与图片处理

- bucket：`miniapp-support-images`，`public=false`，`file_size_limit=5242880`，allowed MIME 为 jpeg/png/gif/webp。
- service-role 是唯一写入者；不授予 anon/authenticated 直接 list/read/write。
- 对象路径：`{environment-scope}/{flow}/{conversation-or-user-id}/{client-or-message-id}/original.{ext}` 与 `thumbnail.webp`。路径使用服务端已验证 UUID，不使用原文件名。
- `decodeSupportImage`：严格 Base64 长度预检、解码后 5 MiB 限制、magic-byte 判型、Sharp 解码验证/尺寸上限保护，返回受限联合类型。
- `storeSupportImage`：原图 `upsert:false`；稳定幂等键重试时先按确定路径探测/复用已存在对象。生成最长边约 520px 的 WebP 缩略图；原图不重编码。
- `signSupportImageUrls`：列表读取时批量签发短时 URL（建议 10 分钟），DTO 只包含签名结果。签发失败使单条图片显示 unavailable，不拖垮整段会话。
- 删除/补偿：Storage 成功而消息失败时立即 best-effort 删除；删除失败记 orphan 日志。另评估按路径/消息对账的运维脚本，不为本期引入常驻队列。

## 5. Shared 契约

兼容扩展而不暴露 DB row：

```ts
type SupportImageMeta = { mime_type; size_bytes; width; height; ... };
type SupportMessage =
  | { message_type: 'text'; body: string; image_url: null; image_original_url: null; ... }
  | { message_type: 'image'; body: null; image_url: string | null; image_original_url: string | null; image_meta: SupportImageMeta; ... };
```

`CsMessageData` 同样增加可判别的图片字段，但保留现有顶层形状以降低消费者改动。请求新增：

- `UploadSupportImageRequest/Response`：`data_base64/content_type/client_msg_id`，返回受控 upload token 或服务端对象引用；不返回可由客户端任意指定的 Storage path。
- `SendSupportMessageRequest` 扩为 text/image 判别联合，图片分支携带 `client_msg_id` 与 upload token。
- CS support/outreach 图片发送分别定义窄请求；外部 Telegram 原始响应不进入 shared。

Shared 应增加 runtime schema/纯函数校验测试，所有生产者和消费者只消费 shared DTO。

## 6. Backend 设计

### 链路 B

- `POST /api/support/images`：用户鉴权、8 MiB 左右 bodyLimit、校验并暂存确定路径，返回一次性/短时 upload token。
- `POST /api/support/messages`：兼容 text；image 分支在服务端验证 token 的 user/conversation/client_msg_id 绑定后 upsert 消息并更新会话未读。重复 client ID回读原消息。
- `POST /api/cs/support/conversations/:id/images`：CS 鉴权并校验 conversation；可直接完成存储+插入 agent image message，避免 CS 端二阶段悬挂。返回 `SendSupportMessageData`。
- GET 列表批量补签 URL，last_message 对图片规范化为 `[图片]`。

用户端保留二阶段 API 是为了符合既有 optimistic outbox；upload token 必须服务端签名且短时有效，不能信任客户端回传任意对象路径。若实现调研证明单请求更简单，可在不改变验收的前提下收敛为单请求，但需先更新本设计并评审。

### 链路 A

- 抽取 `parseTelegramInboundMessage`，供 `/api/telegram/webhook` 和 `/api/cs/telegram/webhook` 复用；保留两个入口现有 secret。
- `getFile`、下载、`sendPhoto` 使用 CS Bot token 与 `AbortSignal.timeout`。下载流边读边限 5 MiB，不先无界 `arrayBuffer()`。
- `sendTelegramPhoto` 优先 multipart 上传已校验的原图二进制，避免把 private/signed URL交给 Telegram 拉取。
- 入站使用 `(telegram_user_id, telegram_message_id)` 的数据库唯一约束或等价 repository 去重，防止 Telegram webhook 重投。若现表尚无唯一索引，新 migration 一并补充条件唯一索引。
- Webhook 不吞掉图片处理异常后仍报告业务成功：对 Telegram 可安全重投错误返回 5xx；不可重试格式/超限返回 200 并主动提示用户，避免重投风暴。
- 429 遵守 `retry_after`，最多有限重试；403/400 不重试。DB pending 已建立后异常必须收口 failed。

### 日志

每条外部调用记录 operation、message/user 的内部 ID摘要、attempt、status class、duration_ms、bytes；原始错误按 `{ err }`。禁止记录 token、完整 payload、base64、signed URL和图片内容。

## 7. UI 与状态

- 新建可复用但仅限各自应用包内部的 `ImageMessageBubble`/`ImageLightbox`；Frontend 与 CS Platform 不互相 import。
- Frontend pending outbox 扩展为 text/image 判别联合，持有 `File`/Object URL仅限内存；确认后由服务端消息替换。
- CS 两个 panel 可共用包内图片选择/Lightbox 组件，但发送 mutation 分开，防止混用 flow ID。
- 文件 input 可键盘触发且每次发送后 reset，允许再次选择同一文件。
- 图片 loading/error/unavailable 有文字状态；`img` 使用 lazy loading、固定尺寸避免布局跳动。

## 8. 可靠性设计

| 关注点    | 设计                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------- |
| 超时      | Telegram getFile/下载/sendPhoto 与 Storage 调用均设显式预算；前端 mutation 展示可恢复超时               |
| 有限重试  | 只重试 Telegram 429/网络瞬断、签名 URL刷新和幂等上传；403/格式错误不重试                                |
| 幂等      | support 用 client_msg_id；outreach 用 idempotency_key，入站用 Telegram message_id；对象路径由幂等键决定 |
| 并发      | DB 唯一索引裁决重复；会话计数仅在确实新插入消息时增加；不使用前端状态作真相                             |
| 事务      | DB 消息+会话摘要尽量用 RPC/事务完成；Storage/Telegram 无法加入 DB 事务，用 pending + 补偿               |
| 降级      | 单图签名/缩略图失败显示不可用占位，文本和其他消息继续加载                                               |
| 补偿      | 消息落库失败删除刚上传对象；Telegram 失败保留 failed 记录供重试                                         |
| 限流/容量 | 5 MiB、单图、流式下载上限；评估每用户/操作员上传速率限制，避免 Base64 请求放大                          |
| 可观测性  | allowlist 结构日志、耗时、失败阶段、Telegram 状态类别、orphan 计数                                      |

## 9. 最小充分方案与拒绝项

新增一份 migration、一个 Backend 图片 helper/少量 adapter、shared 契约扩展和现有三个 UI 面板改造即可。不新增消息总表、附件微服务、队列、WebSocket、全局媒体 store 或跨应用组件包。缩略图是明确性能需求，因此引入一个成熟图像库属于必要复杂度；若构建/运行环境无法稳定安装 Sharp，停止上线并重新评审，不以“原图 CSS 缩小”冒充缩略图。

## 10. 演进、发布与恢复

1. test 执行兼容 migration + private bucket，核验 shape/RLS/grants/锁/容量；旧 Backend 应继续工作。
2. 发布 Backend（能读写 text/image，旧 UI仍只发送 text）。
3. 发布 CS Platform，再发布 Frontend；先内部客服链路灰度，最后开放用户选图。
4. 观察上传失败率、Telegram 4xx/429、Storage 错误、消息去重和 orphan 日志。
5. 停止条件：鉴权越权、跨环境串图、重复消息、内存异常、Telegram 大面积失败、无审核风险未确认。

回滚优先应用 forward-fix/关闭 UI入口：先回滚 Frontend/CS，再回滚 Backend到仍能读取新增 nullable/default 字段的版本。数据库列和 bucket 不在紧急回滚中删除，防止新图片消息变得不可读；待确认无新写入并备份路径后再用独立回滚 migration 清理。生产 migration 不自动执行。

## 11. 待实施前确认

- 产品/安全确认 private bucket 与签名 URL方案，而不是需求稿中的永久 public URL。
- 确认无自动内容审核可接受；否则本任务阻塞。
- 确认真实环境使用哪个 Telegram webhook 入口及 CS Bot token，双入口均需回归。
- test/production 分别确认 bucket 名是否冲突，不能用 test 结论替代 production 实况。
