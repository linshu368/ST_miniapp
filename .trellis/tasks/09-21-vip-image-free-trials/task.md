# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                             | Files / Scope                         | Depends On              | Verification                            |
| --- | ------ | ------------------------------------------------ | ------------------------------------- | ----------------------- | --------------------------------------- |
| I0  | Done   | 接收公共底座、确认 assignee/分支和 advanced 配置 | 父任务 T2/T3 artifacts                | 父 T2；advanced 等父 T3 | 签名、migration、环境和配置边界稳定     |
| I1  | Done   | 扩展图片契约、tier 和 attempt 快照               | Shared images / DB experience         | I0 的 T2 部分           | schema 测试、旧请求/旧行兼容            |
| I2  | Done   | 接入 basic 免费预留、续租、失败释放和结算        | Backend image job/settlement          | I1                      | 并发、lease、失败、重放、main-only 测试 |
| I3  | Done   | 接入 advanced VIP/配置/main-only 门禁            | Backend image route/config/settlement | I1、父 T3               | 权限、配置、到期和钱包矩阵测试          |
| I4  | Done   | 更新图片确认与锁定 UI                            | Frontend image hooks/components       | I2,I3                   | UI 测试、typecheck、build、人工回归     |
| I5  | Done   | 完成 test 全矩阵并交回父任务集成                 | 全子任务范围                          | I1-I4                   | 证据、PR/commit、migration 与风险齐全   |

## Execution Log

- 2026-09-21：由父任务创建并完成初版规划；状态保持 `planning`，等待原图片模块工程师审核和认领。
- 2026-09-23：代码侧复核通过。图片链路已接入 basic_image 免费体验预留/释放/结算、高级图片 VIP 门禁、main_only 钱包预检与高级图片运行时配置；前端已展示免费体验序号/价格与高级图片锁定状态。验证通过：`pnpm --filter @miniapp/shared test`、`pnpm --filter @miniapp/shared typecheck`、`pnpm --filter @miniapp/backend test`、`pnpm --filter @miniapp/backend typecheck`、`pnpm --filter @miniapp/frontend test`、`pnpm --filter @miniapp/frontend typecheck`、`pnpm --filter @miniapp/frontend lint`、`pnpm --filter @miniapp/frontend build`、`pnpm -r typecheck`。
