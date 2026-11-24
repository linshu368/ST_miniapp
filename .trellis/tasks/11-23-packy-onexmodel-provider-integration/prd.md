> 2026-11-24: Implementation authorized by user. Reuse existing Venice/OpenRouter adapter entry points. Skip local UI tests/fixtures. Historical planning-only statements below describe the prior phase. Local OneX endpoint/proxy repair authorized by subsequent diagnostic request; No remote migration, publication or deployment; later user request authorizes controlled provider-generation verification.

# PackyAPI 与 OneXModel 多平台接入

## 目标与用户价值

复用现有平台适配，在 Admin 获取、选择和配置 PackyAPI / OneXModel 文本模型；经草稿发布后，Frontend 和 Backend 按已发布的平台调用。每次上游调用记录 tokens、费用与来源，并支持账户余额探测。

本次只创建规划任务，不写产品代码、不启动实施、不执行迁移、不发布配置、不部署、不发起付费模型调用。

## 已确认事实与决定

- 现有平台为 OpenRouter、Venice、Surplus，统一注册、目录、调用、结算与恢复入口见 research.md。
- 本地 Backend 环境文件已有两平台的调用 Key/地址、管理地址/系统令牌/用户 ID 对应变量；只记录变量名，不复制值。
- 用户于 2026-11-23 明确确认统一到 `ops.llm_calls`，用 provider 区分，不建供应商独立调用表。
- provider 标识为 `packy`、`onexmodel`；保持应用稳定模型 ID、既有用户收费规则和 legacy 字段兼容。
- 范围为文字聊天、角色扮演的发送/重生成、现有收费档位与目录式免费模型。Surplus 候选池、图片、视频、语音及独立专用模型任务不自动切换平台。

## 需求

### R1：配置、凭证与隔离

Backend 分别读取调用与管理凭证；模型调用使用调用 Key，账户余额/日志使用系统访问令牌与数字用户 ID。沿用服务端配置入口与环境隔离，Admin/Frontend 不持有供应商凭证。兼容数字开头的 `1XM_*` 和现有 `SECRET_USERT_ID` 拼写，不修改实际环境文件。缺少管理凭证不影响已有调用凭证的推理，但明确显示探测/补查不可用。

### R2：Admin 模型配置与发布

两平台进入既有模型编辑器，支持独立刷新、筛选、加载/空态/错误/stale、模型选择及现有显示名、介绍、排序、启用、档位和超时配置。模型可用范围以配置 Key 的授权列表为准，公开全站价格表不能当调用授权。复用草稿、差异、CAS 发布、历史与回滚；未发布内容不影响用户，价格未知不伪装为免费，目录刷新不改星尘收费。CLI 与 Admin 契约一致。

### R3：发布到实际调用闭环

Frontend 经现有 React Query hooks 读取正式配置，Backend 按 provider + provider_model_id 选择地址和 Key。支持既有 SSE/非流式、思考开关、采样/输出上限、取消、断流、首字截止、交付仲裁、兜底及恢复语义。不向两家透传 OpenRouter/Venice 专有参数，不自行替换成未经发布的模型；原三个平台行为兼容。

### R4：统一调用记录与费用

每次实际派发在 ops.llm_calls 仅一行，覆盖成功、失败、取消、首字超时、竞速落败与兜底。记录平台/模型、call/attempt/轮次身份、上游 ID、HTTP/结束状态、输入/输出/缓存/思考 tokens、耗时、成本及来源。未知 token/成本保留未知，不能伪造零。原始用量只保留脱敏、白名单和有界快照，不含密钥或完整聊天正文。

平台额度、人民币、真实美元必须区分；账单实扣与目录估算有不同来源，缺汇率不能生成美元成本。供应商成本只用于观测，不能改变用户星尘扣款。

### R5：费用异步补查

复用 ops.llm_cost_jobs，对不完整响应做有界管理日志补查。使用可靠上游请求 ID 且核验账户/Key/模型范围，不能按时间/模型相近强行认领。账单重复、迟到、歧义、无权限或无 ID 有明确状态；限次限窗结束，不无限轮询，不使用其他平台的价格补值。

### R6：余额探测

提供受控 Admin 账户余额只读查询和既有后台监控接入。结果包含单位、采集时间和成功/未配置/失败状态；账户余额与 Key 限额分开。低余额复用 Publisher/outbox 去重及连续健康恢复；失败不能记余额零或发布 healthy。单平台故障不影响其他供应商或支付监控。

## 验收标准

- A1（R1/R2）：独立刷新/选模/保存/差异/发布/回滚；同名上游模型不串平台；环境切换忽略迟到响应；缺凭证、无模型、401/403、429、5xx、超时、HTML 防护、坏 JSON 有明确状态。
- A2（R3）：TEST 分别发布一个两平台文本模型，从 Frontend 发送/重生成，核验实际派发、SSE 与一次用户结算；覆盖草稿不生效、下架、旧配置/客户端和原兜底。
- A3（R4/R5）：赢家、败方、失败各有唯一调用事实；验证 usage 缺失/合法零值/缓存思考子集、重复终态、进程重启、账单重复/迟到/歧义、补查失败和币种快照。账单实扣和估算可区分。
- A4（R4）：调用/每轮成本消费者识别新 provider；旧平台历史金额与用户按日扣款对账不变；记录故障不改变回复/交付/扣款。
- A5（R6）：真实余额查询、零与失败区分、低余额去重、两次健康恢复、失败不恢复、跨平台故障隔离及 worker 配置均可验证。
- A6：shared runtime 校验与 CLI coverage 完成；迁移本地 PG17 → TEST → 生产逐文件核验 shape、RLS/grant、锁和恢复，生产操作独立授权。
- A7：执行受影响包 typecheck、已有相关测试及适用 lint/build；新回归文件按本规划的计费/并发/契约/迁移风险评审范围批准后创建，真实调用计费不能由 mock 替代。
- A8：日志与 Android/iOS/API P95 声明通过结构门禁，无基线保持 null；建议平台切换、选模、断流/重生成和下架进入既有 @chat/@roleplay 本地验收。

## 范围外与技术核验边界

不新增平台充值/账户管理、自动充值、通用插件框架、全账户日志镜像、独立日志库或 Admin 账单浏览页面；本任务保证记录、补查和现有分析消费。不改变 Surplus 候选算法、原平台失败恢复或专用模型任务。

实施首步需用配置账户只读核验目录/余额/日志权限、ID 关联、单位、分页与限流；当前公开说明和无认证探测不是账户级成功证据。尚无 Android/iOS 真实样本，不宣称性能/调用质量已验证。验证、停止和恢复见 design.md / implement.md。
