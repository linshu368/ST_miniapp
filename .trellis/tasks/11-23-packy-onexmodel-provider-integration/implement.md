> 2026-11-24: Implementation authorized by user. Reuse existing Venice/OpenRouter adapter entry points. Skip local UI tests/fixtures. Historical planning-only statements below describe the prior phase. Local OneX endpoint/proxy repair authorized by subsequent diagnostic request; No remote migration, publication or deployment; later user request authorizes controlled provider-generation verification.

# 实施、风险验证与交付计划

本次仅规划；以下均未执行。最新规划经审阅并获得后续实施授权后再进入 in_progress。不得自动提交、推送、远端迁移或生产发布。

## 执行顺序

1. 只读核验两组配置完整性、1XM/USERT_ID 兼容；调用 Key 查 /models，管理凭证查 user/self 和窄窗日志。只记录字段类型/权限/单位/ID 关系，不输出配置值、实际余额或日志行。不发起付费生成；契约失败保留 GAP，不能伪报成功。
2. 明确 TEST/生产目标后采集最终 DB CHECK/RPC/index/RLS/ACL/validator/账本，核对现有全部 provider 列表，准备最小扩展 SQL。
3. 扩展 shared registry、未知价格、余额 DTO 和 llm_relay_provider_config；先完成 producer/consumer 兼容设计，再实施 handler/客户端。环境解析集中在 config/runtime-config。
4. 新 migration 扩展统一 calls、jobs 幂等/领取、provider 白名单、相关 RPC/分析 consumer、managed config 登记；同步 registry。禁止新建供应商表或覆盖无关钱包/配置函数。
5. 目录 adapter 接入 cache/single-flight/stale、Key 授权交集/文本能力与价格未知；过长文件先拆分。
6. Admin 模型/策略配置与余额按需展示；目录/余额请求进 admin-client；CLI 只读命令/coverage/README 同步。验证草稿、CAS、发布、回滚、环境迟到响应。
7. generation 共用 transport/stream/nonstream，按平台能力过滤参数；Frontend 正式目录发送/重生成，原收费与兜底不变。
8. 稳定派发 call_id、全部终态 usage/金额原始单位捕获、统一 metadata 与 fixed-provider-recovery；日志失败不影响用户结果。
9. jobs 补查：数据库 claim/lease、精确唯一账单匹配、最多8次/24小时、分页/并发上限、真实升级估算、冲突/不可获取状态。
10. 账户余额 Admin 查询和已有 worker 探测，原生阈值、低余额去重/两次恢复、失败隔离；只准备 IaC 引用不 apply。
11. 执行自动/人工/迁移/性能验证，补齐 README/ARCHITECTURE/spec/CLI 和 module-updates；最终审阅后再进入单独发布流程。

## 风险与测试文件评估

涉及跨包契约、币种、幂等认领和数据库约束，需自动回归锁定；优先扩展既有文件，不自动为普通 UI 新建测试。若既有文件无法承载，经本规划风险审阅后批准最少的 relay protocol/metadata 回归文件和 PG17 迁移脚本。实现阶段按实际变更确认，不能只测 happy path。

优先复用 shared provider/model tests；backend model-provider-directory、resolve-model、first-token-fallback、execute、stream/nonstream、metadata、call-cost-rules、chat-history-sync、balance-monitor-round；admin ModelCatalogEditor；admin-client/CLI coverage。DB 用非 superuser PG17 验证 shape 拒绝、幂等/重放、事务回滚、重复账单并发认领、租约过期、RLS/ACL与旧平台不变量；修改前后做按日钱包对账。

## 可执行命令

实施阶段先核对 package scripts，缺失命令记录原因，不能虚报通过。

```bash
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/admin-client test
pnpm --filter @miniapp/admin-cli test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm lint:imports
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/backend logging:validate
pnpm lint:migrations
pnpm lint:db-contract
pnpm --filter @miniapp/admin build
pnpm --filter @miniapp/frontend build
pnpm -r --if-present build
git diff --check
```

Backend 无传统 dist build，以 typecheck/现有启动装配检查验证；不为验证启动生产服务。拆分基线超标实现后运行 `node scripts/complexity-budget.mjs update` 收紧，不放宽预算。

## 失败路径与 consumer 矩阵

- 目录：缺凭证/分组错、空数组、模态不明、未知价格、坏 JSON、超大响应、403 HTML、429/5xx/超时、并发刷新和 stale 保留。
- 调用：认证/欠费、首字前错误、流中错误、无 DONE/usage、reasoning-only、合法0 token、cached/reasoning子集、停止/离页、竞速败方和兜底，不重复 POST。
- 费用：平台额度/CNY/USD区别、缺汇率/换算版本变化、按次/阶梯价未明、真零实扣、退款、迟到/重复/歧义/无ID、响应账单冲突、估算升级、跨平台同request ID，不能按余额差猜成本。
- DB/job：重复终态、台账故障、claim并发、重启/租约失效、锁超时、补查次数/分页上限和积压；无逐token写入/热路径ops读取。
- 余额：真零与失败、缺凭证/策略、负值/非法值、缓存迟到、低余额重复轮次、一次健康不恢复、两次才恢复、失败不healthy、单平台故障隔离与轮次总时长。
- 安全/消费者：Admin鉴权401/403、非Admin不见账户、旧enum/legacy配置、目录式免费模型、所有price=null消费者、环境切换、CLI覆盖；secret不入浏览器bundle/URL/日志/DTO。

