# P3 执行计划

每个子 PR 独立分支、独立合并，顺序 P3-1 → P3-2 →（观察一周）→ P3-3。

## P3-1 runConversationTurn

1. commit A「纯函数」：`resolveFirstTokenPolicy`、`interruptedFinishReason`，替换 4 处重复判断。跑 conversations 测试。
2. commit B「turn control」：新建 `turn-control.ts`，把计时器、取消轮询、首字超时记录、readyMs/checkpoint/观测状态、dispose 收进 `createTurnControl`；原函数改为调用它。跑 lifecycle 测试。
3. commit C「准备与 prompt」：`turn-preparation.ts` 的 `prepareTurnInputs`，同文件内 `loadTurnPrompt`。
4. commit D「执行与收口」：`createExecutionHooks`、`settleExecutedTurn`、`failTurn`；`runConversationTurn` 收敛为编排。
5. 每个 commit 后：`pnpm --filter @miniapp/backend exec tsc --noEmit` + `vitest run src/features/conversations src/routes/conversations*`；最后全量 backend test、`lint:complexity`（基线去掉该函数）、`lint:legacy`。
6. 自查：`git diff origin/dev -- '*.test.ts'` 为空；对照原函数逐段核对 await/副作用顺序。

## P3-2 executeGeneration

同样按「纯函数 → GenerationRun 上下文 → 准入/上游 → 派发 → 流式消费」分 commit，每步跑 `vitest run src/features/generation`，最后全量。

## 上线观察（每个子 PR）

合 dev → 随正常发布进生产 → 24h：

- Faro `st_roleplay_first_token` P95（整体 5001ms / Android 4536ms / iOS 5002ms 基线）与 6 秒无首字率（工程｜02 看板）；
- Sentry `/api/conversations*` 错误率与新 issue；
- 计费：sync-job 对账异常、`conversation.quota.cleanup_pending` 日志数。
  退化 → revert 该 squash commit。
