# 执行计划（分支 codex/free-zone-rewrite-reasoning）

1. backend：按 design.md 改 `generation-dispatch.ts`、`stream-recovery.ts`、`stream-pass.ts`、`generation-stream.ts`。
2. 回归测试（用户已确认改动语义；重写会擦掉用户屏幕上的内容，属于失败恢复路径，按风险在既有 `execute.test.ts` 的「出字后兜底」组里补用例，不新建测试文件）：
   - 现有第一条用例：断言改为重写的 `reasoning` 与首发请求体一致（默认开思考）。
   - 付费关思考：重写 `reasoning` 为 `{ enabled: false, exclude: true }`；兜底吐思考也不显示、不算出字；只出思考没正文时到首字时限放弃，不擦。
   - 显示思考（`revealReasoning: true`，模拟免费畅聊）：
     - 重写先出思考、正文在首字时限之后才到 → 算出字、不放弃；`reset` 在第一段思考之前；救回。
     - 重写只出思考后卡住 → 已擦掉，没救回，按中断（`stream_interrupted`）。
3. 文档：stream-recovery 头注释、shared `chat-recovery.ts` / `conversations.ts` 注释、ARCHITECTURE 出字后兜底段。
4. 验证：
   - `pnpm --filter @miniapp/backend exec vitest run src/features/generation`
   - `pnpm --filter @miniapp/shared test`
   - `pnpm -r typecheck`
   - `pnpm lint:complexity`
   - `pnpm lint:backend-logging`
   - `pnpm --filter @miniapp/backend logging:validate`
5. 发布：
   - PR → dev（squash）。
   - 从 origin/main 拉 release 分支 cherry-pick → PR → main（--merge）→ 等 Railway 部署。
   - 同步 main → dev。
6. 线上核对：
   - Railway `llm.recovery.completed` 看 `reasoning_chars` 与 `first_token_ms`。
   - 1～2 小时后看 st-chat-fallback 重写成功率，按超时兜底 / 报错兜底分开汇报。

## 人工场景

- 免费畅聊触发拒答重写：屏幕先清空，出现思考，再出正文。
- 付费关思考触发重写：和现在一样，不出思考。
- 付费开思考触发重写：出现思考，再出正文。

## 失败路径

- 擦掉后只出思考就卡住或断开：按中断免扣，屏幕只剩思考。日志 `reasoning_chars > 0`、`added_chars = 0`。
- 重写首字时限内既没思考也没正文：不擦，保持原内容，按中断免扣（同现状）。
