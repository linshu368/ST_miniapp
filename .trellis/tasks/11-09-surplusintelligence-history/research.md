# 复用与证据（2026-11-09）

## 当前来源与差异

- SOURCE：shared/api/model-providers.ts 支持 surplus；runtime-config.ts 读取后端地址/key；model-provider-directory.ts 已有 8s 超时、15min 缓存、刷新合并与陈旧降级。
- SOURCE：execute.ts 的 Surplus 只带标准字段，非流式 provider_response 仅对 Venice 构造；prompt-engine.ts sampling 恒为空，不能把默认值记成已发送参数。
- MIGRATION：20260929_llm_model_catalog_multi_provider.sql 的 validator 排除 surplus；20261023_chat_first_token_fallback.sql 两表 CHECK 排除 surplus，交付 RPC 非 OR 一律写 Venice。
- SOURCE：GenerationObservationRepository.begin 在发出生成前执行，数据库缺口能直接阻断聊天。
- SOURCE：surplus-billing-recovery.ts 目前仅靠主表冻结快照扫描，没有调用专表。
- DOC：11-06-admin-surplus-model-provider/design.md 声明无需 migration，与现有约束冲突；不能据旧规划认定完整接入。
- ENV：生产 CLI 返回 setup_required，Supabase MCP 缺 link_id；未确认目标、未读取业务行。TEST/Production shape/账本/规模待各环境独立核实。
- ENV：Get-Command 未发现 docker/psql；需确认隔离 PG/PostgREST 运行条件，不改连共享远端库代替本地回归。

## 复用清单

| 类别         | 已检索对象                                                                                                                       | 决策                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| components   | ModelCatalogEditor、admin-client configSchemas/menu、admin-cli config                                                            | 复用 surplus 面板与现有发布，不新增专页/API/命令；校验真实 DB 流程          |
| hooks        | turn-execution hooks、first-token store callbacks                                                                                | 扩展 dispatch/响应记录，不在 UI 直连供应商                                  |
| helpers      | buildUpstreamBody、forwardToUpstream、createSseTap、boundedResponseMetadata                                                      | 提取/扩展专用白名单映射，保留 provider 参数隔离                             |
| contracts    | model-providers、models、ProviderModelDirectory                                                                                  | 复用枚举；能力接线确需时兼容增加可选 supported_parameters，不透传任意 JSON  |
| features     | execute、settle、sync-job、fixed-provider-recovery、apply-charge                                                                 | 复用唯一生成/计费出口，成本只作观测                                         |
| repositories | VeniceChatHistoryRepository、OpenRouterChatHistoryRepository                                                                     | 参考唯一父键、CAS/read-back/非空事实保留；新增专用 repository，不建通用框架 |
| repositories | ConversationHistoryRepository、GenerationObservationRepository                                                                   | 扩展身份与恢复；主表仍拥有业务终态及账务                                    |
| DB functions | validate_model_catalog_core、begin_chat_generation_observation、select_chat_generation_delivery、observe_chat_generation_attempt | 前向修正，保留锁/CAS/OID/ACL，不改历史文件                                  |
| 验收         | test-first-token-fallback-local.sh、openrouter-retirement-local.mts、ui-tests @chat                                              | 扩展已有 PG/PostgREST 与 @chat 场景，不另造 mock 后端                       |

## 官方协议

- https://www.surplusintelligence.ai/docs ：canonical base / public model directory。
- https://preview.surplusintelligence.ai/docs/api-reference/chat-completions ：官方预览参数参考；正式同路径抓取不可用，不能据预览替代目标环境 smoke。
- https://www.surplusintelligence.ai/docs/reference/reasoning ：supported_parameters 决定 reasoning / reasoning_effort 形状，不套 OR 对象。
- https://www.surplusintelligence.ai/docs/getting-started/whitelabel ：非流式 x-si-buyer-cost-micro / usage.buyer_cost_micro；流式终态 usage.buyer_cost_micro 依赖 include_usage。缺值不等于 0。
- https://www.surplusintelligence.ai/docs/marketplace/routing-controls ：路由/截断头及 GET /requests/{id}；此页称需 requestlog.read，whitelabel 又称调用 key 可读自身详情。记录来源冲突，按实际权限验证；403 不提升权限、不阻塞固定报价结算。

## 复杂度

execute/settle/sync-job/ConversationHistoryRepository 在超长基线中。按触达职责拆分请求构造、供应商记录、响应消费及恢复；通过验证后 update 收紧基线，不继续向超长方法追加。
