# Surplus Intelligence 调用记录契约

## 1. Scope / Trigger

适用于模型目录、聊天生成、首字竞争及供应商响应记录。目标平台为 Surplus Intelligence，默认 `https://api.surplusintelligence.ai/v1`；`surplus` 是兼容保留的内部provider值，不是其他同名平台。本规范描述本地实现，不代表TEST/Production已迁移或真实调用已验收。

## 2. Signatures

- `experience.surplusintelligence_chat_history`：唯一chat_history_id及父FK级联；可选同父attempt_id；request_parameters≤16KiB、response_metadata≤128KiB。
- `prepare_surplusintelligence_call(p_history_id uuid,p_attempt_id uuid,p_request_parameters jsonb) → void`：冻结真实非正文参数，同值幂等、不同值拒绝。
- `record_surplusintelligence_call(p_history_id uuid,p_patch jsonb) → void`：行锁内补身份/投影/受控响应，NULL不清已有事实，业务主表不写。
- `claim_surplusintelligence_request_record(p_history_id uuid,p_now timestamptz) → boolean`：多副本补齐领取，最多6次并退避。
- `SurplusResponseCapture`：headers/observe/comment/finish/snapshot/projection；返回分来源JSON及查询投影，禁止原始响应归档。
- `forwardSurplusCall`：在首字竞争读取前包装原响应，输者也被采集；原正文bytes交给既有消费者。

## 3. Contracts

- 只有generation及受限RPC写明细，service_role必要权限，RLS启用，PUBLIC/anon/authenticated无直接读写。正文仍在chat_history，账务仍走既有charge_key/冻结报价。
- response_metadata按body/stream/headers/request_record/capture分区，原名、原始安全类型、choice非正文叶子及嵌套usage均保留；逐字段清单见任务response-fields.md。
- capture带schema_version、完整性、来源、丢弃/非法/超限/未知计数及受控路径。complete仅指已观测且识别的字段保存完整，不能证明所有可选字段都返回。
- 不保存prompt/回复/公开思考、工具arguments、logprobs可还原正文的token/bytes、鉴权头、密钥、账户标识、任意错误文本。未知字段保留安全路径/类型/计数，不保留值。
- generation/request ID分别校验，不能用body completion ID猜request-log ID；非法/凭据形状ID不能进入首字交付选择。SSE已收到内容先交给既有快照，身份写失败不得抹掉已收到正文；非流式先完整解析正文，再按保留正文路径处理身份失败。
- 纯诊断写入按单调用有界队列有序进行，不额外阻塞首字；请求冻结和身份CAS仍为正确性边界。终态/取消有限收口并记录失败，不重发POST。
- 成本缺失保持NULL，0须来自真实返回；大整数/微美元不损精度。首帧临时统计不冻结为最终投影；首个终态可纠正，随后经同request ID验证的request_record可更新权威投影，早期inline JSON证据保留。
- Surplus输者与OR胜者可同父有各自明细；只有delivery attempt/报价快照匹配的胜者可恢复计费。
- SSE明确include_usage。深度思考开关映射为思考强度：开=medium、关=none（2026-11-12 对畅聊在架模型实测：所有被测供应商都接受；Gemini 3 系列关掉隐藏思考后首字从 6～30 秒降到 1.5～4 秒，开时吐出思考过程；DeepSeek/GLM 恒定思考、参数无害）。写法按模型目录 supported_parameters：声明 reasoning 发 `reasoning: {effort}`，只声明 reasoning_effort 发顶层字符串，都没声明不发；目录仅复用现有缓存，不冷查询，缓存冷时发对象写法交 Surplus 自行去掉。不用 `{enabled:false}`（部分模型无效）。Surplus 的 supported_parameters 按模型、不分供应商：接口严格的供应商会因多余字段 400（实测 mistral：`extra_forbidden` loc=body.reasoning），对钉住的供应商按名单（mistral）或运行中学到的拒绝（6 小时）不发思考参数；派单探测碰到同类 400 去掉参数重探并记下。
- 恢复与收费独立：30秒既有调度、24h/50条标量扫描、至多3个worker，共享每轮9次GET预算，单GET5秒、每行最多6次且退避。只对确认request ID读取自身详情，403/404终止该来源；无ID终态标unavailable，不永久pending。prepared/dispatched超过120秒可按未知调用补录，不伪造终态或改账。

## 4. Validation & Error Matrix

| 输入/故障                    | 行为                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| 未知provider/旧DB缺约束或RPC | 拒绝，不绕过配置或写Venice                                            |
| 参数/调用ID冲突              | PT409或受控错误，保留冻结身份，不重放生成                             |
| 写结果未知                   | 5s单操作、10s身份总预算，最多两次幂等写；先读回                       |
| 元数据字段未知/非法/超限     | 标partial及受控原因，优先身份/终态/成本，不记录未知值或截断JSON字符串 |
| sparse事件/后续NULL          | 保留已知字段，按来源与choice index合并，不累加usage快照               |
| header截断/流断/取消         | 供应商原始观测与主表业务原因分开；不能凭stop覆盖系统中断              |
| 详情无可验证ID/返回不同ID    | 不标权威完成，不覆盖成本；有界退避或人工核验                          |
| 来源无权限/缺ID              | unavailable/forbidden/not_found，不加管理凭据、不阻塞固定报价结算     |

## 5. Good / Base / Bad Cases

Good：首帧身份与元数据、终态usage、受控headers及可读详情各自留证；原报价只收费一次。

Base：供应商未回成本或request ID，调用仍可完成；缺数据明确标未知，不能填零。

Bad：Surplus输者明细被当胜者收费；id含凭据形状仍透传给交付RPC；只保存少量平铺统计；后续NULL清首帧；全量headers/错误正文入库。

## 6. Tests Required

capture/filter/schema、repository、transport、nonstream、sync、shared model与既有生成/计费测试；覆盖跨来源字段、零值/精度、容量、身份失败保留正文、纯诊断不阻塞首字、无request ID、取消/兜底/并发恢复。

隔离SQL场景为migrations/tests/surplusintelligence_chat_history.sql，接入既有test-first-token-fallback-local.sh。PGlite/PG18 WASM仅验证已覆盖SQL行为，不代替PG17/PostgREST、多连接并发、真实供应商或真实钱包。UI复用@chat/@surplus虚构场景，不能证明数据库或供应商成功。

## 7. Wrong vs Correct

Wrong：只扩展TS provider枚举而遗漏DB CHECK/validator/交付分支；绕过迁移在生产改表。

Correct：新增单份前向迁移，测试结构/ACL/关键读写后按TEST→Production独立workflow执行，再部署应用、CLI草稿/diff/明确确认发布；保留调用事实，异常禁用新流量并forward-fix。

多行函数补丁必须统一目标定义、anchor和replacement的换行格式，分别覆盖输入SQL与已安装函数LF/CRLF四组合，并确认锚点唯一。只归一化pg_get_functiondef而不归一化dollar-quoted模板，会在Windows CRLF输入下误报未知版本。当前使用完整前向 `20261110_surplusintelligence_chat_history_compat.sql`，不改写原文件，未知分支仍安全拒绝。
