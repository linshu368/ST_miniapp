# 执行计划

## 复用调研

| 检索对象                                                              | 结论                               |
| --------------------------------------------------------------------- | ---------------------------------- |
| `stream-pass.ts` 卡顿 / 拒答的 AbortController                        | 复用同一模式，加第三个「上游报错」 |
| `upstream.ts` `createSseTap` 已有 `streamError` / `finishReason` 解析 | 复用，只加一个回调                 |
| `stream-recovery.ts` `planRecovery` / `runRecovery`                   | 不改，触发来源不变                 |
| `creator-polish.ts` / `status-bar-model.ts` 也用 `createSseTap`       | 不传 `onFailed`，行为不变          |
| `execute.test.ts` 的 `hanging` / `sseResponse` 场景                   | 扩展用例，不新建文件               |

## 步骤

1. `createSseTap` 加 `onFailed`；`runStreamPass` 接上并改 `classifyEnd`。
2. 第 4 条：到点时已正常结束 → `completed`。
3. 第 5 条：日志字段。
4. `execute.test.ts` 增加用例：报错块不关流、异常结束原因不关流、开关关闭、（第 4 条）正常结束不关流。
5. 同步 `docs/ARCHITECTURE.md` 出字后兜底一段。

## 失败路径

- 报错后兜底没出字 → 不擦，保留半段、按中断免扣（现状）。
- 报错与用户停止同时到 → 按用户停止。
- 报错与卡顿同时到 → 都启用兜底，只是记的原因不同。

## 验证

- `pnpm --filter @miniapp/backend test`、`pnpm -r typecheck`、lint、`lint:complexity`、`lint:backend-logging`、`logging:validate`。
- 本地假流脚本复跑 5 种断法，对比改前改后等待时间。
- 上线后：Railway `llm.recovery.triggered` 的 `max_gap_ms` 分布与 `llm.recovery.completed` 救回率；Grafana `st-chat-success` 无新增失败类型。
