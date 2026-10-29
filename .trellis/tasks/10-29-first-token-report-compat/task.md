# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                  | Files / Scope                | Depends On | Verification                                           |
| --- | ------ | --------------------- | ---------------------------- | ---------- | ------------------------------------------------------ |
| T1  | Done   | 复现旧内核发送前失败  | 现有 client.retry.test.ts    | -          | 旧代码0次fetch，回归失败                               |
| T2  | Done   | 兼容超时小修          | reportConversationFirstToken | T1         | 排队/响应体均受3秒约束，成功清理timer                  |
| T3  | Done   | 完整前端验证          | tests/typecheck/lint/build   | T2         | 完整Frontend 489项、typecheck/lint/build与静态检查通过 |
| T4  | Doing  | 先dev后生产并核对部署 | 本次独立修复                 | T3         | 沿用此前测试后发布授权，不带无关功能                   |

## Execution Log

- 仅修复旧内核回报问题，不处理离页身份与重复开轮，不更改历史记录或计费规则。
