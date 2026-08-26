# Schema 划分 · 批次进度交接（A 已完成 / B test 已割接）

> 日期：2026-08-26（批次 B 割接同日）  
> 分支：`dev_ST_remove`（已合入 `origin/main`，合并提交 `abda9ae`）  
> 本文件给新窗口接着干。权威归属与执行纪律仍以下面三份为准，本文只记**做到哪、下一步做什么、不要重问什么**。
>
> 文件名沿用 `批次A`（其它文档按路径引用它），内容已覆盖批次 B，见 §八。

必读：

1. `docs/schema划分-一阶段执行计划.md` — 批次、割接、验证、回滚
2. `docs/schema归属地图.md` — 表和函数归属
3. `docs/schema划分专项.md` — 表盘点与 `chat_history` 字段审计
4. `ops/schema-split/snapshots/2026-08-25/批次A-双库基线与差异.md` — 双库实测基线
5. `docs/fix-postgrest-schema-exposure.md` — 动 PostgREST 时再读

---

## 一、一句话状态

**批次 A 已完成；批次 B 的 test 割接已执行完，库侧与本地验证全绿，只差部署后的 API smoke。**

099 已于 2026-08-26 18:19 在 **test 提交执行**（耗时 8.92 秒），PostgREST 暴露列表已切换，
test 库现在是新形态：`miniapp` 空壳，22 表 + 1 视图 + 25 函数分布在五个域里。
**生产仍未动**（097 与 099 都没执行）。批次 B 的明细与实测数据见 §八。

批次 A 的交付门（执行计划 §五 批次 A）四项都齐了：

| 交付门项                 | 状态                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| 代码可构建               | ✅ 5 包 typecheck / lint / build 全绿                                         |
| 单测                     | ✅ shared 55 + backend 308 + frontend 56 + admin 41，0 失败                   |
| 099 preflight 能阻止漂移 | ✅ 对象集合、函数集合、search_path 名单、目标 schema 不存在、类型残留逐项断言 |
| 099 与回滚脚本经人工审阅 | ✅ 2026-08-26 按 §6.0 四项审过，无阻断，见该节审查记录                        |

---

## 二、已拍板、不要重开讨论

| 项                     | 决定                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| 生产 097 顺序          | 先把当前代码部署到生产（纯代码、无 DB 变更），确认不再写 `llm_model_markup` 等三列，再执行 097，再写/跑 099 |
| `preset_id`            | 照原样删，接受丢失。123,574 行 ST 存量有值，但 `st_platform.platform_presets` 已随 088 消失，引用无法解析   |
| test `characters` 三列 | 单独 098，不塞进 099。已在 test 执行                                                                        |
| 函数 EXECUTE           | 按 prod 收敛，不授 `anon` / `authenticated`                                                                 |
| `public` 残留函数      | 099 只改限定名、不改行为；是否删除另开评审                                                                  |
| PostgREST              | 用 GUC 接管；列表必须先含现有 `miniapp_analytics` / `cs_platform`，再追加新域                               |
| `aiero` schema         | 无关，永久排除                                                                                              |
| 分支                   | 在 `dev_ST_remove` 上 merge `origin/main`，main 改动只读（已完成）                                          |
| 编号                   | 097 = chat_history 三列（原 092）；098 = characters 死列；099 = schema 划分                                 |
| 生产割接               | 低峰短停机硬切，不做兼容视图 / RPC wrapper                                                                  |

合 main 时的冲突规则：上游（`origin/main`）只读，只改编本分支的改动。见 `.cursor/rules/upstream-merge-protection.mdc`。

---

## 三、已完成

### 3.1 仓库与编号

- 合入 `origin/main`，无冲突；当时 5 包 typecheck 全绿。
- 原 `092_chat_history_drop_dead_columns.sql` 重编为 `097_…`（`main` 已占用 092/093/094/095）。
- 执行计划、专项文档、`packages/shared/migrations/README.md` 已改到 097/098/099。README **还没登记 099 这一行**。

### 3.2 双库盘点（2026-08-25，只读）

快照：`ops/schema-split/snapshots/2026-08-25/{test,prod}/`  
脚本：`ops/schema-split/inventory.sql`、`dump-functions.sql`、`run-inventory.sh`

连接串在仓库根 `.env.schema-split`（被 `.gitignore` 的 `.env*` 规则忽略，**不要入库**）。脚本从该文件读 `TEST_*` / `PROD_*`，不要把密码写进命令行。

