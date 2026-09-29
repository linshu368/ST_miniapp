# 实施计划

本任务尚未开始实现。以下步骤需在人工 review 规划后执行 `python ./.trellis/scripts/task.py start 09-29-admin-model-catalog-multi-provider` 才能进入。

## Phase 1: Shared contract

1. 在 shared 增加 provider 枚举、provider-neutral model id、provider 配置常量和目录 DTO。
2. 调整 `normalizeCatalogModelInput`，让旧 `openrouter_model_id` 自动补齐 `provider='openrouter'` 与 `provider_model_id`。
3. 调整 `ModelCatalogSchema` 唯一性校验为 provider + provider model id。
4. 扩展 runtime resolver 返回 provider + provider model id，保留旧字段兼容。
5. 增加或更新 shared tests：
   - 旧 catalog parse 成功。
   - OpenRouter 新 catalog parse 成功。
   - Venice catalog parse 成功。
   - 跨 provider 同名 model id 可并存，不同 stable id 不可重复。
   - public catalog 不泄露 provider secret/内部上游配置。

## Phase 2: Database validation

1. 新增 `packages/shared/migrations/YYYYMMDD_llm_model_provider_catalog.sql`。
2. 更新 `admin.validate_model_catalog_core` 与 `admin.validate_model_catalog_prd`。
3. 选择是否回填 active/draft/release JSON 中的 OpenRouter legacy fields；若不回填，验证旧配置仍能通过应用发布。
4. 在 test DB 单文件验证：
   - 旧 OpenRouter catalog 发布通过。
   - Venice catalog 发布通过。
   - provider 缺失但无 `openrouter_model_id` 被拒绝。
   - 重复 `(provider, provider_model_id)` 被拒绝。
   - default disabled/missing 仍被拒绝。
5. 写回滚/forward-fix 说明：若已发布 Venice，回滚代码前先发布 OpenRouter-only catalog。

## Phase 3: Backend provider directory

1. 泛化 `openrouter-models.ts` 或新增 provider directory 模块。
2. 保留旧 `GET /api/platform/openrouter/models`。
3. 新增 provider-neutral route，并在 shared/route 中校验 provider。
4. 实现 Venice directory adapter：
   - base `VENICE_BASE_URL ?? https://api.venice.ai/api/v1`
   - key `VENICE_API_KEY`
   - GET `/models?type=text`
   - 8 秒 timeout、15 分钟 cache、in-flight 去重、stale fallback。
5. 测试目录 adapter 的成功、非 2xx、invalid JSON、empty text models、stale fallback。

## Phase 4: Backend generation

1. 扩展 `model-tiers.ts` billing context 为 provider-aware。
2. 扩展 `ResolvedModel` 与 `resolve-model.ts`。
3. 调整 `execute.ts`：
   - body.model 使用 provider model id。
   - OpenRouter 才启用 provider routing。
   - OpenRouter 才启用现有 Anthropic `cache_control` prompt caching。
   - Venice 默认注入 `venice_parameters.include_venice_system_prompt=false`。
   - Venice 如接 prompt caching，只使用 Venice 原生 `prompt_cache_key`，不要发送 OpenRouter `cache_control` 断点。
   - upstream URL/key/header 按 provider 选择。
4. 调整 metadata sync：
   - OpenRouter 行仍按 `/generation` 回捞。
   - Venice 行不进入 OpenRouter metadata retry；必要时在 charge metadata/chat history snapshot 标记 provider。
5. 核查 `charge_llm_usage` RPC generation id 约束；若 Venice 无 generation id，给出兼容处理并测试。
6. 后端测试覆盖 OpenRouter 不变、Venice 走 Venice base/key、OpenRouter-only routing 不污染 Venice、Venice system prompt 被禁用、Venice prompt cache key 不带敏感正文、stream interrupted 不扣费。

## Phase 5: Admin

1. 抽出 provider directory helper/config，组件不直接拼 backend URL。
2. `ModelCatalogEditor` props 从单一 `openRouterDirectory` 演进为 provider directory map/loading/error/refresh。
3. `Collapse.items` 由 provider configs 生成，首期 OpenRouter + Venice。
4. 模型卡新增 provider select 和 provider model select。
5. 重复检查、catalog issues、发布差异摘要改为 provider-aware。
6. Admin tests 覆盖：
   - 旧 catalog duplicate 检查仍有效。
   - OpenRouter 与 Venice 同 model id 字符串但 provider 不同不互相冲突。
   - 切换 provider 清空旧模型映射。
   - diff 展示平台模型映射变更。

## Phase 6: Docs and env

1. 更新 backend/admin env examples 或 ops docs，列出：
   - `VENICE_API_KEY`
   - `VENICE_BASE_URL`（可选）
2. 更新 README/ARCHITECTURE 中 LLM env 和平台依赖描述。
3. Railway rollout：
   - test service 先加 `VENICE_API_KEY`。
   - production key 由人工在 Railway 设置，不写入仓库。
   - 缺 key 时 Venice 模型不可用，但 OpenRouter 不受影响。

## Phase 7: Validation

命令：

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/admin typecheck
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/admin build
pnpm -r typecheck
git diff --check
```

人工：

1. Admin test 环境同步 OpenRouter 与 Venice 目录。
2. 发布旧 OpenRouter-only catalog 并确认现有模型可选可生成。
3. 发布含 Venice 模型的 catalog，用户选择剧情引擎后发起一轮文本对话。
4. 观察 backend 日志包含 provider/model/status/耗时，不含 key、正文、完整错误 body。
5. 验证 Venice key 缺失、401、429/5xx、stream interrupted 的不扣费或既有收口语义。
