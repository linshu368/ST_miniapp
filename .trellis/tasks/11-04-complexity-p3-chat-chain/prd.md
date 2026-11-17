# 降复杂度 P3：拆分后端对话主链路长函数

父任务：`11-04-complexity-reduction`。

## Goal

对话主链路是 60 天内改动最频繁的区域（`generate.ts` 37 次提交、`execute.ts` 25 次），其中三个函数各 500 多行，改任何一处计费、超时或观测细节都要通读整段。把它们拆成命名清晰、可单独阅读的阶段函数，**行为、await 顺序、DB/RPC 调用次数、计时器和观测写入全部不变**。

| 函数                            | 位置                                             | 行数 | 子 PR                         |
| ------------------------------- | ------------------------------------------------ | ---- | ----------------------------- |
| `runConversationTurn`           | `features/conversations/generate.ts:131`         | 504  | P3-1                          |
| `executeGeneration`             | `features/generation/execute.ts:338`             | 559  | P3-2                          |
| `forwardWithFirstTokenFallback` | `features/generation/first-token-fallback.ts:64` | 507  | P3-3（P3-1/2 上线稳定后再定） |

## Requirements

- 纯重构：不改 API/SSE 契约、数据库、计费规则、首字预算、超时数值、日志事件名和字段。
- 现有测试**不修改**即全部通过（只允许因文件移动调整 import 路径）；这是行为未变的主要证据。
- 每个子 PR 只动一个函数；纯移动和改写分 commit。
- 编排函数拆后不超过约 120 行，提取出的函数各自不超过 120 行（复杂度预算阈值）。

## Acceptance Criteria

- [ ] `pnpm --filter @miniapp/backend typecheck`、`test`、`pnpm lint:complexity`、`pnpm lint:legacy` 通过；被拆函数从复杂度基线中移除。
- [ ] 测试文件 diff 为空（或仅 import 路径）。
- [ ] 上线后 24h 与基线对比无退化：点击到首字 P95（整体 5001ms / Android 4536ms / iOS 5002ms）、6 秒无首字率、`/api/conversations` Sentry 错误率、计费对账异常数。
- [ ] 任一指标明显退化即 revert 对应 squash commit。

## Android/iOS 性能 P95 门禁

见 `task.json.meta.mobile_performance`。
