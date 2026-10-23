# 技术设计：Admin 模型目录多平台接入

## 范围

本任务规划覆盖 Admin 模型目录编辑、shared 契约、backend 模型目录同步、backend 文本生成上游选择、DB 配置校验、Railway 环境变量和验证方案。首个新增平台为 Venice。

不覆盖：用户端 UI 改版、按用户扣费改成 Venice 实际成本、Venice 以外的第二个新增平台、Venice 图片/音频/视频 API、OpenRouter provider routing 的平台化改造。

## 当前链路

```text
Admin ModelCatalogEditor
  -> openRouterModels.ts
  -> backend GET /api/platform/openrouter/models
  -> openRouterModelsClient
  -> runtime_config.llm_model_catalog
  -> backend platform/model-tiers.ts
  -> features/generation/resolve-model.ts
  -> features/generation/execute.ts
  -> upstream.ts -> OpenRouter /chat/completions
  -> settle/sync-job -> OpenRouter /generation metadata
```

## 数据模型设计

### Provider-neutral catalog

在 shared `models.ts` 中新增 provider-neutral 概念，保留旧字段兼容：

- `LlmModelProviderSchema = z.enum(['openrouter', 'venice'])`
- `ProviderModelIdSchema = z.string().trim().min(1).max(200)`
- `ModelCatalogModelSchema` 演进为：
  - `id`
  - `provider`，默认 `openrouter`
  - `provider_model_id`
  - `openrouter_model_id`，仅兼容旧 OpenRouter 配置；解析时可由旧字段推导 `provider_model_id`
  - `display_name`
  - `tagline`
  - `is_free`
  - `enabled`
  - `sort_order`

兼容规则：

- 旧配置 `{ openrouter_model_id: 'a/b' }` 解析为 `{ provider: 'openrouter', provider_model_id: 'a/b', openrouter_model_id: 'a/b' }`。
- 新 OpenRouter 配置写入时可以保留 `openrouter_model_id = provider_model_id`，降低旧代码/DB/审计查看成本。
- 新 Venice 配置写入 `provider = 'venice'` 与 `provider_model_id = '<venice-model-id>'`；不要求 `openrouter_model_id`。
- 唯一性从 `openrouter_model_id` 全局唯一改为 `(provider, provider_model_id)` 全局唯一。
- Public catalog 默认仍不暴露 provider；用户只选择 stable model id。为新前端/调试可在 `GetModelCatalogData` 与 `SelectModelData` 增加可选 `selected_provider`、`selected_provider_model_id` / `provider`、`provider_model_id`，保留 `selected_openrouter_model_id` 作为旧字段。对非 OpenRouter，旧字段临时返回实际 `provider_model_id`，但新代码不得再依赖旧字段名表达平台。

### Shared provider configuration

新增纯配置（建议 `packages/shared/src/api/model-providers.ts` 或合并进 `models.ts`）：

```ts
type LlmProviderCapability = {
  id: 'openrouter' | 'venice';
  label: string;
  defaultBaseUrl: string;
  apiKeyEnv: string;
  baseUrlEnv?: string;
  chatCompletionsPath: '/chat/completions';
  modelsPath: '/models';
  supportsModelDirectory: true;
  supportsOpenRouterProviderRouting: boolean;
  supportsOpenRouterGenerationMetadata: boolean;
  promptCachingMode: 'openrouter_anthropic_cache_control' | 'venice_prompt_cache_key' | 'none';
  defaultRequestBody?: Record<string, unknown>;
};
```

该配置是 browser-safe 常量，只包含环境变量名称和默认 URL，不读取 env、不包含 secret。Backend 根据 id 读取进程环境。

首期平台能力取值：

- OpenRouter：`supportsOpenRouterProviderRouting=true`、`supportsOpenRouterGenerationMetadata=true`、`promptCachingMode='openrouter_anthropic_cache_control'`。
- Venice：`supportsOpenRouterProviderRouting=false`、`supportsOpenRouterGenerationMetadata=false`、`promptCachingMode='venice_prompt_cache_key'`，并固定在请求体增加 `venice_parameters.include_venice_system_prompt=false`。

