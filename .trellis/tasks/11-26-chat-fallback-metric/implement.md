# 实施

1. `turn-outcome.ts` TurnFacts 加字段；`generation-dispatch` onCallSettled 记 fallbackCall；`generation-stream` resolveDelivered 记 rewrite。
2. 新增 `fallback-outcome.ts` 分类 + `observeChatFallback`（engineering-observability）。
3. 单测 `fallback-outcome.test.ts`：没用上不记；首字兜底成功/超时/报错(状态码)/中断/拒答；重写成功/超时/报错/中断/拒答；用户停止不记。（指标口径是用户定的验收项，用回归测试锁定。）
4. 验证：backend typecheck、generation 测试、lint:complexity / lint:legacy / lint:backend-logging。
5. 发布后：Grafana Explore 查 `st_chat_fallbacks_total` 有数据，标签取值正确；看板加视图并同步 `docs/grafana/st-chat-success.json`。
