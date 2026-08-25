# Schema 划分一阶段执行计划

> 状态：待开工  
> 日期：2026-08-25  
> 权威归属：`docs/schema归属地图.md`  
> 依赖盘点：`docs/schema划分专项.md`

## 一、阶段目标

实现八个归属域的基本物理形态：

| 逻辑域           | 一阶段物理 schema   | 一阶段动作                                                  |
| ---------------- | ------------------- | ----------------------------------------------------------- |
| app_core         | `app_core`          | 新建并迁入 4 表                                             |
| miniapp_features | `miniapp_features`  | 新建并迁入 6 表                                             |
| experience       | `experience`        | 新建并迁入 3 表 + 1 视图                                    |
| billing          | `billing`           | 新建并迁入 7 表                                             |
| admin            | `admin`             | 保持名称与表位置；改写引用新 schema 的函数体                |
| cs_platform      | `cs_platform`       | 保持名称；接收 `support_conversations` / `support_messages` |
| acquisition      | `miniapp_traffic`   | 保持名称与现状                                              |
| analytics        | `miniapp_analytics` | 保持名称与现状                                              |

阶段完成的判定：

1. 22 张存量表和 `current_chat_history` 视图位于正确 schema；
2. `miniapp` 已无表、视图、函数和运行时依赖，可在观察期后删除；
3. 库内函数、触发器、视图、FK、cron 均引用新位置且行为不变；
4. 后端、前端、运营台、CS 平台、Prisma、测试和脚本适配新 schema；
5. test 与 production 的对象形态一致，核心业务回归通过；
6. `miniapp_traffic` / `miniapp_analytics` 不改名、不搬表，不改变既有业务边界。

本阶段不做：

- 不继续删除 `chat_history` 的 B 档字段；
- 不重构业务逻辑，不顺手调整表结构；
- 不改 acquisition / analytics 的内部设计；
- 不用兼容视图或 RPC wrapper 做零停机过渡；生产采用低峰短停机硬切。

---

## 二、已拍板的实施原则

1. RPC 跟随“主要写入表”所属域，不集中到统一 API schema。
2. `support_conversations` / `support_messages` 物理迁入 `cs_platform`。
3. 生产采用低峰短停机：停流量后连续完成数据库迁移、PostgREST 重载和新代码部署。
4. 跨域访问只准走 RPC / repository / API；归属地图登记的存量豁免除外。
5. 上游对象只做适配，不借机改变行为。尤其 `admin`、`cs_platform`、
   `miniapp_traffic`、`miniapp_analytics` 的既有逻辑必须保留。
6. 迁移顺序仍为先 test、后 production，逐库核对对象形态和业务行为。

---

## 三、对象迁移清单

### 3.1 表与视图

`app_core`：

- `users`
- `miniapp_user_settings`
- `characters`
- `runtime_config`

`miniapp_features`：

- `character_favorites`
- `character_ranking_scores`
- `daily_checkins`
- `wish_roles`
- `notifications`
- `notification_reads`

`experience`：

- `chat_sessions`
- `chat_history`
- `chat_message_audio`
- `current_chat_history`（视图）

`billing`：

- `payment_orders`
- `wallet_ledger`
- `user_wallets`
- `llm_usage_charges`
- `llm_usage_charge_dedup`
- `character_free_chat_quotas`
- `character_free_chat_quota_decisions`

`cs_platform` 接收：

- `support_conversations`
- `support_messages`

`ALTER TABLE / VIEW ... SET SCHEMA` 是元数据移动，不重写 `chat_history` 的大体量数据。
FK、视图和触发器依赖使用对象 OID，通常会随对象移动保持有效；迁移后仍必须通过
`pg_constraint`、`pg_get_viewdef` 和 `pg_trigger` 实测确认，不能只依赖理论行为。

### 3.2 miniapp 函数归属

迁移前 test 基线为 24 个函数，其中 23 个函数体硬编码 `miniapp.*`。
执行时必须以 test / production 当日实测为准，多出或缺少对象即停止。

`app_core`（2）：