## Admin 设计

### 目录同步配置抽离

将 `ModelCatalogEditor.tsx` 中 `Collapse.items` 的平台目录面板抽成配置驱动：

- `packages/admin/src/lib/modelProviderDirectories.ts`
  - `fetchModelProviderDirectory(environment, provider, forceRefresh)`
  - `getCatalogProviderIssues(catalog, directories)`
  - provider 目录数据统一为 `ProviderModelDirectory`
- 或 `packages/admin/src/components/modelCatalogProviderPanels.tsx`
  - 只负责把 provider config 映射成 AntD `CollapseProps['items']`

组件层不直接拼 URL；仍由 `src/lib` helper 访问 backend。

### 模型卡编辑

在模型卡当前 `OpenRouter 模型 ID` 左侧/同一行增加「模型来源平台」：

- 新建模型默认 `provider: 'openrouter'`。
- 平台 Select disabled 时跟随全局 `props.disabled`。
- 平台改变时清空 `provider_model_id`，并仅当平台为 OpenRouter 时同步清空/更新 `openrouter_model_id`。
- 模型 ID Select 根据选中 provider 使用对应目录 options；未选择 provider 或目录未同步时 disabled。
- 选择目录模型后自动写 `provider_model_id`、展示名；OpenRouter 同步写 legacy `openrouter_model_id`。
- 重复检查按 `${provider}:${provider_model_id}`。
- Venice 目录表展示字段：模型名、ID、上下文、输入价、输出价、状态（offline / available）、traits 或能力摘要。

### 发布差异与提示

- `modelCatalogDiff.ts` 将“OpenRouter 映射”改为“平台模型映射”，并包含平台名。
- 同步错误按平台展示，不互相覆盖。
- 目录缺失/过期/离线只阻止保存草稿还是仅提示，需要实现时确认现有保存门禁；建议与当前 OpenRouter 一致：本地显示问题，最终由 shared/DB schema 阻止结构错误，不因目录请求失败阻塞旧配置发布。

## Backend 设计

### Provider directory clients

将 `platform/openrouter-models.ts` 泛化或并行新增：

- `platform/model-provider-directory.ts`
  - `ModelProviderDirectoryClient` interface
  - `getModelProviderDirectory(provider, { forceRefresh })`
  - 统一 8 秒超时、15 分钟缓存、in-flight 去重、失败返回 stale 缓存。
- `OpenRouterDirectoryAdapter`
  - 复用现有响应 schema 与映射。
- `VeniceDirectoryAdapter`
  - `GET {baseUrl}/models?type=text`
  - header `Authorization: Bearer ${VENICE_API_KEY}`
  - 只纳入 `type === 'text'` 且非 offline 的模型，或保留 offline 但标记不可选；建议目录展示保留，选择时禁用 offline。
  - 将 `model_spec.name/description/availableContextTokens/pricing.input.usd/pricing.output.usd` 映射到统一 summary。

Backend route：

- 保留 `GET /api/platform/openrouter/models` 兼容 Admin 旧 helper。
- 新增 `GET /api/platform/model-providers/:provider/models` 或 `GET /api/platform/models/:provider`，shared 定义 provider param。
- route 仍 `@frontend-ready: true`，日志只记录 provider、数量、stale、耗时和错误摘要。

### Runtime model resolution

扩展 `platform/model-tiers.ts`：

- `DEFAULT_CATALOG` 继续 OpenRouter。
- normalize 旧配置时补 `provider = 'openrouter'` 与 `provider_model_id`。
- `ModelBillingContext` 增加：
  - `provider`
  - `providerModelId`
  - 保留 `openRouterModelId` 作为兼容字段，值为 provider model id 或仅 OpenRouter 时有意义；实现时更推荐逐步改调用方命名。
- `getModelBillingContext` 入参从 `openRouterModelId` 演进为 `{ provider, providerModelId }`，可保留旧 wrapper。

### Generation upstream

在 `features/generation` 内部增加 provider-aware 上游选择：