### 3.3 迁移文件与执行情况

| 文件                                                                 | 库状态                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/shared/migrations/097_chat_history_drop_dead_columns.sql`  | **test 已执行**（当时编号还是 092，文件全程 `IF EXISTS`，重跑无副作用）。**生产未执行**，被代码部署卡住 |
| `packages/shared/migrations/098_characters_drop_st_sync_columns.sql` | **test 已执行**，`characters` 31 列 → 28 列。生产是 no-op                                               |
| `packages/shared/migrations/099_schema_split_phase1.sql`             | 已写完。test 正向空跑 + 往返空跑均通过并 ROLLBACK，**两库都未提交执行**                                 |
| `packages/shared/migrations/099_schema_split_phase1_rollback.sql`    | 已写完。随往返空跑在 test 上真跑过一遍（搬回 + 改回 + DROP 四个 schema），**未提交执行**                |

### 3.4 099 test 空跑（2026-08-26）

命令：`bash ops/schema-split/dryrun-099.sh test`  
做法：把副本末尾 `COMMIT` 换成 `ROLLBACK`，去掉事务外 `NOTIFY`。原文件不动。

实测通过：

- preflight 通过（待搬 23 表/视图、25 函数）
- 创建四 schema、搬对象、改写 **44** 个函数体、人群规则 **13** 处
- postflight 全部通过
- `ROLLBACK` 后复核：`miniapp.chat_history` 仍在；`app_core` / `miniapp_features` / `experience` / `billing` 不存在；`miniapp` 仍 25 个函数；人群 SQL 仍含 `miniapp.*`

空跑里修进 099 的两处：

1. `relkind` 是 `"char"`，和 `text` 拼接必须 `::text`。
2. test 多了盘点之后才出现的 `miniapp.charge_voice_usage`（见 §五）。已标成 **billing 可选函数**：有则搬走，没有则跳过。这样生产 preflight 不会因为缺它而失败。

### 3.5 099 回滚脚本与往返空跑（2026-08-26）

`packages/shared/migrations/099_schema_split_phase1_rollback.sql`，与 099 逐节反向对应。

**为什么是文本反向、而不是内嵌旧函数体**：双库基线 §三 A3 记了 13 个函数的函数体在两库不同，
内嵌就得维护两份、且随时和库里的真实源码脱节。所以回滚脚本和 099 一样只改限定名，两库通用。
反向替换是精确可逆的——四个新 schema 在 099 之前不存在，改写后出现的 `<域>.<对象>` 只可能来自 099。

为了让这条推理成立，往这一版 099 里补了两条断言（正文行为不变）：

1. **§1.5b**：把 `search_path` 固定成 `'miniapp', 'public'` 的函数必须恰好是
   `increment_user_total_round` / `grant_new_user_signup_bonus` / `grant_wallet_on_user_insert` 这三个。
   回滚脚本按同一份硬编码名单反向恢复——改写之后已经没法从库里区分「被 099 改过」和「本来就指向自己 schema」。
   多出第四个就停，两个文件的名单一起改。
2. **§1.7 收紧**：四个目标 schema 必须**完全不存在**（原来允许「已存在但为空」）。
   回滚脚本会 `DROP SCHEMA ... RESTRICT` 它们，所以必须确定是 099 自己建的。
   099 单事务，失败不留半成品 schema，正常情况下这条不会误伤。

另外两库都补了一条更强的守卫：全库 FK 总数迁移前后必须完全相等
（原来只断言「跨 schema FK 不减少」，那个在回滚方向上本就应该下降，29 → 8）。

**往返空跑**：`bash ops/schema-split/dryrun-099-roundtrip.sh test`
同一个事务里先跑 099 正文、再跑回滚脚本，最后 ROLLBACK。两份原文件都不改
（临时表前缀 `_split_` / `_unsplit_` 刻意错开，就是为了能在同一事务里共存）。

test 实测通过：

- 正向：改写 44 个函数体、人群规则 13 处，postflight 全过
- 反向：改回 44 个函数体、人群规则 13 处，`DROP SCHEMA` × 4，postflight 全过
- ROLLBACK 后复核：`miniapp` 回到 22 表 / 1 视图 / 25 函数；四个新 schema 不存在；
  人群规则仍有 7 条引用 `miniapp.*`（与迁移前基线一致）

---

## 四、099 已经写进去的设计要点

单事务：preflight → `CREATE SCHEMA` → `ALTER TABLE/VIEW SET SCHEMA` → `ALTER FUNCTION SET SCHEMA` → `CREATE OR REPLACE` 改写函数体 → 改写 `cs_platform.personas.sql_text` → postflight → `COMMIT`。

文本改写覆盖三类（OID 跟随帮不上忙的）：

- `pg_proc.prosrc` 里的 `miniapp.<obj>`
- 3 个函数的 `SET search_path TO 'miniapp', 'public'`
- 人群规则 `cs_platform.personas.sql_text`（test 7 条、prod 14 条命中）。`persona_refresh_runs.sql_text` 和 `admin.audit_logs` 历史行**不改**

权限：四个新 schema 只给 `service_role` USAGE，**不给 anon/authenticated**。`chat_history` RLS 未开，且 9 张表上还留着自动暴露时代的表级 DML；一旦补上 schema USAGE 就会把匿名读写放开。表级残留授权不在 099 清理。

事务外收尾（**已写好**，都带 preflight 断言、REST/cron 实测步骤和「回滚」小节）：

- `ops/schema-split/postgrest-expose-test.sql`  
  现状 GUC 是 `public, graphql_public, miniapp, miniapp_traffic, admin`。新列表在末尾追加
  四个新域 **+ `cs_platform`**——test 现在不暴露 cs*platform，而 `support*\*`被 099 迁进去之后`routes/support.ts` 是走 PostgREST 读写它们的，不加就直接 PGRST106。生产本来就暴露 cs_platform，
  这一步是让 test 与生产一致，不是放宽权限（cs_platform 只给 service_role USAGE）。
- `ops/schema-split/postgrest-expose-prod.sql`  
  生产没有 `pgrst.db_schemas` GUC，列表来自平台层。改用 GUC 就是**整体覆盖**平台层，不是合并。
  所以 step 0「当天重新实测暴露列表」写成了不可跳过的一步，脚本还断言 GUC 尚不存在。
  回滚是 `RESET`（让平台层重新接管），不是手抄一份旧列表写回去。
- `ops/schema-split/cron-job5-prod.sql`  
  只改 job 5 的 `FROM miniapp.characters` → `app_core.characters`，
  断言命中恰好 1 次、写入目标 `miniapp_analytics.card_position_snapshot` 不变。
  用 `UPDATE cron.job` 而不是 `cron.schedule()`（后者按 jobname 匹配，会换掉 jobid）。
  job 2/3 已 inactive 且不含 `miniapp.` 限定名，不动。test 没有 pg_cron，这一步演练不了，
  只能在生产窗口靠下一个整点的 `cron.job_run_details` 验。

`supabase/config.toml` 的 `schemas` 也已改成同一份口径（摘掉已删的 `miniapp_simulation` /
`st_*`，补上八域；`miniapp` 留到批次 D）。

---

## 四之二、代码适配做了什么（2026-08-26）

### 按域客户端入口

`packages/backend/src/lib/supabase.ts` 新增 `getDomainDb(域名)`（配 `DOMAIN_SCHEMAS` /
`DomainSchema` / `DomainDb`）。参数写死成域名字面量，是为了让「这段代码在读哪个域」
在 review 和 grep 时一眼可见。`getSupabaseClient()` 保留，只做单例与 Storage / Realtime。

`DomainDb` 必须显式写成 `ReturnType<SupabaseClient['schema']>`：底层类型来自
`@supabase/postgrest-js`，不是 backend 的直接依赖，让 TS 推断会撞 TS2742。

### 40 处 `.schema('miniapp')` 全部按表归属改域

单域文件直接换；**四个跨域文件显式持有多个域客户端**（这是执行计划 §4.1 点名要防的情况）：

| 文件                                | 拆法                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `MiniappWalletRepository.ts`        | `db` = billing；`appCoreDb` 只读 `runtime_config`；`featuresDb` 管 `daily_checkins` + `claim_daily_checkin` |
| `ChatSessionRepository.ts`          | `db` = experience；`appCoreDb` 读 `characters` 的开场白                                                     |
| `chat-history-logger.ts`            | `experienceDb` 写 `chat_history`；`appCoreDb` 调 `increment_user_total_round`                               |
| `conversations.integration.test.ts` | `experienceDb`（会话/逐轮）+ `appCoreDb`（用户/角色卡）                                                     |

`mvp-regression/fixtures.ts` 原来是一个 `db()` helper 打通所有表，现在改成
`FIXTURE_TABLE_DOMAIN` 表→域映射 + `db('表名')`。好处是映射只有一份，
新增表忘了登记直接编译不过。

### raw SQL 44 处

`ranking-stats.ts`（含 `information_schema` 探针的 `table_schema = 'experience'`）、
`routes/cs-platform.ts`、`CsPlatformRepository.ts`、`routes/growth.ts`、`seed-config.ts`、
`packages/cs-platform/src/constants.ts` 的默认人群 SQL 模板（与 099 改写后的表名对齐）、
`PersonaModal.tsx` 里给运营看的提示文案。注释里的 `miniapp.*` 一并改准。

**没动**：`sse.test.ts` 的 `https://miniapp.example`、frontend 的 `https://miniapp.local`——
那是 URL，不是 schema。

