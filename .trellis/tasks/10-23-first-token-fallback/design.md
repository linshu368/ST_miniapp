# 技术设计：固定首 token 兜底与观测

## 1. 设计目标与最小边界

在现有 generation 唯一出口内增加“至多两次尝试、一个交付来源、一次结算”的有限编排。模型目录仍是阈值权威源；chat_history/billing 仍拥有回复终态、正文、价格和扣款事实。新增请求/尝试记录承接真实调用过程，不另建生成框架、策略服务或分析快照系统。

## 2. 当前证据与复用

- shared `api/models.ts:62` 是严格 catalog schema，Admin `ModelCatalogEditor.tsx:125` 构造新型号；`configSchemas.ts:126` 是编辑中间态；必须同时扩展，防字段丢失。
- `platform/model-tiers.ts` 读取 runtime_config 与版本；复用现有草稿/发布/恢复，不新增第二配置表。
- `execute.ts:118` 创建单 chargeId，precheck/quota 复用；禁止重复调用 execute 充当兜底。
- `generate.ts:242` 目前首发前写旧 provider 占位，随后将首个 generationId 绑到该消息；需用持久化 attempt 意图替代这一阶段。
- `OpenRouterChatHistoryRepository.ts:30` 只允许首次填 generationId；OR/Venice 专表与 `20261016_chat_history_provider_metadata_views.sql` 均按每消息一个交付 provider 设计；这些排他校验保留。
- `upstream.ts:153-160` 已收到正文后会先等待 ID 持久化；需在该 I/O 前记录模型首 token，实际交付仍等身份确认。
- `use-conversation-turn.ts` 当前首 token Sentry 在 onDelta、仅 send；`AssistantReplyBody` 可见 DOM commit 是新的显示观测接缝。既有 API helper/SSE/parser/rAF 批处理复用。
- `admin.validate_model_catalog_core/prd` 最新声明在 `20260929_llm_model_catalog_multi_provider.sql`，新增 forward migration 对阈值作窄扩展，不改历史 SQL 或 managed-key 白名单。
  完整调研与拒绝方案见 research/reuse.md。

## 3. 配置与状态

新增内部 catalog 字段 `first_token_timeout_ms`：缺失默认4000；存在时必须为正整数，且小于当前全局首token上限（初始6000ms）；发布全局上限时同步校验所有型号，禁止配置使首发阈值等于或超过总预算。Admin以秒展示，转换后毫秒为整数；公开型号目录 omit 内部阈值。后端 ResolvedModel 带入冻结值与 catalog version。
首发阈值只计该调用派发到首个可交付内容 token，使用单调时钟；在请求剩余全局预算内运行。固定兜底使用现有 OpenRouter runtime config，重新构造 DeepSeek 请求与自己的 provider preferences，不继承首发 Claude cache_control/Venice 参数。首发本身即固定兜底时记录 `same_as_fallback` 并复用既有单调用路径。
交付状态：waiting_primary → delivering_primary 或 waiting_primary → delivering_fallback，不可切回；持久化交付选择和本地输出门都只能成功一次。
本期仅首 token 超时触发；首 token 前明确上游报错和首 token 后断流保留既有失败路径，不扩展错误重试。兜底无第二次型号切换。

## 3.1 全局首 token 预算（用户已确定：6000ms，1%目标）

保留现有110/120秒整轮保护，另建独立全局首token预算6000ms；用户提交起累计，primary/fallback共享，派发fallback时不重新计时。前端用同一performance.now计时并在首token可见后取消该timer；后端从route入口限制剩余等待，只有交付attempt的首内容发出后才停止服务端首tokentimer，后台primary观测不解除截止；两端观测分别保存，不能把服务端发出当成用户已看到。
到6000ms仍未看到token，前端温馨提示可重试并走既有request_id关联取消/确认；后端到预算无内容停止两attempt与无费收口。客户端断网/显示延迟与服务端完成竞态沿用既有持久化CAS，客户端观测不能单独授权退款或覆盖完成，需要对应浏览器回归。
全局6000ms、人工目标1%与每型号timeout分开，使用请求快照；未来AI只可评估型号阈值。扩展既有catalog根字段first_token_deadline_ms（默认6000）和first_token_timeout_rate_target（比例值默认0.01），通过既有受审计草稿/发布入口手动修改，不新建自动控制系统。deadline为正整数且不超过既有整轮上限，型号阈值必须小于deadline；rate范围为0..1，Admin以百分比展示。前台只获得执行计时必需的全局deadline与版本，目标比例与每型号内部阈值不混入前台型号展示。旧客户端兼容依赖后端限制且client缺报明确missing。
报表新增客户端确认的global_first_token_timeout、服务端无内容deadline、所用6000ms上限/1%目标快照、超时率及coverage。以独立请求为明确基数，主动取消/无回报单列，不能仅凭成功样本声称达标；不足覆盖时呈现数据不足。