## 人工端到端与本地验收

TEST 分别配置一个平台文本模型：刷新目录→编辑→草稿→diff→发布→Frontend选模→发送/重生成→SSE→实际派发平台核验→call/attempt/账单唯一关联→原生费用与USD折算→一次扣费→余额手动/worker查询。失败/兜底后检查每次上游调用事实，不只看赢家。真实付费调用在明确验收窗口执行，本次规划不调用。

建议纳入现有本地验收：扩展 @chat/@roleplay 选模、chat-slow/chat-error/no-balance fixture，覆盖发布/下架后的模型选择、新平台重生成/失败恢复。复用 `pnpm test:ui --grep @chat` / `pnpm test:ui --grep @roleplay`，不另建临时mock服务。fixture不覆盖真实模型身份、供应商权限/计费、Telegram系统键盘和真实P95。

性能按 task.json 分Android/iOS/平台/环境/版本分别记录窗口、N、P95；无样本null。检查出字前无目录/管理I/O，遵守原首字截止；不运行固定样本本地性能门禁。发布前后各连续24小时观察，低样本写不足，不宣布通过。

## 发布与恢复

顺序/停止/回退见 design §8。本地 PG17 → TEST 单文件迁移验证后，生产迁移另取明确授权；生产运营写入必须 admin CLI whoami/get/draft/diff，展示差异并获当次同意后 publish/get。部署不自动执行迁移，不能把本地 .env 当 Railway 已配置证据。旧配置禁用新平台为首选回退，保留扩展schema和历史调用记录；不回退到不识别新provider的版本。

## 2026-11-24 migration schema repair ? latest user authorization

User explicitly requested connecting Supabase and modifying the two original SQL files. This request supersedes the earlier immutable-file recovery proposal for these two files only. Initial failed-file SHA256 values remain in research/migration-original-checksums.json. No superseding third migration is used; historical unrelated migrations remain unchanged.

Supabase MCP branch metadata confirms TEST testdb, ref zoqelpfhurwehlvypryl, under ST_telegrambot. Catalog-only reads confirm analytics.llm_call_costs and analytics.llm_turn_costs, no old-name cost view, unchanged three-provider CHECKs and no relay expansion columns. Current model-core and managed-config function hashes differ from the repository fixture; five exact TEST source guards now protect the expansion, preserving first-token and chat_recovery_config logic. Production is not inspected.

Reuse the existing policy/column/index/function expansion and two-file order. Cost-view migration chooses canonical analytics, supports a known pre-rename layout without rebuilding old schemas, handles PG17 numeric/boolean deparser formats, and preserves OID/owner/grants/options/dependents. Both files reject absent views; expansion checks all function sources before DDL. No extra runtime table, API, state source or user-billing change.

Verify existing PG17.5 WASM harness in legacy/renamed/compat layouts, missing-view/source-drift refusal, replay, both relay model publications through actual TEST validator sources, unchanged first-token/recovery checks, native zero/unknown USD, invoice uniqueness and ACL/options. Real concurrent index/replica/capacity and remote execution remain pending. Existing migration workflow supplies audit/logging; no request-path or mobile performance change. Retain null real P95. Recovery remains additive/idempotent; stop on any unrecognized source hash or index/constraint failure. Run files through the single-file psql workflow, outside a whole-file transaction because of CONCURRENTLY.

### Current OneX Key modality correction

On the user-requested retry, the account group changed to nano-banana(x1); fresh authorized models are only gemini-3.1-flash-image-preview and gemini-3-pro-image-preview. Public metadata tags them for image generation while supported_endpoint_types still includes openai. This proves endpoint compatibility is insufficient to classify text-chat models. Extend the existing relay directory mapper to veto explicit non-text input/output, non-chat types and bounded known image/video/embedding/audio-generation model families before positive endpoint fallback. Keep vision input plus text output eligible; never auto-switch Key/group/model or add an image engine. Existing provider.directory.completed count/stale summaries cover this change; no new log field, database shape, shared DTO or mobile request-path I/O. Extend the approved existing directory regression with exact observed image IDs, contradictory metadata and text/vision preservation; rerun existing backend tests/typecheck and inspect fresh live directory. Revert only the predicate if it rejects a separately proven chat model; empty authorized chat directory is a valid safe state.
