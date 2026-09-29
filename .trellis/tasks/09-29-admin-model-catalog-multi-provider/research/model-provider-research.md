# 模型平台接入研究记录

日期：2026-09-29

## 需求来源

用户要求在 Admin 模型目录菜单中增加其他模型平台接入，首期新增 Venice，并保证发布配置后用户选择剧情引擎可正常使用新平台模型。

## 已阅读规范

- `README.md`
- `docs/ARCHITECTURE.md`
- `.trellis/workflow.md`
- `.trellis/spec/admin/app/index.md` 及 architecture/features/data/ui/testing 专题
- `.trellis/spec/backend/app/index.md` 及 routes/data/testing/rules 专题
- `.trellis/spec/shared/contracts/index.md` 及 architecture/api 专题
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
- `.trellis/spec/database/supabase/index.md`
- `.trellis/spec/database/supabase/schema-and-object-conventions.md`
- 模块索引与相关模块：`admin.business.operations`、`backend.business.conversation-generation`、`backend.infrastructure.runtime-data-security`、`shared.business.conversation-contracts`

## 现有实现检索

### Admin

- `packages/admin/src/components/ModelCatalogEditor.tsx`
  - `Collapse.items` 目前写死 OpenRouter 模型目录。
  - 模型卡只有 `openrouter_model_id` 下拉，没有平台选择。
  - `filterOpenRouterModels`、`findDuplicateOpenRouterAssignments` 和重复提示均按 OpenRouter 字段工作。
- `packages/admin/src/lib/openRouterModels.ts`
  - 调 backend `GET /api/platform/openrouter/models`。
  - 使用 `OpenRouterModelDirectorySchema` 校验返回。
  - `getOpenRouterCatalogIssues` 检查模型缺失/过期。
- `packages/admin/src/lib/modelCatalogDiff.ts`
  - 发布差异中显示“OpenRouter 映射”。
- `packages/admin/src/lib/configSchemas.ts`
  - `llm_model_catalog` 使用 shared `ModelCatalogSchema`。
  - `EditableModelCatalogSchema` 仍要求 `openrouter_model_id`。

### Shared

- `packages/shared/src/api/models.ts`
  - `ModelCatalogModelSchema` 要求 `openrouter_model_id`，格式为 `vendor/model`。
  - `ModelCatalogSchema` 要求 `openrouter_model_id` 全局唯一。
  - `PublicModelCatalogModelSchema` 会移除 `openrouter_model_id` 和 `enabled`。
  - `GetModelCatalogDataSchema` / `SelectModelDataSchema` 返回 `selected_openrouter_model_id` / `openrouter_model_id`。
  - `resolveRuntimeCatalogModel` 只读取 `openrouter_model_id`。
- `packages/shared/src/api/provider-routing.ts`
  - OpenRouter 底层 provider routing 按 `openrouter_model_id` 绑定；该配置不适用于 Venice 首期。

### Backend

- `packages/backend/src/routes/models.ts`
  - `GET /api/platform/openrouter/models` 暴露 OpenRouter 模型目录给 Admin。
  - 用户模型配置/选择 API 使用 `selectedModel.openrouter_model_id`。
- `packages/backend/src/platform/openrouter-models.ts`
  - OpenRouter 目录客户端，8 秒超时、15 分钟缓存、失败时返回 stale 缓存。
  - 使用 `LLM_UPSTREAM_URL` + `/models` 和 `LLM_API_KEY` / `OPENAI_API_KEY`。
- `packages/backend/src/platform/model-tiers.ts`
  - 统一读取 `runtime_config.llm_model_catalog`，失败降级 `DEFAULT_CATALOG`。
  - `getModelBillingContext(openRouterModelId)` 按 `openrouter_model_id` 查模型。
- `packages/backend/src/features/generation/resolve-model.ts`
  - 将 stable model id 解析为 `openRouterModelId`。
- `packages/backend/src/features/generation/execute.ts`
  - 通过 `buildUpstreamBody` 把 `request.model.openRouterModelId` 作为 `model`。
  - 调 `forwardToUpstream(resolveUpstreamUrl('/chat/completions'))`。
  - OpenRouter provider routing 和 prompt caching 现在与 `openRouterModelId` 绑定。
- `packages/backend/src/features/generation/upstream.ts`
  - 上游 base URL 与 key 固定为 `LLM_UPSTREAM_URL` / `LLM_API_KEY`。
  - header 固定包含 OpenRouter 兼容的 `HTTP-Referer` / `X-Title`。
- `packages/backend/src/features/generation/openrouter-metadata.ts` / `sync-job.ts`
  - 用 OpenRouter `/generation?id=` 回捞用量与 finish_reason。
  - Venice 首期没有同等证据，不能复用该回捞路径。

### Database / migrations

- `packages/shared/migrations/084_remove_legacy_llm_display_fields.sql`
- `packages/shared/migrations/085_llm_free_flag_and_drop_pricing_markup.sql`
- 后续多个 migration 的 `admin.validate_managed_config_value` 仍调用 `admin.validate_model_catalog_core` / `admin.validate_model_catalog_prd`。
- 当前 DB 校验要求 `openrouter_model_id` 存在、形如 `vendor/model`、全局唯一；因此多平台配置需要新 migration 放宽/演进校验。