- `increment_user_total_round`
- `tf_track_character_listing`

`miniapp_features`（6）：

- `claim_daily_checkin`
- `complete_wish_role`
- `create_wish_role`
- `get_character_favorite_counts`
- `list_character_favorites`
- `set_character_favorite`

`experience`（5）：

- `apply_context_window_flood`
- `guard_chat_session_idle`
- `start_chat_history_regeneration`
- `start_chat_history_turn`
- `tf_refresh_chat_session_stats_from_history`

`billing`（11）：

- `charge_llm_usage`
- `complete_payment_order`
- `deduct_wallet_credits`
- `expire_payment_orders`
- `finalize_character_free_chat_round`
- `grant_new_user_signup_bonus`
- `grant_wallet_on_user_insert`
- `prepare_llm_usage_charge`
- `reconcile_llm_usage`
- `reserve_character_free_chat_round`
- `retain_recent_llm_usage_charges`

函数处理方式：

1. 用 `ALTER FUNCTION ... SET SCHEMA` 保留函数 OID、owner、grants 和触发器依赖；
2. 再用 `CREATE OR REPLACE FUNCTION` 改写函数体内所有 schema 限定名；
3. 不使用 `DROP FUNCTION ... CASCADE`，避免误删触发器和下游依赖；
4. 保持原参数、返回类型、`SECURITY DEFINER`、owner、执行权限和
   `search_path` 安全设置不变；
5. 函数之间的调用也必须改成新 schema 名。

### 3.3 其他库内对象

- `admin` 中硬编码 `miniapp.*` 的函数：test 基线 20 个。函数继续留在 `admin`，
  只替换表、视图和 RPC 的限定名，不改变业务行为。
- production pg_cron job 5：把 `miniapp.characters` 改为
  `app_core.characters`；job 2 / 3 的实际状态和残留命令在生产预检时复核。
- `miniapp_analytics`、`miniapp_traffic`、`cs_platform` 中引用 `miniapp.*` 的视图：
  表移动后应自动跟随 OID，迁移后逐个检查定义和可查询性。
- grants / default privileges / PostgREST exposed schemas：按新八域重建并实测；
  不假设旧 `miniapp` 权限会自动覆盖新 schema。

---

## 四、代码适配范围

### 4.1 Supabase 客户端

在后端提供按域绑定的客户端入口，至少覆盖：

- `app_core`
- `miniapp_features`
- `experience`
- `billing`
- `admin`
- `cs_platform`
- `miniapp_traffic`
- `miniapp_analytics`

repository 按表所属域选择客户端。一个 repository 横跨多个域时，显式持有多个域客户端，
不得继续依赖统一 `.schema('miniapp')`。

### 4.2 Repository、路由与任务

当前实测需重点适配：

- 23 个包含 `.schema('miniapp')` 的代码文件；
- 后端 16 处受影响的 miniapp RPC 调用；
- `ranking-stats.ts`、CS 路由和 repository 中硬编码 `miniapp.*` 的 raw SQL；
- `chat-history-logger.ts` / `chat-history-sync-job.ts`；
- 充值、签到、收藏、许愿、通知、客服、对话、语音相关 repository 和路由；
- seed、MVP regression、集成测试、过期订单脚本。

不得用批量字符串替换直接收口：同一文件可能同时访问 core、features 和 billing。

### 4.3 Prisma

- datasource `schemas` 从 `["miniapp"]` 改为实际使用的新 schema 集合；
- 每个 model 的 `@@schema` 改到归属域；
- 更新 seed 和所有 raw SQL；
- 重新执行 `prisma generate`；
- 核对运行时使用 Prisma 的 characters、favorites、growth、CS、ranking 等路径。

### 4.4 Supabase / PostgREST 配置

- 清理 `supabase/config.toml` 中已删除的
  `miniapp_simulation` / `st_platform` / `st_users` / `st_infra`；
- 加入八个物理 schema（保留平台要求的 `public` / `graphql_public`）；
- 远程库不能只改本地 config 或 Dashboard，按
  `docs/fix-postgrest-schema-exposure.md` 更新 `authenticator` 的
  `pgrst.db_schemas` 并发送 reload NOTIFY；
