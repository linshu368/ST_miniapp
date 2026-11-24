# 执行计划：出字后兜底

## 复用调研

| 检索对象                                                                 | 结论                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `first-token-fallback.ts` 竞速/闸门                                      | 不复用不改：出字前定胜负，拒答几乎都先出思考；文件已超 500 行   |
| `generation-stream.ts consumeStream`                                     | 扩展：读流交给 `stream-recovery.ts`，结算入口不变               |
| `upstream.ts createSseTap / forwardToUpstream / resolveProviderUpstream` | 复用；`createSseTap` 补识别流内 `error` 块                      |
| `generation-dispatch.ts createForward` 的兜底供应商偏好                  | 复用 `fallbackProviderPreferences` / `resolveFallbackProviders` |
| `generation-settlement.ts settleStream`                                  | 复用：救回 → success 分支扣费；失败 → 中断分支免扣              |
| `call-ledger.ts recordLlmCall` + `call-costs.ts`                         | 复用：兜底调用一行，成本按 openrouter generation 补             |
| `runtime-config.ts` 托管配置读法 / `status-bar-model.ts` 读配置写法      | 复用（读不到即关闭并 warn）                                     |
| `admin-client configSchemas.ts` / `menu.ts` / `ConfigValueEditor`        | 扩展：登记新 key + 专门编辑器                                   |
| `engineering-observability.ts`                                           | 复用 `observation.emit` 发恢复事件                              |

## 步骤

1. **契约**：`shared/src/api/chat-recovery.ts`（配置 schema、key、运营平台初始值）；`conversations.ts` 增加 SSE `reset` 事件。
2. **迁移**：`20261124_llm_calls_stream_end.sql`：`ops.llm_calls.stream_end` + role `rewrite`。验证脚本 `scripts/test-llm-calls-stream-end-migration.sh`。更新 `docs/db/registry.yaml`。
3. **SSE 错误块**：`createSseTap` 识别 `error` 块 → `streamError`（修 Surplus 记成 success）。
4. **stream-pass.ts**：卡顿看门狗、拒答检测（只判定不压）、结束方式分类。
5. **stream-recovery.ts**：是否兜底（含未成年人窄规则）、兜底调用（原 messages、关思考、首字时限）、擦除时机、结算合并结果、台账。
6. **接线**：`generation-stream.ts` 编排；`generation-dispatch.ts createRecoveryForward`；`generation-runtime.ts` 只给有首字竞速的轮次；`turn-execution.ts onReset` → 清交付缓存 + 下发 `reset`。
7. **前端**：`conversation-stream.ts` 处理 `reset`；`use-conversation-turn.ts` 清空正文与思考。
8. **Admin**：`configSchemas.ts`、`menu.ts`、`ChatRecoveryConfigEditor.tsx`（经 `dedicatedConfigEditors.tsx` 分发）。
9. **文档**：`docs/ARCHITECTURE.md`、迁移 README。

## 发布顺序与回滚

1. 迁移：TEST 执行验证 → 生产执行（GitHub Actions `Database Migration`）。
2. 后端 + Admin 发布，配置不存在 = 两个开关关闭；此时只有 Surplus 错误块修复与 `stream_end` 记录生效。
3. 经 CLI 写入 `chat_recovery_config`（先给用户看差异）：先开中断重写，观察 24 小时；再填词池开拒答。
4. 停止条件：重写成功率 < 50%、或卡顿误判明显（`max_gap_ms` 分布显示大量正常回复被掐）、或兜底成本异常 → 关开关（无需发版）。
5. 回滚：关开关即回到现状；代码回滚不需要回滚迁移（新列/新 role 无读者依赖）。

## 验证

- `pnpm -r typecheck`、backend/frontend/shared/admin/admin-client/admin-cli 测试、`lint`、`lint:complexity`、`lint:db-contract`、`lint:backend-logging`、`logging:validate`、`lint:migrations`、admin build、迁移脚本。
- 回归测试（计费与并发高风险，需要锁定）：
  - backend `execute.test.ts`「出字后兜底」：卡顿 → 擦掉重写成功扣费、兜底按原 messages 且关思考；兜底 503 → 不擦、中断免扣；拒答照常显示、命中掐断、擦掉重写；拒答涉及未成年人 → 原样交付；开关关闭时 Surplus 错误块 → 中断。
  - backend `stream-recovery.test.ts`：未成年人正则、拒答检测、是否兜底（含技术故障不判未成年人、content_filter 判）、上下文不看包着平台规则的 user 消息。
  - frontend `conversation-stream.test.ts`：`reset` 丢掉未提交增量并通知清空。
- 人工（development 环境）：真实 Gemini 3 Flash 回合 + 人为调低 `stall_ms` 触发重写，看前端清空与重写、计费、`ops.llm_calls` 两行。
- 上线后 24 小时：按 provider+model 查 `stream_end` 分布、重写成功率、兜底成本、`max_gap_ms` 分布。
