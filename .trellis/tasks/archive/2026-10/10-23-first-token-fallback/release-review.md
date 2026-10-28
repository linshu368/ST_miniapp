# 首 token 兜底首版上线审核单

用户已明确要求先上线观察，AI自动化暂留空，未来仍会定期调参。6秒执行上限、1%监控目标和兜底率是上线后权衡指标，不要求同时达标后才上线。

## 可交付版本

- 原开发目录保留；发布候选 `/private/tmp/st-fallback-release`，分支 `feat/first-token-fallback-release`，基线最新dev `03ee7b6e`。
- 保留最新请求提速改动，仅2个重叠文件做三方合并；候选跨包typecheck、Backend 789、Frontend 333回归与Frontend/Admin构建通过。此前本功能Shared171、Admin117与隔离PG17/PostgREST/账务回归通过；静态跨包引用/旧链路/迁移命名检查通过。
- 运营集中配置默认DeepSeek V4.1 Flash、每型号4秒、全局6秒、1%目标；真实可见首token落表，原定价与权益一次结算。无AI、自动调参或调度器。
- 原有模型目录、兜底配置共用草稿/发布历史；手动发布只影响新请求。

## 已核对的上线目标

- GitHub `linshu368/ST_miniapp`，功能PR至dev、验证后dev晋升main。main有2个现有发布沿革提交，晋升时保留生产祖先。
- Railway `gallant-insight / production / stminiapp`，跟随main；Vercel `st-miniapp-frontend`与`st-admin-platform`。
- Production Supabase `wbtsfzozlmurljvglhpn`：已只读验证前置validator、history/snapshot与provider表；新请求/尝试表尚未创建。
- TEST Supabase按仓库 `zoqelpfhurwehlvypryl`；MCP对其返回NotFound，已启动正式GitHub只读inspect工作流核验通道，未执行迁移。
- OpenRouter官方公开目录确认精确型号存在，未调用付费生成。

## 执行顺序与恢复

1. 按本清单提交、推送功能分支，创建draft PR至dev并运行CI。
2. 由仓库Database Migration工作流向TEST逐文件执行两份SQL，各自核验后再继续。PR转ready取得预览，验证聊天/兜底/超时与单次扣费。
3. 合入dev，生产向同一确认目标逐文件迁移；迁移先于main新Backend。
4. 保留生产祖先，将dev晋升main，核对Railway Backend与Vercel两端部署版本和运行情况。
5. 发布后由人观察用户真实首token分布、兜底比例、超时率及覆盖率；不等待统计目标全部达成。

恢复：优先回退应用至发布前确认SHA，保留新增事实表；配置回退前先发布原默认兜底型号。无删表、业务回填、秘密值更改或未知生成POST重试。

## 两份迁移

- `packages/shared/migrations/20261023_chat_first_token_fallback.sql` SHA256 `96b3a43e703df8808695a69d327a5f29825dc672fce492affbf3438e1b10ebc7`
- `packages/shared/migrations/20261023_chat_first_token_fallback_config.sql` SHA256 `37cdbbdcfe58a235465b923a298931565fbf29861f957791ac1aacdd626d21c5`

## 提交内容

提交信息：`feat: add configurable first-token fallback and experience metrics`。下列为完整文件清单，排除临时依赖链接、构建缓存与凭据：