## 4. 请求、交付、报价分离

1. 请求/计费身份：historyId、单chargeId、所选型号、原受理报价、VIP和免费权益受理后不变。
2. 尝试身份：attemptId、primary/fallback、实际平台/型号、上游ID，各自落表。
3. 交付身份：deliveryAttemptId 一次绑定，只有它可发delta、决定整轮终态、参与settle/sync。
   预检/免费额度预留只执行一次；请求和primary attempt意图在dispatch前持久化。阈值触发时预备fallback attempt并派发一次；可将该持久化选择与网络启动有界并行，但任何正文必须等选择确认，失败或结果未知立即停止输出且不重发POST。
   新增窄 RPC 在锁定仍生成且未取消的 parent revision 后，校验报价字段不变、选择attempt、绑定交付provider/model、仅建立该provider既有明细占位并投影已知generationId；这些步骤同事务。之前的首发ID只在attempt表，避免OR→OR换ID或Venice→OR双专表冲突。
   原快照的报价字段冻结；provider/provider_model_id明确为单次绑定的交付来源，所选原provider/model单独保存在request。历史快照按旧语义兼容读取。
   createHistoryWriter/settle/sync消费“冻结报价＋交付上下文”，不再用首发provider回写。账单保留所选型号和原价，实际交付型号使用新的明确metadata；不复用已有历史计费fallback_used字段。

## 5. 后台首发观测

交付选定兜底后，首发仅继续到首个内容token、明确错误、用户取消或当前请求起算110秒的既有deadline；若用户等待6秒到期仍未见交付token，立即取消两attempt。若兜底及时交付，首发后台观察可在独立上限内继续。独立定时器在用户回复收尾后仍有效；不依赖generate finally中会被清理的timer。
首发observer只写attempt，禁止触发onBeforeSettle、额度释放、业务done/error或provider账务专表。观察结束即取消/销毁自己的流，不生成完整回复；异常被捕获，不阻塞用户或污染兜底。
整轮取消/deadline停止所有attempt。观察停止与上游确认取消分别表示，不声称调用方abort等于厂商完全停止计费。进程中断保留未知，无生成POST自动重试。

## 6. 指标字典与计算

所有本地duration单位ms；绝对时间用timestamptz作归窗，不跨机器时间戳相减计算时长。

- `client_first_token_visible_ms`：同一performance.now从本次send/regenerate提交到首token进入可见回复DOM、经过绘制机会；首要体验指标。
- 同一客户端另记`client_request_dispatched_ms`、`client_first_token_received_ms`，从而直接得到提交至派发、首内容接收至显示两段耗时；这些仅诊断，不替代首要体验指标。
- `server_first_token_emitted_ms`：服务端接收到首次向客户端写出内容token，覆盖前置处理、模型串行等待和输出前持久化。与客户端同请求总等待对照时，只把差额称为传输/缓冲/客户端等残余，不断言全部是某一网络阶段。
- `server_pre_dispatch_ms`：服务端接收至首发派发；本地可测的鉴权/配置/历史/预检/持久化按阶段记录。
- `primary_wait_ms`：首发派发至选择首发，或至超时触发兜底；反映主阶段实际占用。
- `fallback_dispatch_delay_ms`：触发切换至兜底实际派发，暴露编排/数据库延迟。
- `fallback_first_token_ms`：兜底派发至首个内容token，精确观测才填写。
- `attempt_first_token_ms`：每次调用派发至实际首内容token；主模型即使被替代也可后来观测到；不得把该迟到值再加到用户总等待。
- `headers_ms`、`first_chunk_ms`、`first_content_observed_ms`、`identity_persist_ms`、`first_content_emitted_ms`：按实际接缝记录，用于区分网络响应、解析和持久化/输出延迟。
- `provider_latency`保留原值、单位、端点/来源及定义标记；确认同单位与口径才提供差值。沿用现有OpenRouter原字段，不能悄悄改原列含义。
- 工程残差：用户总等待减去已知串行模型等待与切换阶段，仅作聚合诊断，记录采样/测量口径；不伪装为精确的跨端网络分解。负差、时间异常标记invalid，不强制截成0掩盖。
  示例：首发阈值4s、后台实测首发9s、兜底派发后2s出token。模型串行等待约4+2s（另计切换和工程开销），不是9+2s。
  供应商定义差异也可能导致差值：OpenRouter官方activity说明提到latency可从首reasoning token计算，因此必须记录口径，差异是定位信号，不直接证明某个工程阶段有错。

