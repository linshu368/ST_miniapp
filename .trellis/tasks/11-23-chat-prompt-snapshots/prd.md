# 对话 prompt 快照恢复（只留 7 天）

## Goal

恢复保存每轮发给模型的完整 messages，只给开发和产品排查 bug、观察提示词策略是否生效用（O，非业务数据）。11-23 删掉的 `ops.chat_prompt_observations` 无读者，所以删了；现在用户要回来，按新约束重建。

## Requirements（用户 11-23）

- 重新建一张快照表，开轮时写入，只留最近 7 天，每天自动清掉 7 天以前的。
- 保存完全异步、完全非业务：不影响用户体验的耗时（首字、接口返回），写失败不影响本轮回复与计费，产品请求路径不读它。
- 保留天数由用户定为 7 天（已告知：旧表本来就是 7 天保留，5.7GB 主要来自每轮存整段对话；近 7 天每天约 6500 轮、平均 prompt 约 4 万 token，稳定后约 5–6GB）。

## 落位（CONTRACT §3.2）

- 坐标：`ops` × O（观测）。表 `ops.chat_prompt_snapshots`：`history_id`（主键，软引用 `experience.chat_history.id`，不建外键）、`messages_snapshot`（jsonb 数组，发给模型的 messages 原样）、`created_at`。
- 写入：后端 `GenerationObservationRepository.savePromptSnapshot` → RPC `experience.record_chat_prompt_snapshot`（SECURITY DEFINER，只授 service_role；同一轮重放时覆盖）。沿用 `experience.record_llm_call_metadata` 写 ops 的做法（ops 不暴露给 PostgREST）。
- 生命周期：保留 7 天；`ops.cleanup_chat_prompt_snapshots` 按 `created_at` 分批删，生产 pg_cron `chat_prompt_snapshots_retention` 每天 20:17 UTC（北京 04:17）执行；TEST 没有 pg_cron，只建函数。
- 读者：开发、产品经 SQL（MCP / Studio）按轮次 id 查；产品请求路径、看板不读。
- 契约提示：CONTRACT 规则 4 写"只为排障的写 pino 日志"。这里例外的理由：单轮 prompt 平均约 4 万 token，不适合进日志（体积、日志平台保留与成本、含对话正文）；排查要按轮次 id 精确取回原文。

## 写入时机与耗时

- 开轮放行（`onBeforeDispatch` 里 admission RPC 成功）之后，用 `setImmediate` 推到下一轮事件循环再发起、不 await：上游请求先发出去，快照写入与首字、流式回复并行，不在任何等待链上。
- 失败（超时 10 秒、RPC 报错、方法缺失）只记 `conversation.prompt_snapshot.save_failed` warn，不重试。

## Acceptance Criteria

- [ ] 迁移本地 PG17（非超级用户，有 / 没有 pg_cron 两种库）验证：建表、RPC 写入与覆盖、拒绝非数组、service_role 不能直接读写表、清理只删 7 天前的、定时任务只建一个、重跑不变。
- [ ] 后端 typecheck、相关单测通过；快照写入失败不影响本轮结果。
- [ ] 生产：发布后新轮次都有快照；表体积按天增长符合预期；`cron.job` 有清理任务；首字耗时发布前后同口径不劣化。

## Android/iOS 性能 P95 门禁

- 受影响页面：无（前端不改）。
- 受影响接口：无同步改动。对话发送接口只多一个放行后不 await 的后台写入，不在首字和返回路径上。
- 发布后验证：用 `experience.chat_generation_attempts.first_token_ms`（交付调用）比较发布前后 24 小时 P50 / P95，确认不劣化。