- `.trellis/tasks/10-23-first-token-fallback/check.jsonl`
- `.trellis/tasks/10-23-first-token-fallback/design.md`
- `.trellis/tasks/10-23-first-token-fallback/implement.jsonl`
- `.trellis/tasks/10-23-first-token-fallback/implement.md`
- `.trellis/tasks/10-23-first-token-fallback/module-updates.json`
- `.trellis/tasks/10-23-first-token-fallback/prd.md`
- `.trellis/tasks/10-23-first-token-fallback/release-review.md`
- `.trellis/tasks/10-23-first-token-fallback/research/fallback-config.png`
- `.trellis/tasks/10-23-first-token-fallback/research/first-token-visible.png`
- `.trellis/tasks/10-23-first-token-fallback/research/reuse.md`
- `.trellis/tasks/10-23-first-token-fallback/task.json`
- `.trellis/tasks/10-23-first-token-fallback/task.md`
- `.trellis/tasks/10-23-first-token-fallback/verification.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/first-token-fallback.md`
- `docs/grafana/chat-first-token.json`
- `packages/admin/README.md`
- `packages/admin/src/App.tsx`
- `packages/admin/src/components/ConfigValueEditor.tsx`
- `packages/admin/src/components/FallbackConfigEditor.tsx`
- `packages/admin/src/components/ModelCatalogEditor.tsx`
- `packages/admin/src/lib/adminNavigation.test.ts`
- `packages/admin/src/lib/adminNavigation.ts`
- `packages/admin/src/lib/configSchemas.test.ts`
- `packages/admin/src/lib/configSchemas.ts`
- `packages/admin/src/lib/modelCatalogDiff.test.ts`
- `packages/admin/src/lib/modelCatalogDiff.ts`
- `packages/admin/src/lib/openRouterModels.test.ts`
- `packages/admin/src/lib/openRouterModels.ts`
- `packages/backend/src/features/conversations/generate-postprocess.test.ts`
- `packages/backend/src/features/conversations/generate.lifecycle.test.ts`
- `packages/backend/src/features/conversations/generate.ts`
- `packages/backend/src/features/generation/apply-charge.test.ts`
- `packages/backend/src/features/generation/apply-charge.ts`
- `packages/backend/src/features/generation/execute.test.ts`
- `packages/backend/src/features/generation/execute.ts`
- `packages/backend/src/features/generation/first-token-fallback.test.ts`
- `packages/backend/src/features/generation/first-token-fallback.ts`
- `packages/backend/src/features/generation/resolve-model.ts`
- `packages/backend/src/features/generation/settle.ts`
- `packages/backend/src/features/generation/sync-job.ts`
- `packages/backend/src/features/generation/types.ts`
- `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts`
- `packages/backend/src/infrastructure/repositories/GenerationObservationRepository.integration.test.ts`
- `packages/backend/src/infrastructure/repositories/GenerationObservationRepository.ts`
- `packages/backend/src/platform/model-tiers.ts`
- `packages/backend/src/routes/conversations.ts`
- `packages/frontend/src/app/chat/[characterId]/page.tsx`
- `packages/frontend/src/components/chat/chat-message-bubble.tsx`
- `packages/frontend/src/components/chat/chat-message-list.tsx`
- `packages/frontend/src/hooks/use-conversation-turn.test.ts`
- `packages/frontend/src/hooks/use-conversation-turn.ts`
- `packages/frontend/src/lib/api/conversation-stream.ts`
- `packages/frontend/src/lib/api/conversations.ts`
- `packages/frontend/src/lib/perf/first-token-observation.test.ts`
- `packages/frontend/src/lib/perf/first-token-observation.ts`
- `packages/shared/migrations/20261023_chat_first_token_fallback.sql`
- `packages/shared/migrations/20261023_chat_first_token_fallback_config.sql`
- `packages/shared/migrations/tests/chat_first_token_fallback.sql`
- `packages/shared/src/__tests__/models.test.ts`
- `packages/shared/src/api/generation-observations.ts`
- `packages/shared/src/api/models.ts`
- `packages/shared/src/index.ts`
- `scripts/check-legacy-references.mjs`
- `scripts/sql/grant-first-token-metrics-reader.sql`
- `scripts/test-first-token-fallback-local.sh`

## 提交前审核要求来源

`.trellis/workflow.md`：

> Before any git add/commit, present the final paths, diff/digest, validation results, and commit file list for explicit human approval; approval expires if content changes.

本审核单用于满足该具体文件审核要求，不把用户已经明确授权的“先上线”重新解释为尚未授权。确认此清单后沿上述流程完成上线；遇真实迁移或环境故障则报告具体错误，不用6秒/1%目标阻挡发布。