## 7. 客户端可见性与回报

在runTurn接单创建request_id关联计时，贯穿start/delta/done与最终DOM，覆盖send/regenerate；短回复先done也不丢计时。
在AssistantReplyBody的稳定Markdown节点提交后检查实际可布局的首个文本token，不能把光标、加载点、原始Markdown控制片段当出现；经过绘制机会后取同一单调时钟。浏览器无法直接提供“人已经看到像素”的绝对证明，固定measurement_method=`visible_dom_after_frame_v1`，保留方法版本。
document隐藏/离屏单独标记；回来后记录实际显示耗时并分组，前台可比样本不能混入后台节流样本。无回报=missing；明确未显示=not_observed；二者duration均NULL。
Shared新增first-token回报DTO，经现有lib/api helper提交与Telegram鉴权，Backend校验用户、session、historyId/requestId/revision，服务端补型号/阈值/版本；客户端不能写这些权威维度。相同payload幂等、冲突不覆盖首次有效值；有界请求和有限幂等重试，不阻塞聊天。该数据只用于观测，不参与收费授权。

## 8. 数据对象归属（八域）

### experience.chat_generation_requests（建议名）

核心对话生成处理与交付身份，chat_history_id一对一FK/PK，客户端request_id另设唯一约束。Backend generation权威写入；存所选型号/映射/版本/阈值、服务端接收、兜底触发、deliveryAttempt、业务阶段时间和客户端观测。正文、用户输入、账务终态/金额继续由原表拥有，不复制第二套可写事实。

### experience.chat_generation_attempts

request FK一对多、UUID主键、UNIQUE(request,role)限制至多primary/fallback，provider/model/generationId、观测时间/结果/允许的厂商统计。Backend唯一写入，身份不可改绑；通过delivery选择由运行时读取，属experience而非仅看数表。无正文、prompt、凭据或自由错误JSON。

### miniapp_analytics 请求投影与显式窗口聚合

只用于人工/Grafana/以后AI读取的派生视图/聚合函数，不是线上配置来源。先请求去重后关联attempt；不建每日快照表、AI任务或cron。

### 配置、审计与账务

配置仍app_core.runtime_config；草稿/发布/审计仍admin；扣费/额度事实仍billing。新增事务RPC维护experience交付身份并按现有契约更新快照/provider占位；依赖方向experience→existing parent/provider，analytics→experience。
新表随revision生命周期，parent删除CASCADE；保留历史，应用回退不DROP。根据实际查询只建窗口/型号与request-role必要索引，避免为每个维度建索引；增长约每请求1条request＋1~2条attempt。数据保留/归档不做不可逆默认清理。
启用RLS、撤销PUBLIC/anon/authenticated直读写，service_role最小权限；窄RPC默认invoker/固定search_path，确需definer时明确所有者与REVOKE/GRANT。Grafana只读聚合/必要无个人标识列，沿用已有reader映射前先核对目标环境，不能给所有authenticated开放。跨schema FK、函数、ACL和security_invoker在SQL回归逐项验证。

## 9. 24h 人工报表

显式传入带时区from/to，server request_received_at ∈ [from,to)；可按北京时间每日固定时点查过去24h。独立已发起generation请求计数，send/regenerate各是一个真实请求；预检拒绝单列。
150资格按稳定型号总请求数计算，再按catalog version/provider/slug/实际阈值分组；两attempt不倍增计数。返回report_version和窗口边界。
主输出：请求数、primary/fallback选择数、fallback启动率/选择率/用户确认首token比例及明确分母；客户端总等待总体/两交付来源P50/P90/P95、每组样本数与coverage；primary_wait、切换delay、fallback_ttft、工程残差；每attempt精确TTFT与被替代首发后来TTFT；provider_latency对照；失败/取消/无token/缺报/删失/unknown数。
导出SQL与可导入Grafana JSON（数据源占位符，秒/%双轴或同时间轴面板）；不直接改现有生产数据源/看板。不平均小时P95当每日P95，不把NULL补0。