- `resolveGenerationProvider(provider)` 从 shared provider config + backend env 读取：
  - OpenRouter：`LLM_API_KEY` / `OPENAI_API_KEY`，base `LLM_UPSTREAM_URL` 默认 `https://openrouter.ai/api/v1`
  - Venice：`VENICE_API_KEY`，base `VENICE_BASE_URL` 默认 `https://api.venice.ai/api/v1`
- `buildUpstreamBody`：
  - `model` 使用 `providerModelId`。
  - OpenRouter 才应用 provider routing。
  - OpenRouter 才应用现有 `applyPromptCaching` 的 Anthropic `cache_control` 断点。该函数当前按 `anthropic/*` 判断，并且是 OpenRouter/Anthropic 特化逻辑，不直接用于 Venice。
  - Venice 必须默认加入 `venice_parameters: { include_venice_system_prompt: false }`，避免 Venice 默认 system prompt 与 ST 自研平台规则叠加。
  - Venice 可接入 prompt caching，但首期使用 Venice 原生的 `prompt_cache_key`（建议 `sessionId`，无 session 时可省略），可选 `prompt_cache_retention` 先不暴露给运营；不要发送 OpenRouter/Anthropic 的 `cache_control` content block，除非后续按 Venice 模型能力做专项验证。
- `forwardToUpstream` 接收 provider API key / headers / base URL；OpenRouter 保留 `HTTP-Referer`、`X-Title`，Venice 只使用通用 JSON + Bearer header，除非官方要求更多头。

### Provider routing and prompt caching decision

- Provider routing：现有 `llm_provider_routing_config` 是 OpenRouter 专属配置，翻译为 `provider.ignore` / `provider.order` / `allow_fallbacks`。Venice chat completions 未提供等价的底层供应商 slug 路由字段，不能安全接入该配置。Venice 文档中的 `fallbacks` 是模型级 fallback / Anthropic direct route beta 语义，不等价于 OpenRouter provider routing。首期 Venice 不接 `llm_provider_routing_config`；未来如要做 fallback，另立 Venice-specific 模型 fallback 配置。
- Prompt caching：Venice 支持自动 prompt caching、`prompt_cache_key`、`prompt_cache_retention`，并对 Claude/cache_control 有自己的处理说明。首期可接入 `prompt_cache_key`，但不复用本仓库当前 OpenRouter Anthropic `applyPromptCaching` 断点；该断点只保留给 OpenRouter Anthropic 模型。

### Metadata sync and billing

- OpenRouter metadata sync 保持只处理 OpenRouter 行。
- Venice 不调用 OpenRouter `/generation`；固定档位扣费仍依赖 SSE tap 的 `finish_reason === 'stop'`。
- Venice 请求增加 OpenAI-compatible `stream_options.include_usage=true`。SSE tap 从最终 chunk 读取 `usage.prompt_tokens`、`usage.completion_tokens`、`usage.total_tokens` 及 details 中的 cached/reasoning token，并保留不含 `choices`/正文的响应元数据白名单。
- 应用侧记录请求发出到首个 content delta 的 latency 和完整收流 generation time；非流式响应记录完整耗时，首字延迟为空。
- 结算后台从 Venice provider directory 的缓存/受限刷新读取该模型 input/output 单 token价格，用 token 数计算成本；目录失败时明细仍落库，费用为 null，不阻断固定档位扣费。
- 若 Venice 流式响应没有 OpenRouter `x-generation-id`，`generationId` 可来自 SSE JSON `id`；缺失时现有 settlement 是否要求 generation id 需要实现时核查。若必须有，使用 deterministic synthetic id 不可行会影响外部对账；更稳妥是允许 fixed-tier charge 在 provider 无 generation id 时以 `chargeId` 作为内部幂等 key，但这需要检查 `charge_llm_usage` RPC 对 generation id 的约束。
- `sync-job.ts` 的 DB 查询如果按缺 metadata 拉所有 success 行，必须过滤 provider 或在 metadata 中记录 `provider: 'venice'` 后跳过，避免永远回捞 Venice。

## Database / migration 设计

provider catalog migration 继续更新校验函数；另新增一个日期 migration 创建 Venice 调用明细表。

