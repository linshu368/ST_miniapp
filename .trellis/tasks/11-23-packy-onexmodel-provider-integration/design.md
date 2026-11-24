> 2026-11-24: Implementation authorized by user. Reuse existing Venice/OpenRouter adapter entry points. Skip local UI tests/fixtures. Historical planning-only statements below describe the prior phase. Local OneX endpoint/proxy repair authorized by subsequent diagnostic request; No remote migration, publication or deployment; later user request authorizes controlled provider-generation verification.

# 技术设计

状态：规划，未实施。需求已明确，上游账户权限/账单协议是实施首步技术核验与发布门禁，不写成已验证事实。

## 1. 架构与复用边界

沿 shared registry → Backend config/runtime/directory → Admin 目录草稿发布 → Frontend 已有模型 hooks → generation transport → calls/cost_jobs 扩展 packy、onexmodel。两家共用小型 NewAPI 管理协议 adapter，差异由固定配置和经过验证的解析分支表达；不引入动态插件、任意 URL 代理、第二套计费或新 worker 服务。

推理使用现有 OpenAI-compatible /chat/completions，不新增 Gemini native 执行引擎。按实际能力适配 thinking、stream_options.include_usage、结束原因和 usage，不能把兼容协议当支持全部参数；OpenRouter provider routing、Venice body/cache 参数继续 provider-gated。新平台作为已发布主模型，不自动加入 OpenRouter 供应商优先级或改变兜底策略。

目录取调用 Key 的 /models；公开 pricing 仅作价格补充，与 Key 授权模型按 ID/分组严格交集。只放确定可文本调用的条目；缺模态证据的图片/视频/embedding 型号不伪装成聊天模型。沿现有 8 秒、15 分钟缓存、single-flight、stale 语义扩展，生成热路径不刷新目录。

## 2. 配置与对外契约

- 调用读取两组现有 _\_API_KEY / \_\_API_BASE_URL；管理读取 *\_API_SECRET_BASE / *\_API_SECRET_KEY / \*\_API_SECRET_USERT_ID。1XM_\* 以环境字典读取，USERT_ID 保持原名。值不写 shared、日志、fixture 或文档；不修改实际 .env。
- 配置仍经现有 config/runtime-config 所有者读取。URL 分别规范化，调用包含一次 v1，管理直接拼 /api。要求 HTTPS，无 userinfo/query/hash；不跟随跨 origin 重定向，不把管理令牌发往推理端点。
- 管理认证使用系统令牌 Bearer 与 New-API-User 数字 ID；不读取浏览器 Cookie，不在 URL query 传 Key。
- ProviderModelSummary 的价格支持显式 null，兼容增加价格状态/单位来源摘要；旧平台继续返回数值，Admin/CLI 全部消费点适配 null。未知不是零；运营仍可按明确的固定星尘档位发布，无自动重算收费。
- 新增一个非敏感托管 key `llm_relay_provider_config`：packy/onexmodel 的 quota_per_unit、每额度人民币比例、人民币/美元换算及来源/生效版本、原生额度低余额阈值、监控开关。不得包含地址、令牌、用户 ID。按 CONTRACT §3.4 完成 shared schema、admin-client configSchemas/menu、managed-key 数据库登记和 registry；运行读取只走 runtime-config。
- 不从 `$`、quota_display_type 或模型卡折扣推断实付成本。首次发布验证比例；缺换算时保留原生费用，USD 价格未知。配置缺失不阻断已配置调用 Key 的推理；探测可返回原生余额，但没有已发布阈值不触发低余额告警。

## 3. Admin / CLI / Frontend 数据流

ModelCatalogEditor 继续使用 provider:modelId、搜索、刷新、草稿和 CAS；不建立两套编辑器。新增策略 key 沿既有配置页面。发布 llm_model_catalog 后用户才看到新模型，刷新目录不直接更改正式模型。

增加受 Admin 鉴权保护的只读 `GET /api/admin/model-providers/:provider/balance`，仅允许两个新 provider。shared DTO 返回 provider、status、fetched_at、原生额度/单位、可选换算和稳定错误码，不返回账户身份或原始 JSON。模型管理页按需刷新；短缓存和 inflight 合并，响应 private/no-store，不复用公开目录路由返回账户数据。

