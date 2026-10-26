---
module_id: frontend.business.conversation-ui
title: 用户会话、语音与图片界面
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/10-23-dialogue-preference/
last_verified_at: 2026-10-23
---

# 用户会话、语音与图片界面

## 职责与边界

负责会话列表、流式聊天、重生成、模型/回复偏好（长度、回复模块、自定义要求）、语音、角色回复图片交互展示，以及图片生成用户侧 PostHog 事件。不拥有 PostHog SDK 初始化、后端图片生成或支付结算。

## 当前状态

`/chats` 现在是角色模块内部的「对话」栏目，全局导航为「角色 / 影像 / 我的」。发现与对话使用固定顶部栏目；角色收藏迁入发现的已收藏筛选，对话列表保留跨角色历史、置顶、重命名和删除确认，管理操作收进各行菜单并提供请求中/失败反馈。

角色详情按角色查历史，明确区分继续已有会话、显式新对话与首次开始；读取失败显示重试，不默认创建。`chatEntryPath` 仅携带 `from=discover|conversations`，旧链接和非法来源回退发现；会话创建、切换及 returnTo 保留来源，聊天顶部、Telegram BackButton 和 Splash 退出共同回来源栏目。语音和充值继续复用含会话身份的 returnTo；失效会话清理旧创建结果后沿既有重建路径恢复。

文字回复等待 8 秒保留提示；本地或服务端 streaming 均展示“取消本次回复”，终态确认后在最新未成功回复下显示“重新生成”，复用原输入。客户端读流/取消/刷新均有限等待；旧请求身份隔离、消息去重防止切会话或取消后旧状态覆盖新回复。Telegram/移动设备验收仍未执行。

自研聊天 UI、SSE、工具箱、语音和图片交互代码已落地。图片只保留普通“看看TA”入口，支持免费描述、普通图片免费次数/付费预览、确认/自定义、生成中、失败、余额不足、ready 卡和 Dialog 预览；高级图按钮与 VIP 锁定交互已删除。图片 telemetry 继续只记录安全摘要。

## 入口与调用者

用户从角色模块的 `/` 发现、详情或接着聊，以及 `/chats` 对话列表进入 `/chat/[characterId]`；`/chats` 原有链接继续有效，不再是独立全局底栏入口。

## 涉及文件

| 路径                                                           | 职责                                            |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `packages/frontend/src/app/chat/[characterId]/page.tsx`        | 会话页、图片 footer 接线、`chat_image` 充值来源 |
| `packages/frontend/src/app/(main)/chats/page.tsx`              | 模块内对话列表与管理菜单                        |
| `packages/frontend/src/components/roleplay/`                   | 固定模块栏目与接着聊卡片                        |
| `packages/frontend/src/lib/chat-entry.ts`                      | 会话入口与语音路径构造                          |
| `packages/frontend/src/lib/roleplay-navigation.ts`             | 有限来源、最后栏目和位置恢复                    |
| `packages/frontend/src/components/chat/`                       | 聊天组件                                        |
| `packages/frontend/src/components/chat/chat-message-image.tsx` | 图片面板、结果卡、预览与图片事件调用            |
| `packages/frontend/src/lib/image-generation/telemetry.ts`      | 图片生成前端事件 helper 与去重                  |
| `packages/frontend/src/lib/api/conversation-stream.ts`         | SSE client                                      |
| `packages/frontend/src/hooks/use-chat-session.ts`              | 会话生命周期                                    |
| `packages/frontend/src/hooks/use-conversation-turn.ts`         | 发送/重生成编排                                 |
| `packages/frontend/src/lib/recharge-redirect.ts`               | 充值跳转收口                                    |
| `packages/frontend/src/lib/api/images.ts`                      | 图片查询与 mutation                             |

## 关键实现链路

页面接线 → session/turn hooks → SSE 与气泡收敛；图片 query 在存在非终态 attempt 时按 1.8 秒轮询，message footer 按图片在上、语音在下注入，成功后刷新图片与钱包。图片 402 跳充值传入 `triggerSource: 'chat_image'`，复用付费墙/充值回流链路。

## 数据、契约与外部依赖

消费 shared conversations/voice/images/telemetry 契约和 Backend HTTP/SSE。图片 telemetry helper 只接收业务 ID、attempt 摘要、状态和错误码；实际保存图片仍使用 URL 调 Telegram 下载，但 URL 不进入事件属性。

## 关键节点与约束

服务端状态走 React Query；组件不直接 fetch；图片组件只持有局部面板状态，不接收内部英文 prompt，不把中文 prompt、图片 URL、Storage path、provider request id 或完整错误 body 送入 PostHog。

## 验证方式

`pnpm --filter @miniapp/frontend typecheck && pnpm --filter @miniapp/frontend test && pnpm --filter @miniapp/frontend lint && pnpm --filter @miniapp/frontend build`。

## 已知缺口与待核验项

角色模块本轮仅做本地界面与交互预览，`/tmp` 示例服务不进入产品提交，也不能作为真实 Backend、计费、Telegram WebView 或生产数据验收证据。新增导航的真实环境联调与原有移动端验收仍需单独执行。

图片 runtime 开关默认关闭；图 1~9、Telegram 长按保存、safe area/软键盘、PostHog Preview 真机事件和真实后端联调仍待 test 环境人工验收。

