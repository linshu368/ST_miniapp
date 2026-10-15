# Task Breakdown

| ID  | 状态        | 工作与文件范围                                                        | 验证/门禁                                                                                               |
| --- | ----------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| T1  | Done        | 复核 TEST/Production 结构、账本、应用/DB 消费者；定历史归属与兼容边界 | 只读 catalog/依赖/账本证据；未导出业务行，见 `research/t1-environment-and-consumer-audit-2026-10-15.md` |
| T2  | Done        | 新表 migration 与 Backend 生成、结算、回捞仓储；必要的既有回归        | 本地静态与回归通过；远端 migration/人工场景留给 T3                                                      |
| T3  | In progress | TEST 单文件迁移、回填核对、视图/消费者切换、旧列清理门禁              | TEST 结构/回填已核验；匹配 Backend 部署后的 SSE/扣费/回捞仍待执行                                       |
| T4  | Todo        | 文档/spec 更新及最终审阅包                                            | diff、验证结果、forward-fix 和发布顺序                                                                  |

## Execution Log

- 2026-10-15：依据正式 TEST 的只读结构核验与仓库读写链路创建规划任务；未执行 `task.py start`，未修改产品代码或数据库。待人工审阅规划后再启动。
- 2026-10-15：人工审阅后启动任务并完成 T1。确认 TEST/Production 的 13 列与 `current_chat_history` 依赖一致，Production 另有 `miniapp_analytics.base_chat_bj.llm_latency` 依赖；记录 Venice shape/账本漂移和主表终态、回捞、历史关联边界。未写入数据库或产品代码。
- 2026-10-15：完成 T2。本地新增 `20261015_openrouter_chat_history.sql`：`experience.openrouter_chat_history` 以 `chat_history_id` 唯一、父 FK `ON DELETE CASCADE`、OpenRouter 常量约束、generation-ID/时间索引及仅 `service_role`/`postgres` 授权保存调用元数据；没有执行 TEST 或 Production migration，也没有回填历史数据。Backend 在获取 OpenRouter generation ID 时幂等创建/补齐明细占位，结算和 24 小时 sync job 从新表定位并写入元数据；`experience.chat_history.llm_finish_reason` 仍由业务终态路径裁决，计费事实仍留主表，旧 generation ID 继续兼容写入。新增/扩展回归覆盖 ID 占位、OpenRouter 明细写入、敏感调用内容排除及取消保护；`pnpm --filter @miniapp/backend test`（83 files / 651 tests）、`pnpm --filter @miniapp/backend typecheck`、`pnpm -r typecheck`、`pnpm lint:migrations` 与 `git diff --check` 通过。
- 2026-10-15：T3 已在正式 TEST `zoqelpfhurwehlvypryl` 通过官方 Database Migration workflow 单文件执行并记账：`20261015_openrouter_chat_history.sql`（run `38719886735`）与 `20261015_openrouter_chat_history_backfill.sql`（run `38720229528`）。只读核验确认 17 列、父 FK/唯一/约束、`anon`/`authenticated` 无 SELECT、`service_role` 有 SELECT/INSERT，且两份账本记录存在。回填严格以 `llm_billing_snapshot.provider='openrouter'` 为归属证据：102 条 eligible parent rows 与 102 条 detail rows 一致；1,674 条归属不足或其他 provider 行未迁入；`llm_generation_data` 与 provider-table 的 `llm_finish_reason` 均为 0 条历史复制，避免带入未审计内容或把主表业务终态误当上游事实。未运行 Production migration、未删除/清理旧列、未修改 `current_chat_history` 或 `miniapp_analytics.base_chat_bj`。
- 2026-10-15：用户补充并授权 T3 排除法：目前只有 OpenRouter/Venice，Venice 每次调用均有 `venice_chat_history.chat_history_id`；有 generation ID 且无 Venice 明细的主表行归 OpenRouter。TEST 只读审计无明细重叠、无 Venice 快照缺 Venice 明细；补迁移前剩余候选随活跃写入从 1,674 增至 1,680。发现新表错误地将 `llm_provider_name` 限制为常量 `openrouter`，而该列实际是路由厂商；新增 forward migration 修正约束、修复首批 102 条占位厂商名、按排除法补齐已有 generation ID 行。Backend 占位不再写假厂商，结算/回捞将上游明细与主表计费字段隔离，避免 `llm_intended_deduction` 等字段进入新表。历史 raw JSON 与主表业务终态不复制；无 generation ID 的 165 条非 Venice 行无上游关联键与元数据，不属本次明细回填。Backend 83 files / 651 tests、`pnpm -r typecheck`、migration 文件名检查与 `git diff --check` 已通过；TEST workflow、部署和人工场景结果待后续记录。
- 2026-10-15：上述补迁移以提交 `d355811f` 推送，官方 TEST Database Migration workflow run `38744963817` 成功执行并记账。执行后只读核验：有 generation ID 且无 Venice 明细的 parent 1,782 条，新表 1,782 条，缺失 0、Venice 重叠 0、厂商名与主表不符 0；历史 `llm_generation_data` 和 provider-table `llm_finish_reason` 均为 0 条复制。17 列保持不变，旧常量约束已移除，厂商列允许 NULL 且无默认值；`anon`/`authenticated` 无 SELECT、`service_role` 有 SELECT/INSERT/UPDATE。`pnpm test:migration-ledger`、`pnpm lint` 通过；Backend 无 build 脚本。TEST Backend 仍未部署，真实 SSE、结算与重复回捞未验收；Production 未执行，视图和主表旧列未动。活跃库的总数会继续变化，部署前新产生的旧路径行需再次核对补齐。

## T3 前置项与剩余风险

- 先由 Database Migration workflow 在 TEST 单文件执行 `packages/shared/migrations/20261015_openrouter_chat_history.sql`，逐项核对表 shape、FK/级联、唯一约束、索引、grant/RLS 与 service-role 读写；Production 需独立审批、目标复核与同样的执行记录。不可用本地验证替代任一远端环境。
- 需在 TEST 以真实 OpenRouter 发送、重生成、免费/付费、取消、超时、上游错误、迟到 usage 和重复 sync 验证：generation ID 占位可用、重复 upsert 不增行、主表业务终态不被晚到 `stop` 覆盖、计费不会重复扣款。
- 不得在 T3 前回填或删除主表旧列；`current_chat_history` 与 Production `miniapp_analytics.base_chat_bj` 仍依赖旧列。只有确认两环境的应用/视图/函数/分析查询及部署版本均无旧列读写后，才可另行评估 consumer 切换和清理。
- TEST/Production 现有 `venice_chat_history` 与未记账 `20260929_venice_chat_history.sql` 的漂移保持已记录状态；本任务未重跑、未改写该 migration，不能据此推断新 migration 的账本状态。
- T3 尚需匹配 `c706ff10`（或后续兼容提交）的 TEST Backend 部署，才可通过真实 OpenRouter SSE 验证 generation-ID 占位、免费/付费、取消/超时、迟到 usage、重复 sync 和不重复扣费。该部署、`current_chat_history` consumer 切换与旧列清理均需单独授权；在完成两环境无读写证据门禁前不得执行。
