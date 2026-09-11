# 客服图片双向收发双链路规划

## 背景与目标

当前有两条相互隔离的客服沟通链路：

- 链路 A：Telegram 用户 ↔ Telegram Bot ↔ CS Platform「客服回访」；
- 链路 B：Frontend MiniApp「联系客服」↔ Backend ↔ CS Platform「客服工作台」。

两条链路现有文本闭环均已落地，但都不支持图片消息。目标是在不改变既有文本、SOP、未读、环境隔离和鉴权语义的前提下，让用户与客服在两条链路中均可发送、接收和查看单张图片。

## 当前事实与需求文档差异

- 当前源码中不存在需求文档所述 `support-image.ts`、图片上传接口、图片 DTO 或 migration 068 图片字段；这些内容均应按“待实现”规划，不能按“已部分实现”验收。
- Schema 划分后站内客服表已从 `miniapp` 移到 `cs_platform`。新 migration 必须修改 `cs_platform.support_messages`，不得继续修改 `miniapp.support_messages`。
- `cs_platform.outreach_messages` 当前只有必填文本 `content`；`cs_platform.support_messages` 当前只有必填文本 `body`。二者都需要兼容扩展。
- 回访有主 Bot `/api/telegram/webhook` 与 CS 专用 `/api/cs/telegram/webhook` 两个入口；实施时必须确认部署实际 webhook 指向，并让两者复用同一解析/入站服务，避免只修一条入口。
- 仓库当前没有通用客服图片处理 helper，也没有 `miniapp-support-images` bucket/policy migration；只能复用头像上传的 magic-byte、限流读取和 Storage 写入模式，不能声称已有完整 helper。

## 范围内需求

### 通用图片规则

- 单条消息只能是纯文本或单张图片，不做图文混排和批量发送。
- 单张原图不超过 5 MiB；Frontend、CS Platform 在读取文件前预校验，Backend 按解码后的真实字节数二次校验。
- 支持 JPEG、PNG、GIF、WebP；Backend 通过 magic bytes 判型，并校验声明 MIME 与内容一致，不信任扩展名。
- 原图与缩略图均存入 Supabase Storage。列表展示缩略图，Lightbox 展示原图。
- 客服图片属于私密会话内容，Storage bucket 必须为 private；API 返回短时签名 URL，不将 service-role 或永久公开可枚举 URL暴露给浏览器。
- 客户端统一提示：“仅支持 jpg/jpeg/png/gif/webp，单张不超过 5MB”。
- 文本消息保持现有 DTO 和行为兼容；历史行按文本消息解释。

### 链路 A：Telegram 回访

- Telegram 用户发送 photo 时，Backend 选择 `photo[]` 中分辨率/文件尺寸最大的可用项，调用 Bot API `getFile` 后立即限时、限流下载。
- 下载成功后生成缩略图与原图对象，落一条 `direction=user` 的图片消息，记录 Telegram `file_id`、`message_id` 和图片元数据；CS 回访面板在现有轮询周期内显示。
- Telegram 用户发送 document/video 等非图片附件时，不落客服图片消息，并由 Bot 回复“目前仅支持发送图片”；作为 document 上传但 magic bytes 是图片的文件本期仍按“非 photo 附件”处理。
- Telegram 图片超过限制、下载失败或已不可用时，不落伪成功图片消息；记录安全的失败摘要并向用户给出可理解提示。
- CS 回访面板可选择单张图片并发送；Backend 校验/存储后使用同一 CS Bot 的 `sendPhoto` 发送二进制或受控文件，不依赖短时签名 URL供 Telegram 异步拉取。
- 客服发送记录延续 `pending → sent/failed` 状态机，保存 Telegram 返回的 message id；失败消息可复用相同幂等键重试且不得重复落消息。
- 图片消息继续参与现有 waiting state、last message time、消息排序和会话刷新，但列表预览应显示“[图片]”，不把 URL 当正文。

### 链路 B：MiniApp 站内客服