## 关联模块

`frontend.infrastructure.client-ui-foundation`、`backend.business.conversation-generation`、`shared.business.conversation-contracts`。

## 影像广场（图片创作广场 V2，2026-10-12）

影像广场当前已实现图片生成，使用 `/create`、`/create/studio/[conversationId]` 与 `/create/work/[workId]` 独立路由；服务端数据统一由 `src/lib/api/image-plaza.ts` 的 React Query hooks 获取，不与聊天图片生成状态混用。

提示词手工输入与快照复用统一受 Shared 的 2000 字上限约束；“用同款”恢复初始作品快照，并保留种子作品 `auto_optimize=false`，避免再次改写原始提示词。真实移动端与 test 数据链路仍需人工验收。

## 变更记录

- 2026-10-23：任务 `10-23-roleplay-module-navigation` 将历史会话移入角色模块「对话」，收藏归入发现，统一有限来源及顶部/Telegram/Splash 返回；影像广场保持独立生成链路。

- 2026-10-13：任务 `10-10-image-plaza-v2` 补充 2000 字提示词上限和种子作品“用同款”快照恢复规则。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片生成 UI PostHog 安全事件 helper 与 chat_image 付费墙来源；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）移除许愿池残余说明并清理无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## 轻量连续性改进（2026-10-23）

聊天与影像使用用户/模块/会话隔离的纯内存草稿，最多64条、2小时过期；不持久化或上报正文，不自动发送。空草稿优先于服务端快照；旧提交按身份、文本与编辑版本条件清空，A→B→A也不被误清。普通失败恢复仍绑定原会话；明确失效重建时只沿该恢复路径交接文本。

中文输入法确认候选不触发聊天发送；影像描述Enter换行，Ctrl/Cmd+Enter生成。对话列表上翻不强拉回最新，提供轻量返回最新/有新回复提示；角色内历史展示单行消息摘要，查询失败与成功空记录分开，有缓存时保留记录。

影像广场「我的生成」与工作室共用历史Sheet，只在打开时读取既有查询；浏览往返仅保存筛选、锚点及滚动标量，不存作品DTO/游标。历史再生成明确使用当前设置且保留composer草稿；失败刷新只查状态，不重新提交付费任务。画幅采用中文和形状示意，删除无实际选项的风格占位；保存沿既有Telegram下载能力，普通浏览器准确提示打开原图保存。真实报价、余额、幂等及后端契约不变。

## Scenario: 移动端思考进度与折叠（2026-10-23）

### 1. Scope / Trigger

输入区提供思考开关，等待过程可见且不抢角色正文重心。

### 2. Signatures

`ChatComposer.thinkingEnabled/onThinkingEnabledChange`、`StreamTurnOptions.thinkingEnabled/onReasoning`、`useConversationTurn.thinkingByMessage`、`ChatThinking`。

### 3. Contracts

默认on，用户级设备存储只存bool，生成中锁定当次值。独立reasoning事件不进入ChatMessage.content/cache；仅当前页面按session/id/revision保留最近12条、每条64Ki字符；切会话清空，离页/刷新不持久化。消息标题为`thinking`；输入区使用Atom原子轨道图标+“深度思考”胶囊，无问号/说明弹窗，aria-pressed和开关操作名称保留。真实思考到达展开，正文开始/终态自动收起一次，手动重新展开后不被正文delta抢状态。纯转义文字/低对比度/160px内部滚动，PostHog/Sentry遮罩，无思考则“正在准备回复”。

### 4. Validation & Error Matrix

未知/非法思考帧跳过且不记录payload；思考先于首正文flush、终态前flush。实际思考重置idle/8秒停滞提示，但不延长150秒绝对流期限。普通与深度思考模式在6秒无公开文本时都只上报SLA超时，不显示失败、不自动取消。旧请求/取消确认后的思考不得写当前消息；存储失败降级本页默认。关闭请求与重生成一致。

### 5. Good / Base / Bad Cases

Good：淡色展开思考→正文自动收起→用户展开查看。Base：没有公开思考就直接正文。Bad：每片正文都强制收起，或思考增长时把翻历史的用户拉回底部。

### 6. Tests Required

现有SSE/hook测试加序列与迟到/取消/开关快照；chat-thinking纯逻辑验证bool存储、隔离/容量、单次自动折叠。320/375/390px、虚拟键盘压缩高度、重生成/取消本地演示检查；不冒称真实手机或模型验收。

### 7. Wrong vs Correct

Wrong：思考与正文合并后传给ReplyRenderer/语音/图片。Correct：`thinkingByMessage`单独展示，原正文渲染与操作不变。

首字统一口径：开启深度思考时，真实思考文本首字与正文首字等效；静默思考跨过快速SLA只结束首字观测，不自动取消生成。关闭只算正文，6秒同样只结束观测、不自动取消。等待提示、thinking标题、密文占位不计；只有思考无有效正文仍不得扣费。

## 2026-10-23 可运营回复风格

回复偏好按generation-config公开目录动态呈现“回复风格”：纯文本名称/说明、独立多开、默认off、逐项pending与失败提示；无目录隐藏整段。React Query偏好map逐id更新/确认/回滚，无私有marker/rules、静态预设或生成接线。
