# Packy / OneXModel 文本平台接入

2026-11-24 本地候选，未部署、未发布运营配置、未执行远端迁移。供应商账户与真实付费生成验收分别记录，不能由单元测试替代。

沿用 `model-providers` registry → runtime config → provider directory → 已有模型草稿/发布 → generation transport → `ops.llm_calls` / `ops.llm_cost_jobs`。平台标识为 `packy`、`onexmodel`，应用稳定模型 ID 和用户星尘计费规则沿用现有契约。原 OpenRouter/Venice/Surplus、Surplus 候选池与独立图片/视频/语音任务不切换。

## 凭证与本地连通性

服务端变量名见 `packages/backend/.env.example`。调用 Key、调用地址与管理系统令牌/地址/用户 ID 分开。保留数字开头的 `1XM_*`、已部署的 `*_API_SECRET_USERT_ID` 拼写。地址只接受无 userinfo/query/hash 的 HTTPS 根地址或指定 `/v1`，禁止携带凭证跨重定向。

`PACKY_HTTPS_PROXY` / `1XM_HTTPS_PROXY` 复用 Venice 的可选本地 CONNECT 代理方式，覆盖该平台目录、推理、余额和日志请求。Railway 默认直连；代理值不进入源码、日志或浏览器。仅本机 `.env` 的 OneX 调用端点和本地代理在本次排障中调整，Key 与管理凭证未改；该文件不提交。

账户只读核验发现：Packy 当前 Key 的 `gemini-slb` 单分组没有返回可用模型，管理分组列表也不包含该组。保留真实空目录；不能把公开全站模型当作 Key 授权，也不能据此修改账户分组。应由运营选择可用分组/新 Key 后重新刷新。OneX 配置中的旧调用域名无法解析；官方兼容端点经本地代理可读取九个授权模型，管理账户查询也成功。此证据不代表 Railway 连通或真实推理成功。

目录只接受 Key 授权 ID，并要求模型本身或公开目录提供 OpenAI chat/text 能力证据。公开价格只作能力补充，平台倍率与显示的 `$` 不作为真实 USD；未知价格保持 `null`。两路目录读取并行、各自八秒，一次刷新共享 inflight，十五分钟缓存，失败保留 stale。生成热路径不刷新目录或查询管理接口。

## Admin 与 CLI

沿既有模型编辑器选平台、刷新、搜索、草稿、差异、CAS 发布及回滚。余额只读端点为 `GET /api/admin/model-providers/:provider/balance`，复用 Admin operator 鉴权；响应 private/no-store，内部成功结果缓存三十秒。账户余额不是调用 Key 的限额。缺凭证、超时、认证失败、HTML/坏 JSON 与合法零值分别处理。页面切换环境时丢弃旧环境迟到的余额结果。

请求统一放 `admin-client/modelProvidersApi.ts`；CLI 同步提供：

```sh
pnpm -s admin whoami --json
pnpm -s admin model-provider models packy --refresh --json
pnpm -s admin model-provider models onexmodel --refresh --json
pnpm -s admin model-provider balance onexmodel --refresh --json
pnpm -s admin config describe llm_relay_provider_config --json
```

以上 CLI 只操作生产；本次只实现命令，不执行生产发布。生产配置写入仍需先展示 diff，得到当次明确同意后再 publish。

新托管 key `llm_relay_provider_config` 只存非敏感策略，每平台独立配置 `quota_per_unit`、`cny_per_unit`、`usd_per_cny`、`conversion_version`、`conversion_source`、`monitor_enabled`、`low_balance_quota`。默认换算未知、监控关闭。USD 换算必须有完整单位与来源/版本；缺换算时保留原生 quota，不把平台额度当美元。配置不自动改用户星尘价格。

## 生成、用量与费用

复用现有 OpenAI-compatible `/chat/completions`、SSE/非流式、首字截止、取消、竞速、交付仲裁和固定报价恢复。新平台不发送 OpenRouter routing、Venice 专有参数或缓存字段；流式请求 usage。没有已验证的模型级思考参数时，不编造参数或改写已发布模型 ID；思考内容显示仍服从既有开关。

relay transport 在派发时确定调用 ID，代表 attempt 的 ID 保持一致；观察消费者实际读取的字节，不为补齐费用继续 drain 败方。所有终态保留已收到的 ID、HTTP 状态和 tokens，未知是 NULL、合法零是 0，缓存/思考为子项，不重复累加。usage 快照按 shared 白名单，仅存计数与账单摘要，上限 32 KiB，无聊天正文、Key、账户身份或原始管理响应。

`provider_account_ref` 是稳定的 provider/environment/account 哈希，Key 轮换不改变账单唯一约束；费用查询每次核验当前 Key 的管理 ID、账户、分组、请求 ID 与模型。Key 轮换后无法匹配旧 Key 的账单会保留不可获取，不冒认。调用记录或补查失败只告警，不影响交付或用户扣费。