### Prisma

`schemas = ["app_core", "miniapp_features", "billing"]`，11 个 model 各自 `@@schema` 到归属域
（app_core 4 / miniapp_features 2 / billing 5）。`experience` / `cs_platform` 里没有 model，
只被 `$queryRaw` 用全限定名访问，所以不进 `schemas`。已 `prisma generate`。

### 一个副作用要知道

`conversations.integration.test.ts` 的探针现在打 `experience.chat_history`。
**099 在 test 提交之前，这个集成测试会一直 skip**（本地跑就是 `目标库不可用`）。
这是对的：它本来就是要验割接后的形态。批次 B 提交 099 之后它才会真正跑起来。

---

## 五、未收口的漂移与坑

1. **`charge_voice_usage`**  
   只在 test。仓库无迁移、无调用方；生产没有。写 `user_wallets` / `wallet_ledger`，按地图归 billing。099 已按可选处理。来源不明，**不要在 099 里顺手删或补进仓库当正式 RPC**，另开评审。取证脚本：`ops/schema-split/probe-charge-voice-usage.sql`。

2. **生产 097 不能现在跑**  
   生产跑的是 `origin/main`，`chat-history-logger.ts` 仍写 `llm_model_markup`。先发停写这三列的代码，确认不再写入，再执行 097。

