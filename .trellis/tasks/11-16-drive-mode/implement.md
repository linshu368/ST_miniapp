# 实施与验证

## 改动清单

- shared：`api/drive-modes.ts`（新）；`conversations.ts`、`settings.ts` 增加字段；`index.ts` 导出。
- backend：`engine/drive-mode.ts`（新）；`platform-instructions.ts`、`render-instructions.ts`、`types.ts`、`index.ts`；`MiniappUserSettingsRepository.ts`、`user-settings-model.ts`；`routes/conversation-generation.ts`；`conversations/generate.ts`、`turn-scope.ts`、`turn-execution.ts`；`ConversationHistoryRepository.ts`。
- admin-client：`configSchemas.ts`、`menu.ts` 登记 `drive_mode_options`（CLI 自动覆盖）。
- frontend：`chat-drive-mode-picker.tsx`（新）；`chat-reply-preferences.tsx` 挂载。
- migration：`20261117_drive_mode.sql`；`scripts/test-drive-mode-migration.sh`（一次性 PG17）。
- ui-tests：fixture 增加 `drive_modes`；`chat.spec.ts` 既有回复偏好用例增加剧情模式断言。

## 验证（已执行）

| 命令                                                                                       | 结果                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint` / `lint:complexity` / `lint:backend-logging` / `lint:migrations` | 通过                                                                                                                      |
| `pnpm --filter @miniapp/backend logging:validate`                                          | 通过                                                                                                                      |
| `pnpm --filter @miniapp/shared test`                                                       | 239 通过                                                                                                                  |
| `pnpm --filter @miniapp/backend test`（CI 占位环境变量）                                   | 1803 通过；新增：所选档位注入、未选/停用/未知回落默认、未配置注入保守规则、配置损坏降级且日志不含规则正文、模板缺槽位告警 |
| frontend / admin / admin-cli test                                                          | 通过                                                                                                                      |
| `bash scripts/test-drive-mode-migration.sh`                                                | 通过：连跑两次幂等、key 链与 ACL、草稿/发布约束、偏好列 CHECK                                                             |
| `pnpm test:ui --grep 多行输入与回复偏好 --project=android/narrow`                          | 通过：四档、默认档、切换说明、刷新后保持                                                                                  |

## 失败路径

- PATCH 非启用 id / 配置不可用 → 400 `无效的剧情模式`（`conversation.config.update_failed`）。
- 配置 JSON 损坏 → 保守规则 + `engine.drive_modes_degraded`。
- 模板缺占位符 → `engine.drive_slot_missing`。
- 诊断写入失败 → 既有 `conversation.rich_reply.diagnosis_failed`。

## 待执行（发布前）

1. 离线评测：虚构对话 × 四档 × 主力模型，LLM 评审抽样统计（不逐条人工审查）。
2. TEST 迁移 → 生产迁移（需用户确认）。
3. 运营配置发布前用 CLI 生成差异给用户确认后再 `--yes`。
4. 发布后 24h：按 `rich_reply_metadata.drive_mode` 统计各档选择比例、富文本解析结果、重新生成率。
