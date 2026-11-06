# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                       | Files / Scope       | Depends On | Verification               |
| --- | ------ | -------------------------- | ------------------- | ---------- | -------------------------- |
| T1  | Done   | 契约/六秒冻结预算/轻量补报 | Shared、Frontend    | -          | 契约/时钟/补报有界回归     |
| T2  | Done   | 原RPC兼容无编号回报        | SQL、既有PG harness | T1         | 索引计划、幂等、权限、计费 |
| T3  | Doing  | TEST配置只读核对及全量验证 | TEST、全部消费者    | T2         | 只读配置、真实流           |
| T4  | Todo   | 先dev后生产及配置核对      | 既有CI/运营/Grafana | T3         | 生产6s/DS2s、部署核对      |

## Execution Log

- 不重复改动已修复的连接争抢/传输，不引入数据库扫描，不回填历史结果。
