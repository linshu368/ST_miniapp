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

主要互动 API 已实现。邀请和官方社群等发奖 RPC 保留各自业务判定，但钱包加值与流水最终统一调用 `billing.grant_bonus_credits`。客服业务由独立 `ST_cs_platform` 服务负责，本仓库保留 Telegram 鉴权、用户身份映射和 `/api/support/*` 代理。

## 入口与调用者

Frontend profile、通知与客服页面调用对应 `/api/*`。

## 涉及文件

| 路径                                           | 职责                     |
| ---------------------------------------------- | ------------------------ |
| `packages/backend/src/routes/community.ts`     | 社区奖励                 |
| `packages/backend/src/routes/notifications.ts` | 消息中心                 |
| `packages/backend/src/routes/support.ts`       | 用户鉴权与客服服务代理   |
| `packages/backend/src/lib/cs-service.ts`       | 客服上游超时与 HTTP 调用 |

## 关键实现链路

用户鉴权 → 身份映射 → 客服上游代理 → 原样透传状态码与信封。每次代理记录固定 operation、status、identityMs、upstreamMs 和 totalMs；失败以原始 `{ err }` 记录后抛出。

## 数据、契约与外部依赖

依赖 miniapp_features、cs_platform、billing 和 shared 互动契约。

## 关键节点与约束

奖励不可由前端去重充当真相；应用层不得手动增加 `bonus_credits`；客服内容不得进入普通遥测。客服代理日志不得包含用户 ID、消息正文、完整 URL、initData、token 或大响应正文；本仓库不对独立客服服务结果增加重试或跨用户缓存。

## 验证方式

对应 route/repository tests、support 代理成功/失败日志断言与 Frontend `@profile` 回归。

## 已知缺口与待核验项

跨 Telegram 官方社区成员状态依赖外部 API 可用性；客服上游真实 P95 需发布后按 identity/upstream/total 分段判断，若 upstream 主导应在独立客服仓库处理。

## 关联模块

`frontend.business.engagement-support`、`backend.business.wallet-payment`、`database.business.billing-payment`。

## 变更记录

- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）移除已退场许愿池的模块事实并保留其余互动能力边界；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
- 2026-10-29：任务 `Optimize Sentry slow pages and APIs`（`.trellis/tasks/archive/2026-10/10-29-optimize-sentry-slow-pages-apis/`）为客服代理补齐身份解析、上游与总耗时安全日志；commit：`f73e38a11dcf8556aba669c88dbd401569618cdf`。