- 更新 `admin.validate_model_catalog_core(jsonb)`：
  - 允许旧模型只有 `openrouter_model_id`。
  - 允许新模型有 `provider` + `provider_model_id`。
  - `provider` 限定 `openrouter` / `venice`。
  - 默认/启用/稳定 ID/tier 校验保持不变。
- 更新 `admin.validate_model_catalog_prd(jsonb)`：
  - 对 OpenRouter：`provider_model_id` 或 `openrouter_model_id` 仍需符合 `vendor/model`。
  - 对 Venice：`provider_model_id` 非空、长度限制，不强制 slash。
  - `(provider, provider_model_id)` 去重。
- 如现有 config/draft/release 历史需要 JSON 回填：
  - 可以不批量改历史，应用层 normalize 即可读。
  - 若 DB validate 在编辑旧草稿时要求新字段，则 migration 应对 active runtime_config 和 drafts 做兼容回填，只给 OpenRouter 旧记录补 `provider` / `provider_model_id`。
- 回滚：
  - 若尚未发布 Venice 配置，可恢复旧 validate 函数。
  - 若已经发布 Venice 配置，旧 backend 不理解；回滚代码前必须先在 Admin 发布全 OpenRouter catalog 或执行 forward-fix 禁用 Venice 模型。

### 新表归属与不变量

- 建议对象：`experience.venice_chat_history`，含义是“每个 Venice 主对话轮次唯一一条 provider 回传与 usage 明细”。
- 业务不变量：`chat_history_id` 唯一且引用 `experience.chat_history(id) ON DELETE CASCADE`；`llm_provider_name` 恒为 `venice`；只存上游标识、usage、价格计算结果和时延，不存 prompt/reply 正文。
- 归属理由：它是用户核心文本互动的 provider 处理产物，按八域地图属于 `experience`；不是金额扣减权威事实，真实扣费仍由 `billing.llm_usage_charges` 维护。
- 权威写入方：仅 backend `features/generation/settle.ts` 经专用 repository upsert；`chat_history_id` 作为幂等键，异步重入不得产生重复行。
- 生命周期：跟随主对话级联删除；历史保留期默认跟随主对话。运行时生成不读取该表决定业务，只用于运营排障、成本观察和后续分析。
- 跨域依赖：同 schema FK 到 `experience.chat_history`；不直接 FK billing charge，charge id/generation id 作为可空观测字段留在归一化元数据中。无触发器、无跨 schema 事务。
- 权限：表 owner 沿用迁移执行者；仅 `service_role`/`postgres`，显式 revoke `anon`/`authenticated`；当前 experience schema 不向浏览器角色暴露，因此不创建客户端 RLS policy。
- 索引/容量：唯一索引 `chat_history_id`，按 `llm_generation_id` 和 `created_at` 排障的普通索引；每个 Venice turn 一行，小型 JSON 元数据且禁止 choices/正文，容量与 Venice 调用量线性增长。
- 避免双重事实源：主对话状态、正文、扣费结果继续只在现有表；Venice 的 `llm_provider_name/usage/token/latency/generation_data` 不再写入主表。主表只保留计费闸门所需 `llm_generation_id`/`llm_finish_reason`。
- 发布顺序：先在 TEST 创建表并验证权限/FK，再部署会写表的 backend，最后启用 Venice catalog。回滚 backend 前可保留空闲表；彻底回滚时先停 Venice 流量再 drop 表，无需迁移主对话数据。

## Reliability design