3. **代码适配（已完成，见 §四之二）**

4. **数据层 `miniapp.*`**  
   除 `personas.sql_text` 外，`runtime_config` / `config_drafts` / `config_releases` 为 0。`audit_logs.schema_name = 'miniapp'` 是历史审计，不改。

5. **生产独有、099 只改限定名**  
   `public.compute_daily_metrics` 函数体含 `miniapp.*`；`miniapp_analytics` 生产有基表 `card_position_snapshot` + 一批视图，test 只有 `funnel_stats`。视图依赖按 OID 跟随，postflight 会 `SELECT 1 … LIMIT 0`。

---

## 六、新窗口接着做（顺序不要跳）

批次 A 已完成（§一）。§6.0 已审过。**下一步是批次 B。**

### 6.0 先审（人的活，不要跳过）

按执行计划 §五 批次 A 的交付门，099 与回滚脚本必须经人工审阅才能对任何库提交。建议审这几处：

- 099 §0 与回滚脚本 §0 的三张映射表**逐行一致**（两边都靠「集合不符就停」互相兜着，但先看一眼更省事）；
- 099 §5 的三类文本改写（限定名 / 审计字面量 / `search_path`）与回滚脚本 §4 的三条反向；
- 回滚脚本的 `DROP SCHEMA ... RESTRICT` 四句，以及它前面 §1.4 的「新 schema 里不许有映射外对象」；
- 三个事务外脚本的「回滚」小节，尤其生产 PostgREST 那条是 `RESET` 而不是写回旧列表。

**审查记录（2026-08-26）**：上列四项全部通过，无阻断，可以进批次 B。不必重审，除非又改了 099 / 回滚 / 三份事务外脚本。观察（不挡提交）：

- 099 可选函数缺席时只从 `_split_fn` 删、不从 `_split_name` 删；回滚两边都删。生产没有 `charge_voice_usage` 时，正向若误改了某段 `miniapp.charge_voice_usage` 文本，回滚不会改回去。仓库与生产都无调用方，实际不会碰到。
- cron job 5 的「回滚」小节没有正向 step 2 那条「恰好命中 1 次」断言，靠正向已经把它收成 1 次。
- 回滚脚本文首把「四 schema 099 前不存在」写成 §1.4，正文里对应的是 099 §1.7。