目录/余额请求放 admin-client；Admin 原 openRouterModels helper 转发兼容。CLI 增加对应目录/余额只读命令、登记 coverage/README。配置写入继续 ctx.confirm，生产 diff/publish 规则不变。

Frontend 不直连供应商，既有 React Query/SSE 契约读取应用稳定 model ID；核对 provider enum、新平台收费/目录式免费模型、选中模型下架、重生成、旧配置和环境隔离，不无故改视觉。原三个平台、独立专用模型任务与 Surplus 候选池保持原逻辑。

## 4. 数据落位卡（不新增调用表）

### ops.llm_calls：O / 既有 active / 180 天

权威写入：generation 的 call-ledger、元数据 repository/RPC 与成本补查。读取：后台核对和 miniapp_analytics 调用/轮次成本视图。产品热路径不读 ops，外部看板不直读表。沿既有清理保留 180 天，跨域仅软引用，无业务表 FK 指向 ops。

复用 provider/model、generation_id/request_id、lane/role/slot、HTTP/结束状态、四类 tokens、耗时、cost_usd/cost_source、raw_usage。扩展 provider CHECK 和最终 metadata/交付函数白名单；不改历史 migration，不复活供应商独立表。

每次派发生成稳定 call_id：代表 attempt 保持 id=attempt_id，其他槽位也在派发时确定 ID，重复终态不新增行。原始信息缺失保持 null，不能用其他平台的数据填充。

最小新增候选真列：upstream_log_id（精确账单身份）、provider_account_ref（非敏感本地配置逻辑身份）、cost_native_amount、cost_native_unit、cost_usd_per_native_unit。实现金额 >=0、换算率 >0、字符串长度限制；如目标环境已有同语义列则复用。金额/单位用于聚合、身份用于认领，不能只放 JSON。provider_account_ref 不保存明文用户 ID/Key。

非空 (provider, provider_account_ref, upstream_log_id) 唯一，阻止同一供应商账单被认领给两次调用；同时保留 call/attempt 原有约束。raw_usage 增加 schema_version、usage、billing_detail（quota/单位/来源时间/换算版本/匹配结论），仅白名单元数据，<=32 KiB，剔除 token/IP/个人身份/请求正文；同步 registry.keys。

### ops.llm_cost_jobs：J / 既有 active / 跟随调用清理

复用 call_cost 任务，按 provider 分流，每 call 最多一任务；重试/租约/next_attempt 只放 jobs。新补查需要数据库领取/租约，不能仅靠进程内 running 防多副本；失去租约不提交。优先扩展已有领取方式，不改变 OpenRouter/Surplus 的原成本策略，不另建全账户日志或游标表。

### app_core.runtime_config + admin 配置过程：C

llm_relay_provider_config 登记坐标、schema、owner/reader 和版本；Admin 草稿/发布 RPC 唯一写，runtime-config 唯一读，沿既有配置历史生命周期。不向 frozen/moving 表加列，不替换无关 key 名单。

### miniapp_analytics 现有调用/轮次成本视图：D

识别新 provider/成本来源；沿已有权限、ACL/security_invoker 和列契约兼容扩展。未知 USD 不当真实零账单；原 unavailable 汇总兼容，保留未知数量可核对。旧平台历史金额不得重算。若外部 reader 需要新增列，先确认依赖并联动消费者。

涉及 experience.record*llm_call_metadata、select_chat_generation_delivery、read/list metadata 及目录发布 validator 的最终原文需核对再原地最小扩展；不得 \*\_before*\* 包装。若现有接口无法表达 ops 原子认领，只增加直接维护该不变量的最小 ops RPC，并在写 migration 前记录归属/读者/权限；service_role 最小授权，anon/authenticated 不可读原始观测。

## 5. 用量、费用证据与异步补查

从 SSE/非流式已收到的 usage/headers 捕获 request/generation ID、token 和确认过的实扣字段。败方仅记录取消前已收到事实，不为补齐 usage 继续 drain。cached/reasoning 是分项或子集，不能重复加入 prompt/completion。

费用优先级：经契约确认的响应实扣 → 唯一关联账单 → 明确标记目录估算。账单可条件升级估算；真实冲突停止覆盖并告警，不重复累加。美元值只有原生金额与确定转换依据齐全时写入，冻结换算/来源版本，不按最新目录或汇率重算旧记录。不得按账户余额差推单次成本。

