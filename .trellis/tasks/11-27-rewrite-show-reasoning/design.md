# 技术设计

## 改动点（只动后端 features/generation）

1. **`generation-dispatch.ts` `createRecoveryForward`**
   - 去掉 `thinkingEnabled: false` 覆盖。重写请求与首字兜底用同一个 `createForward` 和同一份 request（只换 messages）。
   - 结果：OpenRouter 的 `reasoning` 按开关；Surplus 的 `surplusReasoningBody(fallbackSurplusReasoning, thinkingEnabled)` 按开关取 medium 或 none。
2. **`stream-recovery.ts` `runRecovery`**
   - 新增可选入参 `onReasoning`。generation-stream 传 `emit.reasoning`；`revealsReasoning(request)` 为否时它本来就是 undefined，即不显示、也不算出字。
   - 内部包一层：第一次输出（思考或正文）前调 `onReset`，之后照常转发。
   - 统计重写思考字数 `reasoningChars`，进 `RecoveryOutcome`，写进日志。
3. **`stream-pass.ts` `runStreamPass`**
   - `firstToken` 模式下（只有重写那一路），要显示的思考出现非空增量，也算「出字」：撤掉首字时限，开始卡顿计时。
   - 内部 `contentSeen` 的这两处用途改为 `outputSeen`（思考或正文）：`progress` 前置判断、`firstTokenMissed`。
   - 首发那一路不传 `firstToken`，行为不变。拒答检测仍只看正文。
4. **`generation-stream.ts` `resolveDelivered`**
   - 把 `emit.reasoning` 传给 `runRecovery`。
   - `llm.recovery.completed` 加 `reasoning_chars`。`first_token_ms` 的含义变为「第一次可见输出（思考或正文）」。
5. **文档与注释**
   - stream-recovery 头注释、shared `chat-recovery.ts`、shared `conversations.ts` 的 reset 事件注释、ARCHITECTURE 出字后兜底段：删掉「重写不显示思考 / 关闭思考展示」，擦除时机改为「第一次出字（思考或正文）」。

## 复用调研

- **复用 `emit.reasoning`**（generation-stream `createEmitters`）：首发与重写共用输出口，含 `noteFirstToken`、`hooks.onReasoningDelta`。turn-execution 那边按 `revealReasoning` 发 SSE `reasoning`，并写交付缓存。不新建输出通道。
- **复用 `revealsReasoning` / `shouldRevealReasoning`**（reasoning-display.ts）：显示规则不另起一套。
- **复用 `createForward` / `buildUpstreamBody` / `surplusReasoningBody`**：思考参数沿用首发与首字兜底的写法。
- **前端 `conversation-stream.ts` 与 `use-conversation-turn.ts`、后端 `active-delivery.ts` 不用改**：收到 `reset` 已经同时清空正文与思考，之后的 `reasoning` 照常追加（看过代码确认）。
- **首字兜底 `first-token-fallback.ts` 不复用**：它是多路竞速和交付选择，重写只有一路，沿用现有 `runStreamPass` 的 `firstToken` 钩子扩展即可。

## 可靠性

- **超时**：不新增外部调用。重写仍受 `fallback_first_token_ms`（首次输出）、`stall_ms`（输出间隔）、执行上限 110 秒约束。
  - 付费开思考时重写总时长会变长，但仍在这些上限内。
- **重试 / 幂等 / 并发 / 事务**：不变。重写一次，兜底不再兜底。台账写入、结算 CAS 不变。
- **降级**：`emit.reasoning` 为 undefined（不显示思考的轮次）时退回只认正文，即付费关思考的现状。
- **成本**：付费开思考的重写会多出思考 token，和首发、首字兜底同口径，接受。
- **可观测性**：
  - `st_chat_fallbacks_total{kind=rewrite}` 口径不变，结束原因照旧分类。
  - 擦掉后只出思考就结束：`completed` 且无正文 → `error/empty`；卡住 → `interrupted/stalled`。
  - 日志加 `reasoning_chars`，用来区分「擦掉后只有思考」。

## 最小方案 / 拒绝的设计

- 不给免费畅聊单独配重写时限，不改运营配置契约（选项 B，用户没选）。
- 不在重写失败时恢复原内容。这需要新 SSE 事件和前端改动，不在本次范围。
- 不改前端、数据库。

## 演进与恢复

- 纯后端行为变更，无迁移、无配置变更。按 dev → release → main 发布。
- 回滚：revert 本 PR 重发即可，无数据残留。
- 停止条件：发布后 1～2 小时内，如果重写的 `interrupted/stalled` 或 `error/empty` 明显增多（擦掉后只出思考的失败），把数字报给用户再定。