- 超时：目录同步沿用 8 秒 provider HTTP timeout；生成沿用 120 秒整体上游 timeout。Venice 调用必须使用同一 deadline，不因 provider 选择重置。
- 重试：目录读取只复用缓存/手动刷新，不自动无限重试；生成写操作不自动重试，因为可能产生重复上游生成与重复扣费。
- 幂等：生成计费仍以 `chargeId` 和现有 RPC 幂等语义为准；Venice 明细以 `chat_history_id` upsert，settle 重入安全；目录同步是只读，可安全重复。
- 并发：目录 client 保留 in-flight 去重；配置发布继续走现有 Admin 草稿/发布并发控制。模型选择和生成继续以后端持久化 selected model 为权威。
- 事务：不做 `chat_history`、Venice 明细与 billing 的跨 schema 原子事务；三者均有独立幂等键，明细失败记录日志但不回滚已完成的主对话或扣费，后续可 forward-fix 补写。
- 降级：目录同步失败返回 stale 缓存；runtime catalog 损坏继续降级 `DEFAULT_CATALOG`；Venice key 缺失时目录同步和生成返回可行动错误，不回退到 OpenRouter 以免错用模型。
- 补偿：Venice 生成若在 2xx 后流中断，按现有 `stream_interrupted` 不扣费，但仍记录已观察到的 usage/时延（如有）；Venice 没有等价 generation 查询接口，不虚构回捞。明细写失败靠日志和 chat history id 定位 forward-fix。
- 限流：首期不加队列；依赖 provider 429 返回错误并安全不扣费。目录手动刷新可缓存 15 分钟降低压力。
- 容量：目录只保存内存缓存；每个 Venice turn 新增一行 provider 元数据，`llm_generation_data` 严格移除 choices/content，避免大响应正文复制。
- 可观测性：日志记录 provider、providerModelId、stable model id、status、upstreamStatus、stale、耗时；禁止记录 API key、完整 provider error body、用户消息正文。
- 缓存风险：Venice `prompt_cache_key` 只作为缓存亲和提示，不参与业务正确性；生成失败或缓存未命中不得影响扣费/收口判断。不要把用户输入、token 或敏感正文放入 cache key。

## 最小充分方案

新增/改动集中在：

- shared provider/model catalog schema 与纯配置。
- Admin 一个 provider directory helper/config + 现有 editor 小范围改造。
- Backend 一个 provider directory abstraction + generation upstream provider selection。
- provider catalog validate migration + 一个最小 Venice 明细表 migration。
- env/example/docs 更新。

拒绝的过度设计：

- 不新建 `model_providers` 数据表，也不复制主对话整行。
- 不做通用插件化 provider SDK。
- 不在用户端暴露 provider 选择。
- 不把 OpenRouter provider routing 泛化到所有平台。
- 不预建队列、全局缓存服务或多 region failover。

## 发布顺序

1. Shared 新 schema 兼容旧 catalog。
2. DB migration 放宽/演进 `llm_model_catalog` 校验，并在 test 环境验证旧 catalog 仍可发布。
3. Backend 支持 provider-aware runtime + generation + Venice env fail-fast/可行动错误。
4. Admin 支持平台目录同步与 provider 字段编辑。
5. 文档与 Railway 变量模板补充 `VENICE_API_KEY` / `VENICE_BASE_URL`。
6. Test 环境配置 Venice key，Admin 同步 Venice text models，发布一个下架 Venice 模型做结构验证，再发布一个可见 Venice 模型做人工生成 smoke。

## 验证策略

自动验证：

- `pnpm --filter @miniapp/shared typecheck`
- `pnpm --filter @miniapp/shared test`
- `pnpm --filter @miniapp/admin typecheck`
- `pnpm --filter @miniapp/admin test`
- `pnpm --filter @miniapp/admin build`
- `pnpm --filter @miniapp/backend typecheck`
- `pnpm --filter @miniapp/backend test`
- `pnpm -r typecheck`
- SQL migration 在 test DB 单文件执行前后记录 shape、函数签名、旧 catalog 发布、新 provider catalog 发布与回滚/forward-fix。

人工回归：

- Admin 在 test 环境同步 OpenRouter 与 Venice 目录。
- 新建模型默认 OpenRouter；切换 Venice 后 OpenRouter ID 下拉禁用/清空，只显示 Venice 模型。
- 发布旧 OpenRouter-only catalog 无行为变化。
- 发布包含 Venice enabled 模型的 catalog 后，用户打开「选择剧情引擎」可看到稳定模型展示，选择后发起文本对话成功收流。
- Venice key 缺失、目录 401/429/5xx、模型 offline/目录缺失、生成 4xx/5xx/流中断均有可行动错误且不扣费或按既有规则收口。