- 为 `anon` / `authenticated` / `service_role` 配置最小必要 schema usage、
  表和函数权限；迁移后用真实角色调用验证。

---

## 五、实施批次与节奏

### 批次 A：基线冻结与实现（预计 1–2 个工作日）

1. 分别盘点 test / production：
   - schema、表、视图、函数、触发器、FK、grants、owner；
   - 092 是否已执行；
   - `public` / `analytics` 迁出后的残留；
   - `miniapp_analytics` 全量视图定义；
   - cron job 定义和状态；
   - 所有函数体中的 `miniapp.*` 文本引用。
2. 将查询结果归档为迁移前快照；两库形态不一致处先列差异，不擅自抹平。
3. 编写 migration 093：
   - 顶部放只读 preflight 断言；
   - 单事务创建新 schema、移动表/视图/函数、改写函数体、迁移权限；
   - 底部放 postflight 断言；
   - 配套准备生产提交后回滚 SQL。
4. 同步完成全部代码适配、Prisma 和本地 Supabase 配置。
5. 不动远程数据库，先完成静态检查、单测和构建。

交付门：代码可构建；093 和回滚脚本均经人工审阅；preflight 能明确阻止结构漂移。

### 批次 B：test 割接演练（预计 1 个工作日，失败则重演）

1. 记录 test 迁移前对象快照和关键行数；
2. 执行 093；
3. 配置 grants 和 PostgREST exposed schemas，触发热重载；
4. 部署适配新 schema 的 test 后端及相关前端；
5. 运行：
   - TypeScript / unit / build；
   - MVP regression 全量；
   - 数据库集成测试；
   - 真机或等价 API smoke。
6. 核对表行数、视图可查、FK / trigger / function / grants / owner、cron；
7. 全仓库和数据库函数体复查，不允许保留运行时 `miniapp.*` 引用。

交付门：至少完成一次从干净基线开始的完整演练并全绿；记录迁移和部署实际耗时，
据此确定生产维护窗口。

### 批次 C：production 短停机割接（预计半个工作日）

1. 发布维护通知，停止入口流量和后端后台任务；
2. 记录生产即时快照，确认 preflight 与 test 演练基线一致；
3. 确认可回退的旧部署制品、回滚 SQL和执行人；
4. 执行 093；事务内任一步失败则整体回滚并停止；
5. 更新 PostgREST exposed schemas / grants / reload；
6. 更新 cron job 5；
7. 部署新代码；
8. 完成最小上线验证后恢复流量：
   - 登录 / 用户创建；
   - 角色卡列表；
   - 新建会话、发消息、重生成、历史分页；
   - 钱包余额、扣费、充值和签到；
   - 收藏、许愿、通知；
   - 客服；
   - admin 角色卡、配置、公告与补发额度；
   - CS 关键查询；
   - acquisition / analytics 视图可查。

交付门：核心链路通过、错误日志无 PGRST106 / relation not found /
permission denied、关键行数与迁移前一致。

### 批次 D：观察与收口（观察 1–2 天）

1. 监控 API 错误、数据库日志、cron、计费和对话链路；
2. 确认 `miniapp` schema 无表、视图、函数及运行时引用；
3. 删除空 `miniapp` schema，并从 PostgREST 暴露列表移除；
4. 更新 `schema归属地图.md`、`schema划分专项.md`、迁移 README 和执行记录；
5. 将迁移前后对象快照、验证结果和遗留项归档。

整体建议节奏：**实现 1–2 天 → test 演练 1 天 → 修正并重演 → production 半天 →
观察 1–2 天 → 收口**。不以日历强推；批次 B 未完整通过，不进入 production。

---

## 六、迁移与回滚纪律

### 6.1 migration 093

表移动、函数移动与函数体改写必须在同一事务完成，避免数据库出现
“表已搬走、函数仍指向 miniapp”的中间状态。

建议结构：