## 10. 可靠性与故障模型

- 超时：全局首token截止为6000ms，前置准备也受剩余预算约束，不再允许20秒准备预算先耗完才开始首token计时；两次网络、数据库写入、客户端回报均有界；后台观察独立deadline且不延长当前请求预算。
- 重试：生成POST不重试；事实写入/幂等回报可有限重试并读回结果。交付选择的结果未知时失败关闭并释放原额度；不重发上游，不在剩余首token预算外尝试救回交付。
- 幂等并发：一轮一chargeId、request-role唯一、选择CAS/事务、ID首次绑定、一次结算promise与既有取消CAS共同保证；阈值边界与用户取消必须回归。
- 事务：只覆盖交付选择、报价不变量、provider投影的最小写集，禁止把外部HTTP放事务。
- 降级：迁移未就绪不能悄悄启用不完整观测；发布前能力校验失败停止新功能启用。非关键客户端观测回报失败不影响回复，missing与错误日志可见。
- 补偿/恢复：复用原chargeId和额度释放；观察attempt不进账务恢复；进程失联标unknown，不伪造实际TTFT/厂商取消/用户显示。
- 容量：每请求最多两个调用，首发观察有界，丢弃其正文，不建无界队列/累计reasoning；异步错误有日志，client回报限字段/大小/身份。
- 可观测：pino记录request/history/attempt、模型、阶段、结果与耗时；不记录token、prompt、正文或敏感URL。

## 11. 演进、发布与恢复

全部为additive forward migration；唯一源packages/shared/migrations，历史迁移不改。先本地隔离PG/PostgREST验证，再TEST workflow单文件迁移，后Backend，最后Frontend/Admin；上线后模型目录仍可回退旧发布（缺字段按4s）。应用回退保留新事实，不DROP新表。旧客户端缺指标明确missing。
本轮不执行远端迁移/部署。当前MCP缺仓库TEST ref；本机缺原生pg_config，已通过一次性PG17容器完成真实SQL/权限/计费/台账回归；真实远端验收仍未执行。实现时可补齐隔离运行依赖（优先本地临时容器/现有harness）再真实跑SQL，不连接生产代替。未知依赖/身份冲突/取消覆盖/重复扣费/数据显示伪造均为停止条件。

## 12. 验证与审阅

全局上限6秒、型号默认4秒意味着兜底可用时间需减去前置/切换/显示开销；记录真实分段，不因1%目标自动延长上限。
见implement.md/task.md。高风险点为计费、跨provider交付、取消、观测删失和SQL权限；复用既有测试并补必要回归，必要的新SQL/DOM回归文件在此风险评估中明确认可。用户已批准并完成本地实现；最终行为与验证以 verification.md 和运行说明为准。

## 参考

- https://openrouter.ai/docs/api/api-reference/generations/get-generation
- https://openrouter.ai/blog/announcements/better-insights-faster-metrics-and-new-developer-power-tools/
- https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
- https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame

## 2026-10-23 追加设计：集中配置

复用 llm_model_catalog 单一事实源、App configEditorCard、供应商目录以及既有草稿/发布/历史；新增侧栏“兜底配置”与受控专题表单，不增加配置key、API、secret或状态源。根字段 fallback_model_id 默认现有型号并验证 OpenRouter ID。型号目录去除重复等待控件，新增型号继续默认4秒。

每轮冻结 fallbackModelId，helper不再使用写死型号；同型号不重复调用。既有 experience 请求表已有 fallback_model_id；后续迁移原位替换 admin validator、experience begin/prepare，begin写冻结值，prepare读本轮记录；函数签名、权限、终态锁与单次结算不变。miniapp_analytics facts末尾增加该字段，report同型号按其分组。所有对象保留原业务归属/权威方/生命周期，不新增表或索引。

可靠性复用现有超时、CAS/锁、发布审计与错误反馈；不增加重试/队列。迁移仅本地隔离验证，先TEST迁移再应用，应用部署前不能发布新型号。回滚先发布旧默认型号再回退应用，保留事实数据。验证仅扩展既有契约/路由/SQL/导航测试，执行受影响测试、跨包typecheck、Admin构建及界面检查。