管理 /api/log/self/ 使用 provider/account/Key 范围和固定时间窗，type=2 消费，退款/冲正单独识别。优先核实推理 ID 与账单 request_id 对应；不能精确匹配时 unavailable/ambiguous，不能凭时间和模型认领。无 request_id 查询参数时仅有界拉取后按已核实 ID 精确匹配。

每 call 最多 8 次、24 小时补查窗口；首次延迟 60 秒，退避抖动，429 尊重有界 Retry-After。每平台每轮 <=5 页、100 条/页，并发 <=2，响应 <=1 MiB。上限未扫完留待查，不标已完成，不扫描全历史。CAS 原子认领/升级，重复回放不覆盖其他 call。补查失败不影响回复、交付、固定报价结算或恢复。

台账写失败沿既有日志降级；不承诺进程崩溃时无损审计，利用已存在 attempt 与有限账单核验检查缺口。观测数据不能反过来决定用户收费，用户计费继续 billing.usage_charges / wallet_ledger。

## 6. 余额、容量与可靠性

账户余额读 /api/user/self，结合经验证 quota_per_unit 解释 quota，返回采集时间和单位。/api/usage/token/ 是 Key 限额诊断，不替代账户余额；坏 JSON/HTML/无 success/非法负值不是余额零。若上游合法支持负余额，核验后单独定义，不裁零。

目录沿 8 秒/15 分钟缓存；管理 GET 单次 5 秒、至多两次，仅网络/超时/5xx 退避。401/403/非法协议不重试；模型 POST 不新增网络重试，仍由原主发/兜底/共享截止控制。所有读取失败有稳定类别，配置发布保留 CAS，关键写保留原事务/幂等。

余额监控复用独立 payment-alert-monitor、既有轮次锁与 Publisher/outbox；四平台列表并发上限 2，验证最长轮次不超过现有周期。平台独立指纹，低余额去重、两次健康才恢复；无凭据/策略 skipped，失败 partial 且不 healthy。阈值按原生额度配置，不套 Venice 的 10 USD。新策略默认不自动开启、不在本次规划发送真实通知。

补查请求按账户合并并限页/并发，降低管理 API 和 DB 负载。新增高频/领取索引核对生产规模与 EXPLAIN，不能用小 TEST 样本替代；不做逐 token 写入或全历史扫描。

## 7. 日志与 Android/iOS 性能

复用现有 observed HTTP/fetch/job，覆盖目录、余额、usage/补查终态。字段仅 provider、model 安全摘要、状态/计数/耗时、call/request/trace 关联；不打印账号原始余额响应、账单、聊天、Key、系统令牌、管理用户 ID 或带查询的供应商 URL。错误 `{ err }` 经过安全投影；高基数 ID 不进指标/Sentry labels。告警默认关闭，既有 outbox 投递失败隔离。

管理查询/费用补查不进入首字热路径。受影响页面：聊天详情与模型选择。真实基线无可见样本。规划目标 Android/iOS 页面可交互 P95 各 <=2500 ms，模型配置 GET P95 <=1000 ms；发送至首有效正文仍按现有首字截止和真实上游时长另验，不把管理 API 或截图 latency 混入页面口径。发布前/后按系统、平台、版本和环境各取连续 24 小时样本并记录 N；低样本报告不足，不补零、不推测、不要求固定样本本地性能测试。

## 8. 演进、迁移、发布与恢复

1. 先只读核验账户协议，保存字段/类型/状态结论，不导出实际余额或日志行。远端库目标明确后只读核验最终结构/权限/账本。
2. 新增扩展 migration，守卫当前 provider/check/RPC 原文、owner/grants/视图。单文件内需原子部分放 DO，不依赖事务池跨语句状态；低 lock_timeout、有界 statement_timeout，索引和容量先核验。同步 registry/key，不修改历史 SQL。
3. 本地 PG17 非超级用户 → TEST 单文件验证 → 生产独立审批。顺序为兼容迁移 → Backend/worker/shared/CLI/Admin/Frontend → TEST 每平台一模型 → 受控发布目录。实际 secrets 只在目标环境配置，不入 IaC 源码。
4. 停止条件：平台/模型错配、账单重复认领、单位/换算不明、成本突变、重复扣款/交付异常、泄密、持续认证/防护失败或性能回退。保留旧平台和可回退正式配置。
5. 回退优先禁用新目录、发布旧配置、停止新补查/监控，保留调用/任务/金额证据。已有新 provider 历史后不收窄 CHECK/enum、不删扩展列；用兼容新值的版本回退或 forward-fix，不能重扣历史或删账单修报表。

