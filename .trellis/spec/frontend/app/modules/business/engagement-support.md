---
module_id: frontend.business.engagement-support
title: 个人互动、通知与客服
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/09-08-feature-module-spec-sync/
last_verified_at: 2026-09-08
---

# 个人互动、通知与客服

## 职责与边界

承载官方社区、邀请、消息中心和站内客服 UI。

## 当前状态

个人中心相关入口与主要查询/变更操作已落地。

## 入口与调用者

用户从 `/profile`、消息中心和客服页面进入。

## 涉及文件

| 路径                                                | 职责                   |
| --------------------------------------------------- | ---------------------- |
| `packages/frontend/src/app/(main)/profile/page.tsx` | 个人中心               |
| `packages/frontend/src/components/profile/`         | 社区/邀请组件          |
| `packages/frontend/src/lib/api/`                    | 互动、通知与客服 hooks |

## 关键实现链路

页面 → query/mutation → Backend 业务校验 → 缓存更新和结果提示。

## 数据、契约与外部依赖

消费 community/invite/notifications/support 契约。

## 关键节点与约束

session 去重仅用于交互，不可替代奖励幂等；输入正文不写遥测。

## 验证方式

Frontend tests/build 与用户主路径人工回归。

## 已知缺口与待核验项

Telegram 社区跳转与真实成员校验需真机验证。

## 关联模块

`backend.business.engagement-support`、`shared.business.engagement-support-contracts`。

## 变更记录

- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）移除已退场许愿池的模块事实并保留其余互动能力边界；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
