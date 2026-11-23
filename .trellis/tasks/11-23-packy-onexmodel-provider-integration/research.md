# 调研证据与复用清单

日期：2026-11-23。REPO 为源码；DOC 为公开说明；GAP 为未验证。未连接远端数据库、读取业务行、使用账户凭证请求余额/日志或调用付费模型。

## 环境变量

只检查 `packages/backend/.env` 左侧变量名，未输出值。

- Packy：PACKY_API_KEY、PACKY_API_BASE_URL、PACKY_API_SECRET_BASE、PACKY_API_SECRET_KEY、PACKY_API_SECRET_USERT_ID。
- OneXModel：1XM_API_KEY、1XM_API_BASE_URL、1XM_API_SECRET_BASE、1XM_API_SECRET_KEY、1XM_API_SECRET_USERT_ID。

数字开头的 1XM\_\* 需要字典读取并验证 loader/部署兼容；USERT_ID 为现有原名，不擅自更改。不在文档或日志保存 Key、用户 ID、URL 配置值。

## REPO：复用/扩展

- `packages/shared/src/api/model-providers.ts:3`：三个旧 provider 与 capability registry，扩展而非另建框架。
- `packages/shared/src/api/model-catalog.ts`：provider + provider_model_id、稳定应用 ID 与 legacy openrouter_model_id；免费目录排除 Surplus，新平台消费者也要验证。
- `packages/shared/src/api/models.ts:60`：目录价格当前强制数字；新平台 /models 未必带价格，需支持显式未知并更新所有消费者，不能补零。
- `packages/backend/src/platform/runtime-config.ts:132`、`platform/config.ts`：平台/环境配置所有者；新增管理配置保持服务端边界。
- `platform/model-provider-directory.ts`：8 秒超时、15 分钟缓存、single-flight、stale 降级。封闭 provider record 需扩展；超长文件先拆分，不继续追加超预算。
- `packages/backend/src/routes/models.ts:122`：现有 `/api/platform/model-providers/:provider/models` 非 Admin 专用，复用安全目录 DTO，不返回管理数据。
- `packages/admin/src/components/ModelCatalogEditor.tsx:87`：组合身份 provider:modelId、现有编辑器和发布交互可复用。
- `packages/admin/src/lib/openRouterModels.ts:33`：通用 fetchModelProviderDirectory 目前仍是 Admin helper；新增 CLI 共用请求收敛到 admin-client，原 helper 转发兼容。
- `packages/admin-client/src/configSchemas.ts` / `menu.ts`、`packages/admin-cli/src/coverage.ts`：配置、菜单、CLI 覆盖所有者。
- `features/generation/{generation-prepare,generation-body,generation-dispatch,first-token-fallback,generation-stream,generation-nonstream}.ts`：共用 OpenAI-compatible transport、请求参数及单赢家交付；不套 Surplus 专用协议。
- `features/generation/settle.ts:257`：仅 Venice 有同步 metadata 分支，新平台不因加 registry 自动落完整费用。
- `features/generation/call-ledger.ts:29`：每调用一行，attempt/并发槽位现成约定；扩展稳定 call ID 和所有终态的 token 捕获。
- `features/generation/call-costs.ts` / `call-cost-rules.ts`：事后补查仅 OpenRouter 查 generation，未知平台最终 unavailable；需明确两平台分支，不借用 OpenRouter 价格。
- `infrastructure/repositories/LlmCallRepository.ts:35`：metadata RPC 当前只补空；`fixed-provider-recovery.ts` 可复用非 OpenRouter 固定报价恢复。
- `features/generation/provider-balance-monitor-round.ts`、`venice-balance-alerts.ts`、`surplus-balance-alerts.ts`：5 秒探测、有限重试、Publisher/outbox、两次健康、失败隔离；扩展受限列表，不复制四套策略。
- `src/scripts/payment-alert-monitor.ts`、`.railway/railway.ts:220`：现有 worker/IaC，扩展所需环境引用，不实际部署。
- `packages/ui-tests/README.md`：复用 @chat/@roleplay、chat-slow/chat-error/no-balance fixture，不另建临时验收后端。

## REPO：数据库与函数

- `docs/db/CONTRACT.md` §2–4/§7：统一 ops.llm_calls/llm_cost_jobs；产品请求不读 ops；外部看板只读 miniapp_analytics。
- `docs/db/registry.yaml:706`：calls 为 active/O、保留 180 天，raw_usage 键需登记。用户已确认统一复用。
- `packages/shared/migrations/20261119_db_reorg_p6a2c1_llm_calls_expand.sql:26`：provider CHECK 只有三个旧平台；metadata RPC 也有平台限制。
- `20261119_db_reorg_p6a2c3_call_ledger_expand.sql:119,187`：交付相关逻辑仍有三个 provider 白名单；不能只改 TS enum。
- 检索对象：experience.select_chat_generation_delivery、record_llm_call_metadata、read_llm_call_metadata、list_llm_call_metadata_gaps；calls/cost_jobs；miniapp_analytics.llm_call_costs/llm_turn_costs/grafana_core_daily 及刷新函数；generation attempts、冻结 billing snapshot、目录发布 validator。
- 不复用已退役的独立供应商明细表；不回放旧迁移覆盖现行钱包/交付逻辑。源码与 migration 只证明本地声明，不证明 TEST/生产实况。

## DOC 与 GAP

- [Packy 用量查询](https://docs.packyapi.ai/docs/ccswitch/4-usage-query.html)：系统访问令牌 + 数字用户 ID，管理地址与推理地址分离。
- [Packy 充值口径](https://docs.packyapi.com/docs/register/3-quota.html)：人民币与站内美元额度当前说明 1:1，不是真实 USD/CNY 汇率，不再重复乘模型卡折扣。
- [OneXModel API](https://1xm.ai/docs/api/overview.html)：GET /v1/models；[计费说明](https://1xm.ai/docs/guide/pricing.html)：基础价、倍率与平台额度不同。
- 本会话两家公开 /api/pricing 均读取成功；/api/status 当前 quota_per_unit=500000。仅为采集时公开配置，不硬编码成永恒协议。
- 两家线上控制台使用 /api/user/self、/api/log/self/、/api/log/self/stat；用户 ID 头为 New-API-User。日志筛选 p/page_size、秒级时间、model_name/token_name/group/type。
- OneXModel 控制台有 request_id 筛选；Packy helper 的通用参数不证明同 ID 可精确对账。
- /api/usage/token/ 查询 Key 额度，不能替代账户余额。旧 /api/log/token 认证版本不一致，本任务不采用 URL 携带 Key 的接口。
- GAP：实际账户权限、推理 ID 与日志 ID 对应、quota/费用/退款单位、缓存/思考字段、分页/限流/延迟/保留和分组定价需只读核验。
- GAP：Packy 部分无认证管理请求返回 403 HTML；要区分防护和 JSON 认证错误，不用浏览器绕过或盲重试。

## 拒绝的方案

不建供应商调用表、原始账单镜像或另一成本事实源；不按余额差推单次费用；不按模型/时间相近认领并发账单；不把思考/缓存子集重复加入总 tokens；不拿最新目录价倒算历史实扣；不改无关平台策略。