## 9. 新增量与拒绝的过度设计

目标新增量：一个小型两平台管理 adapter、两个轻量平台目录注册、必要 usage mapper/补查和余额策略、一个非敏感托管 key、一个余额 HTTP 路由/CLI 读能力及最小扩展 migration。可按单文件500/函数120预算拆分职责，不预建多账户、任意插件、通用调度总线或全量账单镜像。所有新增公开面先定义 shared DTO，所有 Admin 专用功能同步 CLI。

## Implementation refinement (2026-11-24)

Reuse Prisma single-statement SKIP LOCKED claim and transaction/CAS completion instead of adding ops RPCs. Lease fields live only on ops.llm_cost_jobs; there is no new worker service. New pure function admin.validate_llm_relay_provider_config(jsonb) owns the C policy shape, is called by the existing single CASE dispatcher, follows config lifecycle/history, and has no business-row access. Backend policy and invoice readers are the runtime consumers. Repository source function baselines are recorded as MIGRATION evidence, not remote truth; unknown remote hashes stop migration. No wallet or billing amounts are changed by this expansion. Local UI tests/fixtures are excluded by user instruction.

## 2026-11-24 migration schema repair ? latest user authorization

User explicitly requested connecting Supabase and modifying the two original SQL files. This request supersedes the earlier immutable-file recovery proposal for these two files only. Initial failed-file SHA256 values remain in research/migration-original-checksums.json. No superseding third migration is used; historical unrelated migrations remain unchanged.

Supabase MCP branch metadata confirms TEST testdb, ref zoqelpfhurwehlvypryl, under ST_telegrambot. Catalog-only reads confirm analytics.llm_call_costs and analytics.llm_turn_costs, no old-name cost view, unchanged three-provider CHECKs and no relay expansion columns. Current model-core and managed-config function hashes differ from the repository fixture; five exact TEST source guards now protect the expansion, preserving first-token and chat_recovery_config logic. Production is not inspected.

Reuse the existing policy/column/index/function expansion and two-file order. Cost-view migration chooses canonical analytics, supports a known pre-rename layout without rebuilding old schemas, handles PG17 numeric/boolean deparser formats, and preserves OID/owner/grants/options/dependents. Both files reject absent views; expansion checks all function sources before DDL. No extra runtime table, API, state source or user-billing change.

Verify existing PG17.5 WASM harness in legacy/renamed/compat layouts, missing-view/source-drift refusal, replay, both relay model publications through actual TEST validator sources, unchanged first-token/recovery checks, native zero/unknown USD, invoice uniqueness and ACL/options. Real concurrent index/replica/capacity and remote execution remain pending. Existing migration workflow supplies audit/logging; no request-path or mobile performance change. Retain null real P95. Recovery remains additive/idempotent; stop on any unrecognized source hash or index/constraint failure. Run files through the single-file psql workflow, outside a whole-file transaction because of CONCURRENTLY.

### Current OneX Key modality correction

On the user-requested retry, the account group changed to nano-banana(x1); fresh authorized models are only gemini-3.1-flash-image-preview and gemini-3-pro-image-preview. Public metadata tags them for image generation while supported_endpoint_types still includes openai. This proves endpoint compatibility is insufficient to classify text-chat models. Extend the existing relay directory mapper to veto explicit non-text input/output, non-chat types and bounded known image/video/embedding/audio-generation model families before positive endpoint fallback. Keep vision input plus text output eligible; never auto-switch Key/group/model or add an image engine. Existing provider.directory.completed count/stale summaries cover this change; no new log field, database shape, shared DTO or mobile request-path I/O. Extend the approved existing directory regression with exact observed image IDs, contradictory metadata and text/vision preservation; rerun existing backend tests/typecheck and inspect fresh live directory. Revert only the predicate if it rejects a separately proven chat model; empty authorized chat directory is a valid safe state.