- Frontend 联系客服页新增可访问的“添加图片”按钮，使用 `accept=image/*` 调起相册/相机；选中后立即显示本地预览和发送中遮罩。
- Frontend 使用现有 `src/lib/api/support.ts` React Query mutation 上传图片和发送图片消息，组件内不得直接 fetch。
- 用户图片消息继续用稳定 `client_msg_id` 幂等；上传成功但消息确认失败时可用同一 ID 重试，不重复创建消息或 Storage 对象。
- CS 客服工作台通过现有 `src/api.ts` 上传/发送图片；query key 必须继续包含环境和会话 ID，环境切换不得串图。
- 两端图片均显示圆角缩略图，点击打开 Lightbox；ESC、遮罩、关闭按钮可退出，焦点可恢复，移动端支持浏览器原生缩放/查看。
- 发送失败时保留本地预览并明确显示失败状态，可点击重试；Object URL 在确认、移除或卸载时释放。
- 图片消息沿用现有客服未读/已读、agent unread、会话排序和通知行为。

### 安全、隐私与可观测性

- 上传接口沿用用户侧 `requireTelegramAuth` 与 CS 侧 `requireCsAdmin`；读取签名 URL 前仍需先验证消息所属用户/当前 CS 会话权限。
- 日志只记录链路、消息 ID、对象路径摘要、字节数、MIME、耗时、结果和 Telegram 状态码类别；不得记录 base64、签名 URL、Bot token、图片正文或完整 Telegram payload。
- Telegram `getFile`、文件下载和 `sendPhoto` 都必须有明确超时；只对安全阶段做有限退避重试，不能因路由重试制造重复消息。
- 不接入尚不存在的内容审核服务。上线前由产品确认是否接受“仅权限隔离、无自动审核”；若不接受则停止上线，而不是在本任务虚构审核能力。

## 明确不做

- 图文混排、caption 展示、多图/相册、文件发送、图片编辑、撤回、图片独立已读状态。
- 自建 CDN、队列、WebSocket、通用媒体框架或跨业务附件系统。
- Telegram 原生聊天 UI 改造。
- 把 Base64、签名 URL或数据库行类型作为跨应用公共契约。

## 验收标准

- [ ] Telegram 用户发一张 ≤5 MiB 的支持格式图片后，CS 回访面板在 30 秒内出现缩略图，点击可看原图。
- [ ] CS 回访客服发图后，Telegram 用户在 10 秒内收到原生 photo；数据库状态为 sent，并记录 Telegram message id。
- [ ] MiniApp 用户发图后，本地先显示预览，CS 客服工作台在 10 秒内看到同一图片；刷新后消息仍存在。
- [ ] CS 客服工作台发图后，MiniApp 在 10 秒内看到图片；客服未读红点、进页已读和现有文本行为不回归。
- [ ] 四个界面都只允许单图，支持 JPEG/PNG/GIF/WebP，前后端均拦截 >5 MiB、空文件、伪装 MIME 与损坏图片。
- [ ] 任意历史文本消息无需数据回填即可正常展示、发送、重试和统计。
- [ ] 同一 `client_msg_id`/`idempotency_key` 重复提交不会生成重复消息；重试不会覆盖其他会话对象。
- [ ] Telegram 403、429、getFile 失败、Storage 失败、签名 URL过期、网络中断均有明确失败态，且不会返回“发送成功”。
- [ ] Lightbox 支持按钮、ESC、遮罩关闭，有图片替代文本/状态说明，键盘焦点不丢失；移动端安全区与软键盘不遮挡发送控件。
- [ ] private bucket、对象路径、签名 URL时效、service-role 写入和授权边界在 test 环境完成验证；生产不自动执行 migration。
- [ ] Shared/Backend/Frontend 相关自动化测试通过；CS Platform typecheck/build 通过，并完成 test 环境两条链路双向真机回归。

## 发布约束

- 目标分支为 `dev`；应用包之间只通过 HTTP 和 `@miniapp/shared` 契约通信。
- migration 只允许放在 `packages/shared/migrations/`，一次执行一个文件，先 test 后 production。
- 数据库兼容扩展必须先上线，之后才能发布读取/写入图片字段的 Backend；最后发布 CS Platform 与 Frontend。
- 若缩略图处理、private bucket 授权、真实 Bot 双向测试或无审核风险确认任一未通过，则停止生产发布。
