# Admin 模型目录支持 Surplus 平台

## Goal

让运营人员能在现有 Admin 模型目录中同步、查看并选择 Surplus 的文本模型；发布后的模型配置可由统一生成链路调用 Surplus。

## Requirements

- 使用现有 `SURPLUS_API_BASE_URL` 与 `SURPLUS_API_KEY` 调用 Surplus Intelligence 官方 `GET /payments/balance`，并以微美元整数字符串 `credit_balance_usdc` 作为可消费余额；不得新增或暴露浏览器端凭据。
- 复用现有 Venice 余额规则：USD 余额严格低于 $10 时发布 generation 域 P1 告警，连续两轮恢复后发布 healthy。
- 探针超时、网络错误、5xx、鉴权失败或响应不合法时不得误报恢复，也不得阻塞支付告警、Venice 余额检查和 outbox 投递。
- 将检查注册到现有 `stminiapp-payment-alert-monitor` 常驻 Cron/Worker；不新增 Railway 服务或数据库对象。
- Railway IaC 只通过服务变量引用传递 Surplus 地址和密钥，不写入真实 secret；本任务不执行 plan/apply 或生产部署。

- Surplus 作为与 OpenRouter、Venice 并列的模型平台出现在 Admin 模型目录页面。
- 模型目录从后端读取，浏览器不得接触供应商密钥。
- 后端只从 `SURPLUS_API_BASE_URL` 和 `SURPLUS_API_KEY` 读取 Surplus 地址和凭据，不新增前端环境变量或硬编码密钥。
- 复用现有 OpenAI-compatible `/models` 与 `/chat/completions` 契约、目录缓存、固定档位计费和可观测链路。
- 保持现有 OpenRouter、Venice 目录、生成、兜底与配置兼容行为不变。
- 外部目录请求必须有明确超时、同一刷新合并、短期缓存和陈旧缓存降级；不得对未知写操作自动重试。
- Surplus 不参与 OpenRouter 专属 provider routing、generation metadata 查询或 Venice 专属参数。

## Acceptance Criteria

- [ ] Surplus 余额低于 $10 时生成 `surplus-balance-low` P1 evaluation，fingerprint 包含 `:generation:surplus:balance_low`。
- [ ] 余额恢复必须连续通过两轮；任何探针失败都不发布 healthy。
- [ ] 余额探针具有 5 秒超时、最多两次安全重试和有界退避，且日志不包含 key、账户 ID 或原始响应。
- [ ] 现有告警 Worker 每轮独立执行 Venice 与 Surplus；任一供应商失败仅把该轮标为 partial。
- [ ] Railway alert-monitor worker 能引用 `SURPLUS_API_BASE_URL`、`SURPLUS_API_KEY`，并保持现有 Venice 变量可用。

- [ ] Admin 自动加载 Surplus 目录，并可手动刷新、搜索和选择 Surplus 模型。
- [ ] 共享模型配置接受 `provider: "surplus"`，且仍按 provider 隔离模型 ID 冲突。
- [ ] Surplus Intelligence `/models` 响应被严格、容错地映射为现有 `ProviderModelDirectory`；无有效文本模型时明确失败。
- [ ] Surplus 生成请求使用 `${SURPLUS_API_BASE_URL}/chat/completions` 和 `Authorization: Bearer ${SURPLUS_API_KEY}`，不携带 OpenRouter/Venice 专属字段或请求头。
- [ ] 告警与工程指标保留 `surplus` provider 标签，不误归类为 OpenRouter。
- [ ] 固定档位扣费失败时可从冻结快照恢复 Surplus 结算，不依赖新增 provider 元数据表。
- [ ] 现有 shared/backend/admin 测试通过，受影响包 typecheck、lint、build 与复杂度检查通过。
- [ ] 环境变量文档列出 `SURPLUS_API_BASE_URL`、`SURPLUS_API_KEY`，并说明只在后端配置。

## Android/iOS 性能 P95 门禁

- 受影响页面：无移动端页面；仅内部 Admin 模型目录。
- 受影响接口：Admin 的 provider directory 读取，以及运营选择 Surplus 后的既有聊天生成上游；未改变移动端 API 契约。
- Android 页面加载 P95：不适用。
- iOS 页面加载 P95：不适用。
- 接口 P95：本任务不建立虚构基线；上线选择具体 Surplus 模型后按 provider/model 观测生成耗时。
- 数据来源与观测窗口：发布后沿用现有 OTLP/Grafana provider/model 指标，按发布版本与模型观察至少 24 小时。
- 说明：`task.json.meta.mobile_performance.mode` 为 `not_applicable`，原因是本任务不改变移动端页面加载或前台读取接口。
