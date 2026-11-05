---
module_id: frontend.business.wallet-payment
title: 钱包、签到与充值
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/11-03-five-route-navigation-p95/
last_verified_at: 2026-11-04
---

# 钱包、签到与充值

## 职责与边界

展示余额、消费、签到、充值套餐、订单状态和支付回跳。

## 当前状态

钱包与支付页面已使用统一 API hooks；结算真相在服务端。`/profile` 的真实头像、编辑和功能入口 shell 可交互后即记录页面 ready，余额继续独立 loading/error/retry，不能用占位符冒充余额，也不能让钱包长尾代表整页均不可见。底栏只在明确 profile intent 时预取余额 query，复用同一缓存和超时，失败不阻止导航。

Profile 首帧只立即读取钱包；消息/客服红点由常驻 BottomNav 拥有网络读取，页面只观察共享缓存。签到、VIP与套餐在首帧绘制后启动，头像设置按打开菜单读取，邀请与社区入口在服务区接近视口时启动；禁用阶段保留 loading/disabled 安全语义，IntersectionObserver 不可用时直接放行，不让入口永久缺失。

## 入口与调用者

用户从个人中心进入钱包/充值流程。

## 涉及文件

| 路径                                                 | 职责                     |
| ---------------------------------------------------- | ------------------------ |
| `packages/frontend/src/app/(main)/profile/page.tsx`  | 个人中心充值入口点击埋点 |
| `packages/frontend/src/app/(main)/profile/recharge/` | 充值页面                 |
| `packages/frontend/src/app/(main)/profile/orders/`   | 订单页面                 |
| `packages/frontend/src/app/(main)/profile/spending/` | 消费页面                 |
| `packages/frontend/src/lib/api/free-quota.ts`        | 额度 hooks               |
| `packages/frontend/src/lib/api/payment.ts`           | 支付 hooks               |

## 关键实现链路

套餐/余额 query → 创建订单 → 外部支付 → 订单轮询/回跳 → 缓存刷新。

## 数据、契约与外部依赖

消费 shared wallet/payment 契约、Backend 和外部支付页。

## 关键节点与约束

前端轮询不执行入账真相；支付成功后以服务端订单/余额为准。

## 验证方式

Frontend tests/build 与 test 支付人工 smoke。

## 已知缺口与待核验项

WebView 回跳和第三方页面兼容需真机验证。

## 关联模块

`backend.business.wallet-payment`、`shared.business.wallet-payment-contracts`。

## 变更记录

- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。
- 2026-11-04：任务 `Optimize five-route mobile navigation readiness`（`.trellis/tasks/11-03-five-route-navigation-p95/`）将 profile 页面 ready 与钱包异步结果解耦，并增加显式导航 intent 的余额预取；钱包 API P95 继续单独观测。
- 2026-11-04：同任务二阶段将 Profile 查询按钱包、首帧后和近视口三级启动，减少移动端首帧请求扇出；未改变服务端结算与各区错误/重试语义。

## 支付供应商替换为 Vexutopia（2026-11-03）

前端只打开 https 收银台（`isAllowedPaymentOpenUrl` 不再接受 http 与 `weixin://`，`openPaymentUrl` 删除 scheme 分支）。充值页、VIP 页、订单结果页删除收银台确认上报与回填；“继续付款”所需的收银台地址缓存不变。

## VIP 混合星尘奖励（2026-11-05）

月卡卡片、我的页、签到引导与到账提示显示专项/通用两部分；总数仍为 3000/150。复用原查询及按钮，不新增页面请求。固定验收 vip-mixed 覆盖 390/320 宽度与钱包到账。

隔离 PG 覆盖并发、幂等、旧订单及故障回滚；远端执行与部署状态见任务 `11-05-vip-mixed-rewards` 的发布记录。