### 6.1 批次 B：test 割接演练

按执行计划 §五 批次 B 做，顺序不要变：

1. 记录 test 迁移前对象快照与关键行数（`bash ops/schema-split/run-inventory.sh test`）；
2. 提交执行 099（**这一步之后 test 就是新形态了，退路只有回滚脚本**）；
3. `psql "$TEST_POOL_URL" -f ops/schema-split/postgrest-expose-test.sql`，按脚本 step 4 用 REST 实测；
4. 部署适配新 schema 的 test 后端与相关前端；
5. 跑 typecheck / 单测 / build、MVP regression 全量、数据库集成测试
   （`conversations.integration.test.ts` 这时才会真跑，不再 skip）、真机或等价 API smoke；
6. 核对行数、视图可查、FK / trigger / function / grants / owner；
7. 全仓库与库内函数体复查，运行时 `miniapp.*` 必须为零。

记录 099 的实际执行耗时，那是生产维护窗口的定长依据。

### 6.2 之后

批次 C（生产）前置仍是「先发停写死列的代码 → 确认停写 → 执行 097」，见 §二。本窗口不做。

### 空跑命令

```bash
bash ops/schema-split/dryrun-099.sh test            # 只验正向
bash ops/schema-split/dryrun-099-roundtrip.sh test  # 正向 + 回滚，同事务内跑完再 ROLLBACK
```

改过 099 正文或回滚脚本之后，跑**往返**那条，别只跑正向。

连接：`run-inventory.sh` / `dryrun-099.sh` / `dryrun-099-roundtrip.sh` 都读 `.env.schema-split`。缺文件就停，不要把生产密码写进 shell 历史。

---

## 七、不要做的事

- 不要改 `miniapp_traffic` / `miniapp_analytics` 的名称和内部设计。
- 不要借 099 改业务行为、顺手删 `public` 残留函数、顺手清 anon 表级授权。
- 不要把 `.env.schema-split` 提交进 git。
- 不要在生产空跑 099（会拿 22 张表的 ACCESS EXCLUSIVE 锁直到 ROLLBACK）。往返空跑锁得更久。
- 不要只改 099 或只改回滚脚本的映射表——两边必须同时改，然后跑往返空跑。
- 不要用批量字符串替换收口代码里的 `miniapp.*`：同一文件常同时碰 core / features / billing，
  §四之二 里那四个跨域文件就是例子。
- 上游 merge 冲突时不要改 main 引进的行为。
- **test 已是新形态**，不要再往 test 上跑 `dryrun-099.sh` / `dryrun-099-roundtrip.sh`——
  它们的 preflight 要求起点是 `miniapp` 还在，现在会直接被断言挡下（这是对的，不是坏了）。

---

## 八、批次 B：test 割接演练记录（2026-08-26）

### 8.1 结果

| 交付门项（执行计划 §五 批次 B） | 状态                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| 迁移前快照与关键行数            | ✅ `ops/schema-split/snapshots/2026-08-26-pre099/test/`               |
| 执行 099                        | ✅ 18:19 提交，**8.92 秒**（含 psql 启动与全部 preflight/postflight） |
| PostgREST 暴露 + 热重载         | ✅ 10 个 schema，REST 实测 8 个域全 200                               |
| TypeScript / 单测 / build       | ✅ 5 包全绿；backend **321 passed / 0 skipped**                       |
| MVP regression 全量             | ✅ 7 / 7                                                              |
| 数据库集成测试                  | ✅ 之前 skip 的 13 项这次真跑并通过                                   |
| 对象形态与行数核对              | ✅ 见 8.3                                                             |
| 全仓库 + 库内零 `miniapp.*`     | ✅ 见 8.4                                                             |
| 部署 test 后端 + 真机/API smoke | ⬜ 待部署                                                             |

**割接耗时 8.92 秒**是生产维护窗口的定长依据的一半——另一半是部署耗时，等这次部署实测。
注意 test 的 `chat_history` 只有 1028 行、生产 21.8 万行 / 11 GB，但 `SET SCHEMA` 只改
`pg_class.relnamespace`，不重写数据，所以体量不进耗时；生产的额外时间应该只花在拿锁上。

### 8.2 执行顺序（照做即可复现）

