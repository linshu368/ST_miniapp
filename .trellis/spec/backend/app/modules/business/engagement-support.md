---
module_id: backend.business.engagement-support
title: 社区、消息与客服
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/archive/2026-10/10-29-optimize-sentry-slow-pages-apis/
last_verified_at: 2026-10-29
---

# 社区、消息与客服

## 职责与边界

负责邀请/社区奖励、站内通知和用户客服会话。

## 当前状态

本地候选（尚未发布，2026-11-06）：新增 GET /api/users/onboarding，使用 requireTelegramAuth 与已有 getOrCreateDbUserRecord。按服务端账号 created_at 距今不足24小时且 total_round<10 判断首次入组，返回 eligible/expires_at（注册后7天）。只做有界身份读取，不查聊天正文或历史列表；资格是UI提示，不授予业务权限/奖励。故障返回503，日志只有是否符合和耗时/标准错误。无数据库迁移；发布时后端兼容接口先于前端。

增长弹窗（2026-11-13，任务 `11-13-growth-prompts`）：`GET /api/growth/prompts` 返回当下满足前置条件与展示上限的弹窗（进群：社群开启、未领奖、不在活动前名单、最近成员状态不在群，最多 2 次/间隔 24h；VIP：购买开启、非有效 VIP，最多 3 次/间隔 3 天，`first_paid_at` 非空只 1 次）和 `total_rounds`；轮数门槛（13/50）由前端判断时机。`POST /api/growth/prompts/events` 记录 shown/accepted/dismissed，shown 由 `miniapp_features.record_growth_prompt_event` 原子判定上限。发奖 webhook 在首次 `rewarded` 后、或没账号的人首次有效入群后，用发奖 bot 在群里发欢迎语（点名、到账星尘、MiniApp 深链按钮），只保留最新一条；`already_rewarded`/重复入群不发。欢迎语失败只记 warn，不影响 webhook 2xx。

主要互动 API 已实现。邀请和官方社群等发奖 RPC 保留各自业务判定，但钱包加值与流水最终统一调用 `billing.grant_bonus_credits`。客服业务由独立 `ST_cs_platform` 服务负责，本仓库保留 Telegram 鉴权、用户身份映射和 `/api/support/*` 代理。

## 入口与调用者

Frontend profile、通知与客服页面调用对应 `/api/*`。

## 涉及文件

| 路径                                                   | 职责                                     |
| ------------------------------------------------------ | ---------------------------------------- |
| `packages/backend/src/routes/community.ts`             | 社区奖励                                 |
| `packages/backend/src/features/community/facts.ts`     | 领奖事实、在群状态（入口与增长弹窗共用） |
| `packages/backend/src/features/community/welcome.ts`   | 入群欢迎语（发奖 bot 发送、删上一条）    |
| `packages/backend/src/routes/growth-prompts.ts`        | 增长弹窗资格与事件                       |
| `packages/backend/src/features/growth/prompt-rules.ts` | 增长弹窗门槛、上限与前置规则             |
| `packages/backend/src/routes/notifications.ts`         | 消息中心                                 |
| `packages/backend/src/routes/support.ts`               | 用户鉴权与客服服务代理                   |
| `packages/backend/src/lib/cs-service.ts`               | 客服上游超时与 HTTP 调用                 |

## 关键实现链路

用户鉴权 → 身份映射 → 客服上游代理 → 原样透传状态码与信封。每次代理记录固定 operation、status、identityMs、upstreamMs 和 totalMs；失败以原始 `{ err }` 记录后抛出。

## 数据、契约与外部依赖

依赖 miniapp_features、cs_platform、billing 和 shared 互动契约。

## 关键节点与约束

增长弹窗的展示上限以服务端表为准，前端本地状态只管「本次打开只弹一个」和轮数增量；欢迎语只挂在发奖结果之后，sendMessage 不重试（非幂等）。奖励不可由前端去重充当真相；应用层不得手动增加 `bonus_credits`；客服内容不得进入普通遥测。客服代理日志不得包含用户 ID、消息正文、完整 URL、initData、token 或大响应正文；本仓库不对独立客服服务结果增加重试或跨用户缓存。

## 验证方式

对应 route/repository tests、support 代理成功/失败日志断言与 Frontend `@profile` 回归。

## 已知缺口与待核验项

跨 Telegram 官方社区成员状态依赖外部 API 可用性；客服上游真实 P95 需发布后按 identity/upstream/total 分段判断，若 upstream 主导应在独立客服仓库处理。

## 关联模块

`frontend.business.engagement-support`、`backend.business.wallet-payment`、`database.business.billing-payment`。

## 变更记录

- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）移除已退场许愿池的模块事实并保留其余互动能力边界；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
- 2026-10-29：任务 `Optimize Sentry slow pages and APIs`（`.trellis/tasks/archive/2026-10/10-29-optimize-sentry-slow-pages-apis/`）为客服代理补齐身份解析、上游与总耗时安全日志；commit：`f73e38a11dcf8556aba669c88dbd401569618cdf`。