费用补查复用既有成本 worker 和 `call_cost` 任务。数据库单语句 SKIP LOCKED 领取、180 秒租约，完成时在同一事务核验 owner/有效期；失去租约不能提交。每 call 最多八次、二十四小时，首次六十秒，指数退避加抖动；429 不即时重试。每轮每平台至多领取一项，日志最多五页、每页一百条，平台并发至多二。管理 GET 每次五秒，最多两次，仅网络/超时/5xx 重试；响应上限 1 MiB。任务容量与真实管理 API 分页/延迟仍需上线观察。

只有唯一精确账单才能写 `relay_invoice`，冻结原生 quota 与当时有依据的 USD 换算。重复、冲突、退款/冲正、无 ID、无权限、分页未穷尽均不按时间/模型接近认领；过窗终结 unavailable。唯一索引保护 provider/account/log ID。既有 OpenRouter 估算策略保持原状，新平台不会用其他平台价格或其他调用 tokens 补成本。

现有调用视图保留列与 ACL：旧平台 unavailable 的兼容口径不变，新平台未知 USD 保持 NULL，并通过已有 cost_pending 进入轮次未知标识。历史成本与用户钱包均不重算。

## 余额监控与日志

监控接入已有 payment-alert-monitor 的轮次 session 锁和 Publisher/outbox；四平台按两路并发执行。新策略默认关闭；低余额按原生 quota 阈值，平台独立 fingerprint，两次连续健康才恢复，失败/跳过清除健康计数且不发布 healthy。通知与业务结果隔离。IaC 仅准备同环境管理凭证引用，不部署，不同步本机代理。

目录、余额、成本 GET 与推理使用既有 observed fetch；成本轮次沿 `runObservedJob`，调用终态沿请求日志上下文。允许 provider、结果、稳定错误码、耗时、job_attempt 与已有业务/链路身份，不打印秘密、完整账户响应、日志行或聊天正文。错误用 `{ err }` 经现有安全投影；无新增日志库。

## 迁移、验证与恢复

先执行 `20261124_relay_provider_cost_view.sql`，再执行 `20261124_relay_provider_expand.sql`，每文件独立检查、记账。前者覆盖 PG17 deparser 的数字 cast 写法；后者曾在本地验证中触发原视图守卫，按迁移不可改写规则保留，通过前置 forward fix 收敛。扩展后的 provider CHECK、metadata/delivery/settlement RPC 和模型目录 validator 识别新平台；函数按仓库源文 md5 守卫、唯一锚点替换及结果 md5 核对，保留上游钱包与交付实现。漂移时停止，核对该环境原文后另做受审阅 forward fix。

新增数据只在 `ops.llm_calls`（O、保留一百八十天）与 `ops.llm_cost_jobs`（J、跟随调用清理）。原生金额、单位、换算、账单身份为真列；lease 仅在 jobs。配置由 Admin 发布 RPC 权威写入，runtime-config 是唯一读取入口；新纯 validator 归 admin。没有新调用表或通用调度器。

本地命令：

```sh
pnpm -r typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/admin-client test
pnpm --filter @miniapp/admin-cli test
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/frontend test
pnpm lint:imports
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/backend logging:validate
pnpm lint:migrations
pnpm lint:db-contract
pnpm -r --if-present build
```

单测须在子进程中把本机可选凭证设为空字符串（Windows PowerShell 的空 env 赋值会删除变量，使 dotenv 再次加载真实值）。本次旧 DeepSeek 状态栏用例首次运行曾触达真实上游，随后改用显式 Node 子进程 env 隔离；不得把 mock 验证写成付费平台验收。

`node scripts/test-relay-provider-migration.mjs <external-pglite-module>` 验证 PG17.5 WASM、非超级用户、重放、坏配置、账单唯一性、NULL/0 与匿名拒绝。PGlite 不支持真实并发索引，因此 harness 仅移除 CONCURRENTLY 验证同一索引定义；独立 PG17 的多连接并发、锁、容量和远端 TEST/生产仍未验证。本机没有 Docker/PostgreSQL 服务；远端 TEST 只读采集被 DNS/证书链阻塞，没有执行远端写入。

发布门禁：逐环境采集最终 shape/hash/RLS/grant/index 与容量，真实 PG17 → TEST 验证两文件，Backend/worker/Admin/CLI/Frontend 兼容版本后，受控发布每平台一个模型，验证发送/重生成/断流、唯一账单和一次用户结算。Packy 分组资源、上游 header/body ID 与消费日志 ID 的实际关联、退款口径和真实付费账单仍需受控验收。按用户要求不做本地 UI 测试；建议后续复用 @chat/@roleplay 纳入选模/下架/重生成/失败恢复。Android、iOS 与接口真实 P95 基线无样本，保持 null，发布前后各连续二十四小时观察，不宣称性能达标。

回退优先禁用新平台目录、恢复正式配置、关闭新监控，停止新平台补查；保留扩展列、jobs 与调用/账单证据。有新 provider 历史后不收窄 enum/CHECK、不删除账单、不回退到不识别新 provider 的应用；数据库异常 forward-fix。没有迁移测试与真实账单证据时不可宣称已上线完成。