## Venice 官方文档核验

官方文档显示 Venice API 是 OpenAI-compatible，base URL 为 `https://api.venice.ai/api/v1`，聊天接口示例使用 `/chat/completions` 和 Bearer `VENICE_API_KEY`。

模型列表为 `GET https://api.venice.ai/api/v1/models`，需要 Bearer token，支持 `type` query 过滤，`type=text` 返回文本模型。返回模型包含 `id`、`type`、`model_spec.name`、`model_spec.description`、`model_spec.availableContextTokens`、`model_spec.pricing.input.usd`、`model_spec.pricing.output.usd`、`model_spec.offline` 等字段。

Venice 会默认注入自己的 system prompt；官方示例说明可在 chat completions body 中传 `venice_parameters.include_venice_system_prompt=false`。因此 ST 文本生成接 Venice 时必须默认加该参数，避免 Venice 默认 system prompt 与自研引擎的平台规则叠加。

Prompt caching：Venice 官方文档显示其支持自动缓存，并支持 `prompt_cache_key`、`prompt_cache_retention`，Claude 场景还支持/自动处理 `cache_control`。本仓库现有 `features/generation/prompt-caching.ts` 是 OpenRouter Anthropic 特化逻辑，只对 `anthropic/*` 打 `cache_control`，注释也明确其他厂商带该字段可能被拒绝。结论：Venice 可接入缓存，但首期应使用 Venice 原生 `prompt_cache_key`（例如会话 id）和可选 retention，不复用现有 OpenRouter `applyPromptCaching` 断点逻辑。

Provider routing：Venice chat completions 文档未提供 OpenRouter `provider.ignore` / `provider.order` 等价字段，也没有按底层供应商 slug 屏蔽/优先的 API。文档里出现 `fallbacks`，但示例和说明偏向模型级 fallback，并且明确 Anthropic direct route beta 语义，不等价于 OpenRouter provider routing。结论：首期不能把现有 `llm_provider_routing_config` 接到 Venice；该配置仍仅作用 OpenRouter。若未来需要 Venice fallback，应另建 Venice-specific 模型 fallback 配置，不能复用 provider slug 黑白名单。

来源：

- https://docs.venice.ai/api-reference/api-spec
- https://docs.venice.ai/api-reference/endpoint/models/list
- https://docs.venice.ai/api-reference/endpoint/chat/completions
- https://docs.venice.ai/guides/features/prompt-caching
- https://github.com/veniceai/api-docs/blob/main/llms.txt

## 复用决策

- 复用 `ModelCatalogEditor.tsx` 的受控编辑器、排序、预览与默认模型逻辑；只抽离平台目录配置和平台字段控件。
- 扩展 `openRouterModels.ts` 为 provider-neutral 目录 helper，或新增 `modelProviderDirectories.ts` 并保留旧 wrapper；避免组件直接拼 endpoint。
- 扩展 shared `models.ts`，不在 Admin/Backend 私定义多平台模型目录形状。
- 扩展 backend `platform/model-tiers.ts`，仍作为 runtime catalog 唯一入口。
- 扩展 `features/generation/upstream.ts`/`execute.ts` 为 provider-aware 上游选择；仍保持 `features/generation` 为唯一生成计费出口。Venice 分支默认注入 `venice_parameters.include_venice_system_prompt=false`，并可使用 Venice 原生 `prompt_cache_key`。
- 新建/扩展 DB validate migration；不新建表，不复制 runtime_config。

## 关键兼容风险

- 旧配置只有 `openrouter_model_id`；必须默认映射为 `{ provider: 'openrouter', provider_model_id: openrouter_model_id }`。
- 旧 public API 字段名仍有 `selected_openrouter_model_id`；短期需要保留兼容字段，同时新增 provider-neutral 字段供新消费者使用。
- `llm_usage_charges.model_openrouter_id`、`chat_history.model`、日志字段和元数据字段短期可能沿用旧命名；设计需说明其语义过渡，避免一次性大改计费表。
- OpenRouter provider routing 与 metadata sync 只适用于 OpenRouter；Venice 首期不能套用。
- Venice prompt caching 可接，但不能直接复用 OpenRouter Anthropic `cache_control` 断点逻辑。

## Venice usage 明细补充研究（2026-09-29）

- 用户确认主对话仍写 `experience.chat_history`，仅 Venice provider 回传/usage 写独立一对一明细表。
- Venice chat completions 是 OpenAI-compatible；实现通过流式请求 `stream_options.include_usage=true` 读取终态 chunk 的 `usage.prompt_tokens`、`completion_tokens`、token details，并从已同步 `/models` 目录价格计算观测成本。
- 官方文档站与 GitHub raw 在本次会话网络超时，无法现场重新下载 schema；因此 parser 对 usage/details 全部采用可空、非负、失败降级设计，并要求 TEST/真实 Venice smoke 核对实际字段。
- `llm_generation_data` 仅保留 id/object/created/model/usage/venice_parameters 等白名单，明确剔除 choices、message、content，避免把正文复制到 provider 明细。
