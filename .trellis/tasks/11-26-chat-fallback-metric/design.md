# 设计

## 复用调研

- `turn-outcome.ts`：每轮出口 `recordChatTurn` 已在算 `st_chat_turns`（用户结果 / 首发结果 / rescue）。兜底分类放在同一个出口，复用它的 `TurnFacts`、拒答词池判定 `refusalHit` 与 `passOutcome` 映射。
- `engineering-observability.ts`：`observeChatTurn` 的 `identity()` 生成 platform/model 标签；新增 `observeChatFallback` 用同一个 identity，和现有面板对得上。
- 事实来源：首字兜底那一路的结束原因与状态码来自 `forwardWithFirstTokenFallback` 的 `onCallSettled`（generation-dispatch 已在用，记 primaryCallEnds）；出字后重写来自 `runRecovery` 的 `RecoveryOutcome`（generation-stream `resolveDelivered`，已写 `llm.recovery.completed` 日志）。
- 不复用 `ops.llm_calls`：看板走 Prometheus，台账按调用落库、无「是否用上」语义，且产品路径不读 ops。

## 方案

- `TurnFacts` 增加 `fallbackCall`（最后结束的那次首字兜底调用：平台、模型、结束原因、状态码）与 `rewrite`（重写平台、模型、触发原因、结束原因、流结束方式、状态码、是否成功）。
- 新文件 `fallback-outcome.ts`：纯函数 `classifyFallbacks(facts, finalRefused, timedOut)` → 0–2 条记录；`recordChatTurn` 逐条 `observeChatFallback`。
  - 首字兜底：deliveredRole≠fallback 且有人交付 → 不记（没用上）；fallback 交付 → 按交付流结束方式判（被重写救回时按触发重写的结束方式判中断/拒答）；谁都没交付且兜底发出过 → upstream*error=报错（reason=http*状态码 / network）、first_token_deadline 或执行超时=超时、cancelled 且用户停止不记。
  - 重写：callEnd completed 且有正文 → 成功（最终正文命中拒答词池 → 拒答）；refused / content_filter → 拒答；first_token_deadline → 超时；upstream_error → 报错（状态码）；stream_interrupted → 中断（reason=流结束方式）；cancelled → 不记。
- 标签取值都是固定枚举，基数小（栏目 2 × 种类 2 × 启动原因 2 × 模型约 2 × 结果 5 × 原因 ≤10）。

## 可靠性

- 只在出口计数，不阻塞返回；异常吞掉只丢一条（与 st_chat_turns 一致）。无外部调用、无写库、无重试。

## 演进与恢复

- 纯新增指标，旧看板不受影响；回滚即不再产生新数据。数据从部署起累计。
