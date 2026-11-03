# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                                                                                | Files / Scope                                                                                                                     | Depends On                            | Verification                             |
| --- | ------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| T1  | Done    | Vexutopia 网关适配器（建单/查单/验签/错误分类/重试）                                                | `infrastructure/payment/VexutopiaPaymentGateway.ts`(+test)                                                                        | -                                     | 网关单测                                 |
| T2  | Done    | 配置替换 + 环境标签                                                                                 | `platform/config.ts`                                                                                                              | -                                     | typecheck                                |
| T3  | Done    | 下单写交易号、金额范围校验                                                                          | `RechargeUseCase.ts`、`MiniappPaymentOrderRepository.ts`                                                                          | T1,T2                                 | RechargeUseCase 测试                     |
| T4  | Done    | 对账改为批量 lookup（新 `PaymentReconciliation`，替换快速对账与判过期逐单查单）；单笔查单改传订单行 | `PaymentSettlement.ts`、`PaymentReconciliation.ts`(新)、删 `FastPaymentReconciliation`/`ExpirePaymentOrders` 用例、两个 cron 脚本 | T1                                    | 对账测试                                 |
| T4b | Done    | 告警规则 v3（只看平台直接信号），监控仓库只读事件                                                   | `PaymentAlertRules.ts`、`PaymentAlertMonitor.ts`、删 `PaymentAlertAggregation`                                                    | T4                                    | 规则测试                                 |
| T4c | Done    | 删除收银台确认链路                                                                                  | backend 用例/路由、shared schema、frontend 三页 + `open-created-payment`/`open-storage`                                           | T5                                    | frontend/shared 测试与 typecheck         |
| T5  | Done    | Webhook 新路由、回跳改为只导航+查单、删除旧路由与表单解析                                           | `routes/payment.ts`(+test)                                                                                                        | T1,T4                                 | 路由测试                                 |
| T6  | Done    | Webhook 管理脚本；删除诊断脚本                                                                      | `scripts/payment-webhooks.ts`、`package.json`                                                                                     | T1                                    | 手动 `list`                              |
| T7  | Done    | 删除 `ZqPaymentGateway` 及全部引用                                                                  | backend                                                                                                                           | T3–T6                                 | 残留 grep 为空                           |
| T8  | Done    | 环境示例、PR 环境 workflow、Railway/README/ARCHITECTURE/spec 同步                                   | docs/ops/.github/.trellis/spec                                                                                                    | T7                                    | 人工审阅                                 |
| T9  | Done    | 全量验证                                                                                            | 全仓                                                                                                                              | T1–T8                                 | 测试、`pnpm -r typecheck`、backend build |
| T10 | Blocked | TEST 环境真实支付验收                                                                               | Railway development                                                                                                               | T9；需用户换新 key、注册 TEST Webhook | implement.md 验收表                      |
| T11 | Blocked | 生产发布                                                                                            | Railway production                                                                                                                | T10 通过；用户确认                    | 生产小额冒烟                             |

## Execution Log

- 2026-11-03：创建任务与规划文档，用户审核通过并 start。用户确认老供应商整体删除、不做兼容。
- 2026-11-03：实测 `POST /v1/payments/lookup` 与根交易号状态；用户确认对账与告警一起改为平台直接信号（design 2.7）。
- 2026-11-03：T1–T9 完成。验证：backend 117 文件 / 1298 测试、frontend 69 / 757、shared 18 / 234 全过；`pnpm typecheck`、`lint`、`lint:imports`、`lint:legacy`、frontend build 通过。用开发 key 实测：建单请求形状、GET 与 lookup 的状态和 metadata 回显、Webhook 端点列表可用；发现幂等重放返回 409、China Pay 收银台 30 分钟过期（已写入 design 2.8）。为验证建了两笔未支付 ¥1 订单（tx_229a1bf154741ac3、tx_70d6d5304826fdbb），30 分钟后自动过期。尚未经过真实付款端到端验收（T10）。
- 2026-11-03：用户授权直接经 dev 上生产。#618 合入 main（630758f3）、#617 合入 dev（0d34ad9f）；生产四个服务部署成功。生产 Railway 写入 `VEXUTOPIA_API_KEY`（API/对账/过期）与 `VEXUTOPIA_WEBHOOK_SECRET`，注册端点 `cmw0d1r027esns701qccyfziz`。生产验证：/health 200、未签名回调 401、签名的合成他环境事件 200 ignored、/api/payment/plans 200、对账 worker 与过期 cron 批量查单正常。发现告警指标名被卡片安全策略拒绝，热修 `fix/vexutopia-alert-metric`。
