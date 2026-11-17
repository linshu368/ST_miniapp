# 技术设计（2026-11-10 已确认实施）

## 数据归属与不变量

新增 `experience.surplusintelligence_chat_history`，保存关联聊天轮次的 Surplus 调用事实，归属 experience 交互执行域；不是 billing 扣费权威、admin 配置或 analytics 投影。

- 唯一 chat_history_id UUID，FK → experience.chat_history(id) ON DELETE CASCADE。当前每轮最多一次 Surplus 主调用，fallback 始终 OR。
- 可选 attempt_id 关联 experience.chat_generation_attempts，存在时必须同父轮次；非竞争 execute 可无 attempt。
- generation repository 与既有交付 RPC 是权威写入方；客户端/分析角色不直接写。
- 保留失败/取消/竞争输者。Surplus 输者明细可与 OR 胜者明细同父并存；交付认 generation_requests.delivery_attempt_id / 冻结报价，不能靠表中有行判胜者。
- 随父轮次删除，不回填未知历史参数/响应；旧 snapshot-only 行继续可恢复固定档位计费。
- 跨 schema 依赖仅沿用 admin validator → app_core 已发布配置；新明细的 FK/交付原子写在 experience 内，不新增跨域 JOIN/触发器。

## 表形状与边界

| 分组 | 字段/语义                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关联 | id、唯一 chat_history_id、可选 attempt_id、provider 常量 surplus、created_at、updated_at                                                           |
| 请求 | request_parameters JSONB：实际发送的 model/stream/采样/已支持 reasoning/stream_options 白名单；供应商 request_id 与 generation_id 分开，不假设相等 |
| 调用 | http_status、call_status(prepared/dispatched/completed/failed/interrupted/unknown)、finish_reason、受控 error_code；业务终态仍归主表               |
| 观测 | 实际 model/provider（返回时）、prompt/completion/cached/reasoning/total tokens、buyer_cost_micro、usage_usd、latency_ms、generation_time_ms        |
| 响应 | response_metadata JSONB：按来源保存尽可能完整的受控响应字段、嵌套 usage、choice 非正文元数据、路由/限流/适配/截断等；另带采集版本与完整性诊断      |

request_parameters 上限16KiB；为尽量保全嵌套响应，将 response_metadata 初始上限从32KiB调整为128KiB（含采集诊断），按脱敏 fixture 的实际尺寸与容量测试复核，不能用原32KiB任意裁掉合法字段。mapper限制类型/长度/深度/数组/数字范围，SQL验证对象与序列化UTF-8字节数。非关键诊断超限必须标记，身份与金额不静默截断。缺值 NULL，0 仅表示真实零；微美元明确单位，不用目录估价冒充真实成本。

启用 RLS，撤销 PUBLIC/anon/authenticated；只授 service_role 必要 CRUD，postgres 管理。默认不授 Grafana JSON 读取。父唯一键支持连接/幂等，generation ID 非空索引、created_at 索引用于有界恢复，不预建 JSON GIN。

不存鉴权头/密钥、URL query、账户标识、任意原始错误、prompt/回复/思考正文。这里的响应数据来自既有 HTTP/SSE，不新增 webhook。

## 受控响应尽量完整保存（2026-11-10 修订）

### 字段覆盖与保存结构

实现前建立逐字段覆盖清单：`来源/厂商字段路径/类型与边界/JSONB保存路径/常用列投影/证据/排除理由`。清单基于官方文档与真实脱敏结构验证，下表是必须调查和覆盖的类别，不代表每个模型一定返回这些字段。

| 类别           | 受控保存范围                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份及模型     | id、object、created、model、已确认的request/generation ID、system_fingerprint、service_tier及实际供应商等经验证字段；保留来源，不混用不同ID                                                                                              |
| choice非正文   | 对实际返回的每个choice保留index、finish_reason、合法role等结构元数据；逐路径提取，不因处于choices/message/delta内就整块丢弃。若实际出现工具元数据，仅保留经当前请求契约确认安全的ID/type/index/工具名，排除arguments及正文               |
| token与usage   | prompt_tokens、completion_tokens、total_tokens、prompt_tokens_details/completion_tokens_details内已确认的cached/reasoning/audio/prediction等明细，以及Surplus支持的其他受控计数；保留嵌套原名，不只映射四个token列，不将多个快照重复相加 |
| 成本及结算观测 | usage.buyer_cost_micro、x-si-buyer-cost-micro、请求详情中的受控成本/结算状态及明确币种/单位；原始安全整数或十进制字符串与规范化投影并存，保持精度；不推算不存在的费用                                                                    |
| 路由及参数适配 | x-si-served-by、x-si-marketplace-attempts、x-si-attempts、x-si-adapted-params、x-si-truncated；保留经过语法校验的原值与有需要的解析结果，不仅留下attempt总数                                                                             |
| 限流与重试     | x-ratelimit-limit/remaining/reset、retry-after、经确认的其他限流头；日期/秒数先保留合法原值再解析，不假设所有响应都提供                                                                                                                  |
| 脱敏状态       | x-si-secret-masking、x-si-secrets-masked、x-si-secrets-withheld，以及终态SSE注释si-secrets-withheld中的计数；只记录状态/数量，不能记录被替换的秘密                                                                                       |
| 时序与结束状态 | 供应商详情中的route_overhead_ms/first_token_ms/upstream_total_ms、已确认的创建/完成时间/状态，与本地首字/总时长分开；[DONE]观测、HTTP状态、供应商截断和本地中断原因独立                                                                  |
| 错误诊断       | 文档或协议确认的error.code/type、枚举型失败原因、可安全解析的参数标识及关联ID；自由文本message、HTML错误页和任意data/body仍排除                                                                                                          |

