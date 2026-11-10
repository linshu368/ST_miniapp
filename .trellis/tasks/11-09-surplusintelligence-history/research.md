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

## 2026-11-10 响应保存范围补充

- USER：要求Surplus受控响应参数尽可能全部保存；本次仅修订任务规划，不视为批准start或产品代码实施。
- SOURCE：upstream.ts 的 boundedResponseMetadata 目前仅选id/object/created/model/usage/venice_parameters，不提取受控header或choice非正文叶子，不能直接作为本任务完整采集实现。现有OpenRouter mapper也仅是其专用字段集，不能照搬为Surplus完整协议。
- DOC（本次重新读取官方页面）：routing-controls描述x-si-served-by/marketplace-attempts/attempts/buyer-cost-micro/truncated/adapted-params，脱敏状态及SSE withheld计数；请求详情包含供应商时延分解。whitelabel描述inline成本、末尾usage与详情补齐、限流头。见上方同URL；协议可选项不等于已在目标环境观测到。
- DESIGN：扩大到body/SSE/header/request_record各来源的已识别受控字段，保留原名/类型/嵌套与来源，建立覆盖清单；choice中安全叶子不能因整块排除正文而遗漏。
- DESIGN：response_metadata从32KiB调至初始128KiB，增加版本/完整性/缺口原因及优先保留策略；合法字段覆盖、敏感/未知/超限处置和50行恢复内存成本必须验证。深层token细项、system_fingerprint/service_tier等作为需按实际响应验证的候选，不宣称所有Surplus模型均返回。

## 2026-11-10 TEST迁移失败与换行复现

- USER：确认在测试库执行，截图显示预期的legacy ELSE provider分支及immutable delivery/PT409保护。截图不是完整catalog采集，不据此声明远端所有shape或迁移状态。
- LOCAL-SQL：同一已安装函数，原迁移LF输入通过，CRLF输入必现P0001 `Unexpected installed delivery provider branch` / inline_code_block line9。`$delivery$`只归一化函数定义d，未归一化输入脚本中多行dollar-quoted模板，是可复现缺陷。
- FIX：新完整compat文件归一化全部anchor/branch literal并校验唯一匹配；原文件bytes保持不变，兼容历史已成功环境的filename/checksum。没有改写旧交付函数的其他逻辑或移除版本保护。
- BOUNDARY：额外空格或显式ELSIF等未确认语义/格式变体仍拒绝；本次修复不通过宽泛正则猜测未知目标。TEST重试结果待用户实际执行，未操作远端数据库。
