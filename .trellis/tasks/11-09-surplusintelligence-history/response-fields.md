# Surplus 受控响应字段覆盖清单

本清单对应 `surplus-response-schema.ts`、`surplus-response-filter.ts`、`surplus-response-capture.ts`，版本1。字段是可选协议候选，不代表所有模型实际返回；仅保存实际出现且合法的数据。会话正文仍只由 `chat_history` 保存。

## 来源与结构

| 来源       | JSONB 路径                                                 | 来源证据/处理                                                                    |
| ---------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 非流式返回 | `body.<厂商字段>`                                          | 已读取的 Chat Completions 对象，按逐叶 schema 过滤                               |
| SSE帧      | `stream.<厂商字段>`                                        | 首帧、稀疏中间帧、终态usage合并；choice按index，usage是快照而非增量              |
| HTTP响应头 | `headers.<小写厂商头>`                                     | 显式头清单及语法校验，保留合法原字符串，不存Headers全集                          |
| 请求详情   | `request_record.<厂商字段>` 或 `.data/.request.<厂商字段>` | 受限详情读取；只支持明确data/request包裹，不接受任意嵌套data                     |
| 本地采集   | `capture.*`                                                | schema_version=1、来源/完整性/遗漏/冲突/stream_completed；不是厂商收费或业务终态 |

## 响应体/SSE/详情字段

下列字段在body/stream/request_record三个来源分别保存，不浅层覆盖其他来源；详情的 `id` 仅作为request ID候选，绝不当作generation ID。

| 厂商路径                                                                                                                                                                                                                                                                            | 类型/边界                                                | 查询投影/用途                                                             | 证据                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| id/request_id/generation_id                                                                                                                                                                                                                                                         | 非空协议标识符，最长512，拒绝凭据形状                    | generationId/requestId独立；冲突保留首身份并标记invalid/identity_conflict | Chat Completions/请求详情                    |
| object/model/provider/provider_name/system_fingerprint/service_tier/finish_reason/status                                                                                                                                                                                            | 标识符或短标签，512/128字符                              | model/providerName/finishReason；其他保留JSON原名                         | OpenAI兼容形状；实际响应需验证               |
| created                                                                                                                                                                                                                                                                             | 非负安全整数                                             | 原值JSON                                                                  | OpenAI兼容形状                               |
| created_at/completed_at                                                                                                                                                                                                                                                             | 有界协议时间字符串                                       | 原值JSON；不伪造时间                                                      | 详情候选，实际响应需验证                     |
| choices[].index/finish_reason                                                                                                                                                                                                                                                       | 非负整数/短标签                                          | 所有choice按index合并；finishReason投影                                   | OpenAI兼容choice                             |
| choices[].message.role / choices[].delta.role                                                                                                                                                                                                                                       | 固定角色枚举                                             | JSON保留非正文结构                                                        | OpenAI兼容choice                             |
| choices[].message.tool_calls[] / choices[].delta.tool_calls[] 的index/id/type                                                                                                                                                                                                       | 非负整数/有界标识符/function枚举                         | JSON保留工具关联结构                                                      | OpenAI兼容候选；不启用新的工具产品           |
| usage.prompt_tokens/completion_tokens/total_tokens/input_tokens/output_tokens/cached_tokens/reasoning_tokens/cache_creation_input_tokens/cache_read_input_tokens                                                                                                                    | 非负安全整数，0有效                                      | 常用token投影，其余保留JSON                                               | OpenAI兼容usage候选                          |
| usage.prompt_tokens_details/completion_tokens_details/input_tokens_details/output_tokens_details 下 cached_tokens/reasoning_tokens/audio_tokens/text_tokens/image_tokens/video_tokens/accepted_prediction_tokens/rejected_prediction_tokens/cache_creation_tokens/cache_read_tokens | 每个叶子为非负安全整数                                   | cachedTokens/reasoningTokens投影；全部合法叶子保留嵌套原名                | OpenAI兼容usage细项候选，实际响应需验证      |
| usage.buyer_cost_micro/usage.cost_micro、顶层buyer_cost_micro/cost_micro                                                                                                                                                                                                            | 非负安全整数或最多30位规范十进制整数字符串，原始类型保留 | buyerCostMicro及精确usageUsd；不估价、不用unsafe Number                   | 官方inline成本；其他cost_micro需实际响应核实 |
| currency                                                                                                                                                                                                                                                                            | USD/USDC及小写枚举                                       | JSON保留；不假设缺失值                                                    | 明确单位候选                                 |
| route_overhead_ms/first_token_ms/upstream_total_ms/latency_ms/generation_time_ms                                                                                                                                                                                                    | 有限非负数                                               | 供应商时序投影；与本地耗时分开                                            | 官方请求详情分解                             |
| served_by/marketplace_attempts/truncated                                                                                                                                                                                                                                            | rail枚举/非负安全整数/bool                               | JSON保留及truncated投影                                                   | 官方路由概念；body字段需实际响应核实         |
| error.code/type/param/request_id/status                                                                                                                                                                                                                                             | code为安全整数或协议标识符；其他逐叶类型/长度限制        | errorCode及JSON诊断                                                       | 受控错误形状；无原始message                  |

