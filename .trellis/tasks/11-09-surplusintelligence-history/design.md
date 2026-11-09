# 技术设计（待审核）

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
| 响应 | response_metadata JSONB：usage、ID/object/created/model、finish_reason、路由/截断等受控字段，排除 choices/message/delta/思考正文                   |

request_parameters 上限16KiB、response_metadata上限32KiB；mapper限制类型/长度/深度/数组/数字范围，SQL验证对象与大小。非关键诊断超限标记丢弃/截断，身份与金额不静默截断。缺值 NULL，0 仅表示真实零；微美元明确单位，不用目录估价冒充真实成本。

启用 RLS，撤销 PUBLIC/anon/authenticated；只授 service_role 必要 CRUD，postgres 管理。默认不授 Grafana JSON 读取。父唯一键支持连接/幂等，generation ID 非空索引、created_at 索引用于有界恢复，不预建 JSON GIN。

不存鉴权头/密钥、URL query、账户标识、任意原始错误、prompt/回复/思考正文。这里的响应数据来自既有 HTTP/SSE，不新增 webhook。

## 接线顺序

1. 复用 registry/目录；前向扩展 DB validator 与 generation 两表 CHECK，未知 provider 仍拒绝，保留旧归一化。
2. 保留 begin_chat_generation_observation 锁与 admission/最终 prompt 冻结；真实 body 构造后、POST 前确认非正文参数/身份占位。保存不确认则不发收费生成；尽可能合并已有 dispatch 写，不每个 delta 写库。
3. Surplus SSE 显式 include_usage；思考开关按模型 supported_parameters 适配，不套 OR routing/Venice 参数。不新增参数编辑 UI；sampling={} 如实记录。
4. header/SSE/non-stream 首次 ID 使用 NULL-only CAS/read-back，同 ID 幂等、冲突拒绝；已收到正文快照先保留，身份存储失败不清空正文。
5. 流式/非流式共用 Surplus mapper，正常/失败/停止/超时/输者均写受控事实；迟到结果不能更改交付。
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
| 元数据写失败/进程退出    | 接收终态先写有界快照，再异步结算；已有24h/50条/并发预算内恢复幂等写；无证据标 unknown                                                                  |
| usage/成本缺失           | 确认 request ID 时 GET /requests/{id} 有界只读补齐，5s，有限退避共享 provider-fetch 预算；403/404/无 ID 降级 unknown，不增管理密钥、不阻塞固定报价结算 |
| 扣费 RPC 失败/并发恢复   | 原永久 charge_key、免费额度/创作者收益事务与补偿；metadata 完整和账务完成分开                                                                          |
| 旧 snapshot-only         | 仍按原快照恢复，不伪造身份；冲突进入人工核验                                                                                                           |

不增加队列/服务、插件框架、参数中心或第二账务状态源。容量复用有界调度、每轮小批并发；不实时查目录估成本；不因诊断失败重新生成。

## 迁移、兼容与恢复

- 单份新前向 SQL 位于 packages/shared/migrations/，声明 experience 及 admin validator 依赖，不改历史文件。
- 先核对父表/generation表、CHECK、函数签名/定义/OID/owner/ACL、账本和规模；未确认远端环境不执行。
- 5s lock_timeout/60s statement_timeout，短事务新增空表与修正约束/RPC；大表 CHECK 评估 NOT VALID/VALIDATE 扫描，超预算停止。不重写主表或回填正文。未知线上定义差异拒绝覆盖。
- 隔离PG17/PostgREST → TEST单文件迁移 → TEST应用/真实小样本 → Production独立迁移 → 应用 → CLI草稿/diff/明确同意后发布模型。
- 保持函数 OID/签名/owner/ACL、旧OR/Venice行为。历史参数/usage不补假值。
- 停止条件：身份/表归属错、重复收费、取消漂移、权限泄露、首字/错误率劣化；先禁用Surplus配置保留表，使用受审阅forward-fix或已验证兼容应用。不能回滚到误写Venice的版本或DROP新事实。

## 验证与性能

计费/并发/契约/迁移需回归锁定：扩展现有execute/settle/sync/repository与PG/PostgREST harness；本规划明确允许新增专用mapper/repository单测与SQL场景。

6s首字为观测目标，不新增硬取消；现有深度思考与绝对截止语义保持。无可见P95基线均null；页面加载3000ms/API首字6000ms是待评审工程目标，发布前后各24h按双端/模型/版本观察。

建议扩展已有ui-tests @chat：Surplus正常发送、切换/重生成、停止/取消、慢首字OR兜底；模拟证明页面事件，真实供应商/钱包/键盘独立验收。辅助审核/润色沿transport但不造聊天父行。
