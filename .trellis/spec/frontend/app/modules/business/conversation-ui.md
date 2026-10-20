---
module_id: frontend.business.conversation-ui
title: 用户会话、语音与图片界面
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/10-10-image-plaza-v2/
last_verified_at: 2026-10-13
---

# 用户会话、语音与图片界面

## 职责与边界

负责会话列表、流式聊天、重生成、模型/生成偏好、语音、角色回复图片交互展示，以及图片生成用户侧 PostHog 事件。不拥有 PostHog SDK 初始化、后端图片生成或支付结算。

## 当前状态

文字回复等待 8 秒保留提示；本地或服务端 streaming 均展示“取消本次回复”，终态确认后在最新未成功回复下显示“重新生成”，复用原输入。客户端读流/取消/刷新均有限等待；旧请求身份隔离、消息去重防止切会话或取消后旧状态覆盖新回复。Telegram/移动设备验收仍未执行。

自研聊天 UI、SSE、工具箱、语音和图片交互代码已落地。图片只保留普通“看看TA”入口，支持免费描述、普通图片免费次数/付费预览、确认/自定义、生成中、失败、余额不足、ready 卡和 Dialog 预览；高级图按钮与 VIP 锁定交互已删除。图片 telemetry 继续只记录安全摘要。

## 入口与调用者

用户从 `/chats` 和 `/chat/[characterId]` 进入。

## 涉及文件

| 路径                                                           | 职责                                            |
| -------------------------------------------------------------- | ----------------------------------------------- |
| `packages/frontend/src/app/chat/[characterId]/page.tsx`        | 会话页、图片 footer 接线、`chat_image` 充值来源 |
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

图片 runtime 开关默认关闭；图 1~9、Telegram 长按保存、safe area/软键盘、PostHog Preview 真机事件和真实后端联调仍待 test 环境人工验收。

## 关联模块

`frontend.infrastructure.client-ui-foundation`、`backend.business.conversation-generation`、`shared.business.conversation-contracts`。

## 图片创作广场 V2（2026-10-12）

图片创作广场使用 `/create`、`/create/studio/[conversationId]` 与 `/create/work/[workId]` 独立路由；服务端数据统一由 `src/lib/api/image-plaza.ts` 的 React Query hooks 获取，不与聊天图片生成状态混用。

提示词手工输入与快照复用统一受 Shared 的 2000 字上限约束；“用同款”恢复初始作品快照，并保留种子作品 `auto_optimize=false`，避免再次改写原始提示词。真实移动端与 test 数据链路仍需人工验收。

## 变更记录

- 2026-10-13：任务 `10-10-image-plaza-v2` 补充 2000 字提示词上限和种子作品“用同款”快照恢复规则。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片生成 UI PostHog 安全事件 helper 与 chat_image 付费墙来源；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）移除许愿池残余说明并清理无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