## 响应头与SSE注释

| 厂商字段                                      | 类型/边界                                                | 保存与投影                                                                                           |
| --------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| x-request-id/x-si-request-id、x-generation-id | 有界无凭据标识符                                         | 保留原字符串，request/generation分别投影；不得相互推断                                               |
| x-si-served-by                                | marketplace/preferred_key/fallback_key                   | 原值保留                                                                                             |
| x-si-provider-family/x-si-marketplace-status  | 有界协议标识符/状态                                      | 原值保留，来自官方reasoning适配披露                                                                  |
| x-si-routing-decision-ms                      | 有界非负十进制毫秒串                                     | 原值保留，不与本地首字耗时混用                                                                       |
| x-si-marketplace-attempts                     | 非负最多30位整数字符串                                   | 原值保留，不把attempt总数当唯一诊断                                                                  |
| x-si-attempts                                 | <=8192字符，严格provider:offer:枚举原因格式及可选+N more | 原值保留；失败原因仅unavailable/rate_limited/not_found/upstream_error/request_rejected/timeout/error |
| x-si-adapted-params                           | <=2048字符，参数标识符逗号列表                           | 原值保留，不存任意自由文本                                                                           |
| x-si-buyer-cost-micro                         | 最多30位规范非负整数串                                   | 原值及精确成本投影，缺失保持未知                                                                     |
| x-si-truncated                                | 0/1                                                      | 原值及bool投影，独立于本地取消                                                                       |
| x-si-secret-masking                           | applied/not_applied                                      | 状态，不存秘密                                                                                       |
| x-si-secrets-masked/x-si-secrets-withheld     | 有界非负整数串                                           | 计数原值                                                                                             |
| x-ratelimit-limit/x-ratelimit-remaining       | 有界非负整数串                                           | 原字符串，0有效                                                                                      |
| x-ratelimit-reset/retry-after                 | <=64字符，合法数字或HTTP日期                             | 原字符串，不擅自解释时间单位                                                                         |
| `: si-secrets-withheld <n>`                   | 严格非负整数注释                                         | `stream.si_secrets_withheld`，不保存其他注释                                                         |
| `[DONE]`                                      | 明确终态标记                                             | capture.stream_completed；中断另记来源不可用                                                         |

头/成本/时延来源：[官方路由说明](https://www.surplusintelligence.ai/docs/marketplace/routing-controls)、[官方网关用量说明](https://www.surplusintelligence.ai/docs/getting-started/whitelabel)。请求参数及兼容返回形状参考[官方Chat Completions](https://preview.surplusintelligence.ai/docs/api-reference/chat-completions)。文档与目标环境差异仍需TEST smoke确认。

## 排除、完整性和容量

- 排除content/text/reasoning/refusal、工具function.name/arguments（当前请求没有已确认工具名契约）、logprobs token/bytes、任意message错误正文、凭据、账户数据以及未知字段的值。仅按路径诊断遗漏；动态/凭据形状key变为`[dynamic]`。
- 未知字段不原样透传；capture.counts及最多64个去重路径/类型描述其原因，超出另计diagnostics_omitted。合法稀疏字段保存，后续null不抹去已知值，显式null与未出现仍可区分。
- 同来源受控标量变化保留最多64项冲突摘要，身份变化冻结首值并标记identity_conflict；不同来源分别保留。请求详情可提供较晚成本，但不擦掉inline证据。
- 深度8、数组128项；response_metadata<=128KiB UTF-8，超限先丢重复冲突摘要/工具宽数组再裁choice诊断，保留身份/终态usage/金额并标partial。不能用大raw正文旁路。
- complete只表示已观测来源中的已识别字段无非法/未知/超限，不保证供应商有返回所有可选字段；expected正文排除不把正常采集误标失败。不可用来源显式记录；未知版本seed不信任、不伪标complete。
- 单元回归覆盖稀疏首末帧、nested usage/zero、choice index、header全部受控项、30位成本、独立ID/来源、错误/正文排除、恢复重验及大数组容量。
- 容量按PostgreSQL `jsonb::text` 的UTF-8字节数估算，包含结构分隔符空格与科学计数法展开；不是仅测紧凑JSON。身份冲突增加capture.identity_conflict，冻结首身份但保留受控冲突证据。
- 可选capture.reasoning_control记录已请求的思考开关、模型声明参数名及控制不可用原因；不记录任意parameters。官方[Reasoning Controls](https://www.surplusintelligence.ai/docs/reference/reasoning)明确未公布逐模型努力值且include_reasoning在chat wire被移除，因此当前只保守返回provider_default/unavailable，不伪造reasoning.enabled或高/零努力通用映射。