1. `BEGIN`、`lock_timeout`、`statement_timeout`；
2. preflight：对象集合、关键列、函数签名、依赖和 schema 状态；
3. `CREATE SCHEMA` + owner / grants；
4. `ALTER TABLE / VIEW ... SET SCHEMA`；
5. `ALTER FUNCTION ... SET SCHEMA`；
6. `CREATE OR REPLACE FUNCTION` 改写函数体；
7. admin 函数体改写；
8. grants / default privileges；
9. postflight：对象数量、残留文本引用、FK、trigger、view 可查询；
10. `COMMIT`。

cron 和 PostgREST 管理配置可在事务提交后作为同一维护窗口的明确步骤执行，
不要把外部配置变化伪装成数据库事务的一部分。

### 6.2 回滚

- 事务提交前失败：依赖 PostgreSQL DDL 事务自动回滚；
- 提交后失败：保持停流量，执行预先审阅过的反向迁移，把对象和函数移回
  `miniapp` 并恢复旧函数体、grants、PostgREST 配置、cron 命令，随后部署旧代码；
- 不允许现场临时拼接回滚 SQL；
- 不用 `DROP ... CASCADE`、强制 reset 或其他不可逆操作处理割接故障。

---

## 七、关键风险与控制

| 风险                                       | 控制                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| DB 迁移与代码部署无法原子提交              | 短停机；先停流量，按固定 runbook 连续执行                                           |
| test / production 结构漂移                 | 双库 preflight；对象集合不符立即停止                                                |
| 43 个函数体漏改文本引用                    | 自动扫描 `pg_proc.prosrc` + 全仓库扫描；postflight 要求运行时 `miniapp.*` 为零      |
| `SECURITY DEFINER` 权限或 search_path 改坏 | 保持 owner / attributes / grants；真实角色调用回归                                  |
| PostgREST 新 schema 未暴露                 | GUC + NOTIFY 热重载；实测每个 schema 的 REST/RPC                                    |
| production analytics 视图与 test 不同      | 生产预检导出全量定义；迁后逐个 SELECT                                               |
| cron job 5 仍指向旧表                      | 停机窗口更新 command，并检查下一次执行结果                                          |
| 大表移动锁等待                             | `SET SCHEMA` 虽不重写数据仍需 DDL 锁；低峰停流量、设置 lock_timeout、迁前检查长事务 |
| `support_*` 跨入 cs_platform 后权限断裂    | routes/support、admin/CS 调用和跨 schema FK 全部纳入 smoke                          |
| 上游对象被顺手重构                         | 本阶段只做限定名适配；行为变化另开迁移和评审                                        |

---

## 八、新窗口开工交接

新窗口必须先读三份文档：

1. `docs/schema划分-一阶段执行计划.md` —— 执行顺序、决策、验证与回滚；
2. `docs/schema归属地图.md` —— 表和函数归属的权威来源；
3. `docs/schema划分专项.md` —— 现有表、代码、FK 和 `chat_history` 依赖盘点。

执行远程数据库或处理 PostgREST 时再补读：

4. `docs/fix-postgrest-schema-exposure.md`；
5. `docs/ST_remove-Supabase瘦身专项.md`。

新窗口建议直接使用以下开工指令：

> 前置阅读：
>
> - `docs/schema划分-一阶段执行计划.md`
> - `docs/schema归属地图.md`
> - `docs/schema划分专项.md`
>
> 开始 Schema 划分一阶段的批次 A。先分别实测 test 和 production 当前状态，
> 核对 092、bot 迁出残留、函数/视图/cron/grants；输出差异与 preflight 结论。
> 未完成双库基线核对前不要执行任何写库动作。之后实现 migration 093、回滚 SQL
> 和代码适配，并按执行计划验证。保留上游行为，不改 `miniapp_traffic` /
> `miniapp_analytics` 的名称和内部设计。

此外，新窗口必须具备 production 的只读盘点能力（连接串或 Supabase MCP）。
如果暂时没有，先完成 test 基线和代码实现，但不得进入 production 割接。