```bash
SNAP_DATE=2026-08-26-pre099 bash ops/schema-split/run-inventory.sh test
psql "$TEST_POOL_URL" -X -v ON_ERROR_STOP=1 -f packages/shared/migrations/099_schema_split_phase1.sql
psql "$TEST_POOL_URL" -X -v ON_ERROR_STOP=1 -f ops/schema-split/postgrest-expose-test.sql
# 按 postgrest-expose-test.sql 的 step 4 用 curl 实测 hint 与各域可达性
pnpm -r --if-present test && pnpm --filter @miniapp/backend mvp:regression
pnpm -r typecheck && pnpm lint && pnpm -r --if-present build
SNAP_DATE=2026-08-26-post099 bash ops/schema-split/run-inventory.sh test
```

### 8.3 迁前 / 迁后核对

**行数**：22 张表里 21 张分毫不差，且都落在映射指定的域。唯一变动是
`llm_usage_charge_dedup` +7——已取证是我在两次快照之间跑的那轮 MVP regression 留下的
幂等墓碑（7 行全属回归测试用户 `6a942fe8…`，写入时间 18:21–18:22 晚于 099 的 18:19，
该用户已被 fixtures 清理删掉、墓碑按设计保留）。**与 099 无关**，顺带证明了 billing 域可写。
下次演练想要干净的行数对照，就在 099 提交后、跑测试前先取一次快照。

**结构**（把新域名归一回 `miniapp` 后逐行比对快照）：

| 项       | 结果                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 约束     | 176 行，归一后完全一致                                                                  |
| 索引     | 114 行，归一后完全一致                                                                  |
| 表授权   | 141 行，归一后完全一致（表级 ACL 随表移动，含 anon/authenticated 的存量残留）           |
| 触发器   | 11 个，把**触发器函数**的域也归一后完全一致                                             |
| 视图定义 | 5 个，去掉 `def_refs_miniapp` 列后完全一致；该列迁前全 `t`、迁后全 `f`                  |
| 跨域 FK  | 8 → 29（原 8 条一条没少）。22 张表散到四个域，原本 miniapp 内部的 FK 变成跨域，符合预期 |

**对象落位**：`miniapp` 0 表 0 函数；app_core 4 表 / 2 函数，miniapp_features 6 / 6，
experience 3 表 + 1 视图 / 5 函数，billing 7 / 12（11 + 可选的 `charge_voice_usage`），
cs_platform 收到 `support_conversations` / `support_messages`。

**权限**：四个新域 owner = postgres、ACL 只有 `service_role=U`，与 `miniapp` 现状逐字一致；
`anon` / `authenticated` 在四个域上 USAGE 均为 `f`（这是刻意的，见 §四）。搬迁对象 owner 仍全为 postgres。

**OID 跟随的实证**：5 条 `cs_platform.* → users` 的外部 FK 全部自动指向 `app_core.users`；
5 个视图全部可查，包括跨域的 `cs_platform.user_metrics` / `miniapp_traffic.traffic_daily_stats` /
`miniapp_analytics.funnel_stats`。

**人群规则**：8 / 8 通过 `cs_platform.validate_persona_sql`（它内部 EXPLAIN，等于验了新表名解析），
改写后的 SQL 正确跨 `app_core` + `billing`。

### 8.4 零残留

库内：`pg_proc.prosrc` 0 处、`pg_get_viewdef` 0 处、`cs_platform.personas.sql_text` 0 条引用 `miniapp.*`。  
仓库：只剩 `lib/supabase.ts` 的一句说明性注释，以及 `sse.test.ts` / frontend 的
`https://miniapp.example` / `https://miniapp.local`——那是 URL，不是 schema。

### 8.5 剩下的

1. 部署适配新 schema 的 test 后端（Railway），**记录部署耗时**；
2. 部署完跑真机或等价 API smoke：登录/建用户、角色卡列表、建会话/发消息/重生成/历史分页、
   钱包余额/扣费/充值/签到、收藏/许愿/通知、客服、admin 角色卡与公告、CS 关键查询；
3. smoke 过了批次 B 才算完整通过，然后才进批次 C 前置（生产发停写死列的代码 → 确认 → 执行 097）。

出问题就跑 `packages/shared/migrations/099_schema_split_phase1_rollback.sql`，
再执行 `ops/schema-split/postgrest-expose-test.sql` 的「回滚」小节，然后部署旧代码。
