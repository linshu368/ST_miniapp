# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                                                             | Files / Scope                                                 | Depends On | Verification                                                   |
| --- | ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| T1  | Done   | 恢复去抖：最后一次失败满 5 分钟后的成功才算恢复                                  | generation/provider-alerts.ts                                 | -          | provider-alerts.test.ts 新增 quiet window 用例                 |
| T2  | Done   | outbox 同事故同 transition 合并为最新一张                                        | alerting/delivery-worker.ts                                   | -          | delivery-worker.test.ts deliverBatch 用例                      |
| T3  | Done   | 每轮最多投递 10 张，遵守 min_delivery_interval_ms                                | alerting/delivery-worker.ts, scripts/payment-alert-monitor.ts | T2         | delivery-worker.test.ts 上限、retrying 提前结束、disabled 用例 |
| T4  | Todo   | 发布前清理 access_blocked 积压，部署后核对 superseded/succeeded 分布与飞书卡片数 | 生产 ops.alert_delivery_jobs                                  | T1-T3      | 人工核对                                                       |

## Execution Log

- 2026-11-19：T1–T3 完成。backend typecheck、`lint:complexity`、`lint:backend-logging` 通过；backend 单测 1982 个全部通过（conversation-folders 套件需要 Supabase 占位环境变量，补上后 7/7 通过）。