- `response_metadata` 采用有版本的来源分区（如 body、stream、headers、request_record、capture），在分区内保留经白名单schema核验的厂商字段名/原始类型/结构；常用列只作查询投影，不取代嵌套证据，也不成为第二计费权威。
- header明确逐项列入清单，名称统一小写，保留安全原值；禁止直接保存Headers全集或按`x-si-*`前缀无条件放行。
- 不整体保存choices，但必须从中提取受控非正文叶子；content、reasoning、refusal自由文本、tool arguments、logprobs中的token/bytes等能还原正文的数据不进入调用明细。
- usage等嵌套对象不能只校验“是对象”就原样透传；受控嵌套字段逐项验证。新字段通过覆盖清单/mapper/schema/fixture增补，不能以任意JSON兜底绕过边界。

### 多来源与流式合并

- 采集响应头、首个事件、中间元数据变化、终态usage/[DONE]、非流式结果与可读的请求详情。首帧独有字段不能被最后一帧覆盖；空usage、缺字段及后续null不能抹掉已确认事实，原始显式null与未提供在JSON证据中可区分。
- 以内存有界累加受控字段，按来源/choice index合并，保留重要字段首次/终态值与有界变更/冲突诊断，不保存全部SSE包或逐token事件，不每个delta写库。
- 不用一次浅层spread合并不同来源。成本详情可作为较晚结算观测，但不覆盖较早inline成本的来源证据；相同类型字段冲突记录来源与受控值。身份冲突仍走拒绝/人工核验，不能为保存更多字段而允许变更调用归属。
- 详情补齐复用当前只读接口及预算；失败/403/无ID标记来源不可用，不能因此把整个明细算作完整，也不阻塞固定报价收费或重发生成。

### 完整性、容量与演进

- `capture` 至少记录schema_version、已观测/不可用来源、采集状态(complete/partial/unavailable)、丢弃/非法/超限/未知字段的数量与受控原因。complete仅表示已观测来源中已识别受控字段保存完整，不代表供应商返回了全部可选数据。
- 未识别字段仅记录安全规范化字段路径/类型/计数以供后续补充清单；动态key、用户文本、凭据形状的key与未知值不持久化。排除敏感值不输出到日志；路径清单本身有上限并记录溢出数量，不能静默遗漏。
- 初始结构边界为深度8、单受控数组128项、变更/冲突摘要64项；各字段另设符合协议的上限。以fixture测试验证，协议合法数据受限时记录具体原因。为capture和身份/终态/金额预留空间，超限先减少重复中间快照，再裁非关键诊断；不得直接截断JSON字符串或关键标量。
- 若合法终态元数据仍超预算，标记partial及缺口，保证业务交付/幂等结算，不新增raw大对象旁路。容量复核至少覆盖128KiB上界下每50条恢复批次的读取/内存成本，扫描仅选所需列，不批量加载完整JSON、不增加JSON GIN或额外服务。
- 新增厂商受控字段优先扩展JSON schema与映射，不为每个新字段加列；只有真实查询需求才增加标量投影。版本兼容读取已有记录，旧版/缺版本不伪标为完整。

## 接线顺序

1. 复用 registry/目录；前向扩展 DB validator 与 generation 两表 CHECK，未知 provider 仍拒绝，保留旧归一化。
2. 保留 begin_chat_generation_observation 锁与 admission/最终 prompt 冻结；真实 body 构造后、POST 前确认非正文参数/身份占位。保存不确认则不发收费生成；尽可能合并已有 dispatch 写，不每个 delta 写库。
3. Surplus SSE 显式 include_usage；只复用目录新鲜缓存记录 supported_parameters 与思考控制可用性，不为诊断冷查询目录。官方未公布通用 effort 合法取值，不能把布尔开关臆造为 reasoning.enabled 或 effort=high/none；UI仍控制公开思考展示，供应商执行遵循默认能力。不套 OR routing/Venice 参数，不新增参数编辑 UI；sampling={} 如实记录。
4. header/SSE/non-stream 首次 ID 使用 NULL-only CAS/read-back，同 ID 幂等、冲突拒绝；已收到正文快照先保留，身份存储失败不清空正文。
5. 流式/非流式共用 Surplus mapper与字段覆盖清单，按来源尽量完整保存非正文响应；正常/失败/停止/超时/输者均采集，记录完整性与缺口；迟到结果不能更改交付。
6. select_chat_generation_delivery 显式区分三个 provider，Surplus 不写 Venice；输者明细不妨碍 OR 胜者，只有胜者进入账务恢复。
7. chat_history 仍保存正文/业务状态，settle/apply-charge 仍以原 charge_key/报价扣费；供应商成本不改变固定档位价格。

## 故障与可靠性

| 模型                     | 处理                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 缺 key/鉴权/429/5xx      | 记录可确认状态；不重放 POST，保留原额度/告警处理                                                                                                       |
| 网络/流断/绝对超时       | 有界调用，缺终态不推断 stop；部分回复沿现行收口                                                                                                        |
| 本地停止/取消与迟到 stop | 原业务/扣费规则优先；供应商事实不能反写取消原因                                                                                                        |
| 首字竞争 OR 胜出         | 留 Surplus 记录，交付快照归 OR，一次结算                                                                                                               |
| DB 写结果未知            | 单操作5s/身份总10s/最多两次幂等写，先读回，身份冲突拒绝                                                                                                |
| 元数据写失败/进程退出    | 接收终态形成有界快照并排入异步诊断队列，不等待诊断延迟EOF或改变计费；重启在已有24h/50条预算内按确认ID补录，未确认数据标unknown                         |
| usage/成本缺失           | 确认 request ID 时 GET /requests/{id} 有界只读补齐，5s，有限退避共享 provider-fetch 预算；403/404/无 ID 降级 unknown，不增管理密钥、不阻塞固定报价结算 |
| 扣费 RPC 失败/并发恢复   | 原永久 charge_key、免费额度/创作者收益事务与补偿；metadata 完整和账务完成分开                                                                          |
| 旧 snapshot-only         | 仍按原快照恢复，不伪造身份；冲突进入人工核验                                                                                                           |

不增加队列/服务、插件框架、参数中心或第二账务状态源。容量复用有界调度、每轮小批并发；不实时查目录估成本；不因诊断失败重新生成。

## 迁移、兼容与恢复

2026-11-10 TEST用户报告 `Unexpected installed delivery provider branch`：已在隔离引擎复现仅把输入SQL改为CRLF即可触发同错误。新增完整前向兼容入口 `20261110_surplusintelligence_chat_history_compat.sql`，原文件保留不变；所有多行anchor/replacement和目标函数文本统一LF，并要求唯一命中。数据归属/接口/锁/事务/ACL/性能预算和业务行为不变；保留未知版本拒绝，不把格式修复扩大为语义适配。既有批准范围包含迁移失败回归，需覆盖安装定义与输入文件LF/CRLF四组合、拒绝未知分支、事务回滚及OID/owner/ACL不变。

- 每次只执行一份 packages/shared/migrations/ 下的前向SQL；目前使用完整compat文件，声明experience及admin validator依赖，不改原历史文件。
- 先核对父表/generation表、CHECK、函数签名/定义/OID/owner/ACL、账本和规模；未确认远端环境不执行。
- 5s lock_timeout/60s statement_timeout，短事务新增空表与修正约束/RPC；大表 CHECK 评估 NOT VALID/VALIDATE 扫描，超预算停止。不重写主表或回填正文。未知线上定义差异拒绝覆盖。
- 隔离PG17/PostgREST → TEST单文件迁移 → TEST应用/真实小样本 → Production独立迁移 → 应用 → CLI草稿/diff/明确同意后发布模型。
- 保持函数 OID/签名/owner/ACL、旧OR/Venice行为。历史参数/usage不补假值。
- 停止条件：身份/表归属错、重复收费、取消漂移、权限泄露、首字/错误率劣化；先禁用Surplus配置保留表，使用受审阅forward-fix或已验证兼容应用。不能回滚到误写Venice的版本或DROP新事实。

## 验证与性能

计费/并发/契约/迁移需回归锁定：扩展现有execute/settle/sync/repository与PG/PostgREST harness；本规划明确允许新增专用mapper/repository单测与SQL场景。

6s首字为观测目标，不新增硬取消；现有深度思考与绝对截止语义保持。无可见P95基线均null；页面加载3000ms/API首字6000ms是待评审工程目标，发布前后各24h按双端/模型/版本观察。

建议扩展已有ui-tests @chat：Surplus正常发送、切换/重生成、停止/取消、慢首字OR兜底；模拟证明页面事件，真实供应商/钱包/键盘独立验收。辅助审核/润色沿transport但不造聊天父行。
