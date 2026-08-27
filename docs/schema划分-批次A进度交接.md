# Schema 划分 · 批次进度交接（A / B / C0–C1 已完成，C2/C3 待启动）

> 日期：2026-08-27（C0 停写热修与生产 097 已收口）  
> 分支：schema 适配代码在 `origin/dev`（PR #288，`73627ba`）。生产 `main` 已含停写热修 PR #292（合并提交 `fd6533d`），**不含** schema 切换。  
> 本文件给新窗口接着干。权威归属与执行纪律仍以下面三份为准，本文只记**做到哪、下一步做什么、不要重问什么**。
>
> **新窗口从这里开始读：§一 状态 → §九 C2/C3。** 不要重做 C0/C1（记录在 §十）。
>
> 文件名沿用 `批次A`（其它文档按路径引用它），内容已覆盖批次 B（§八）、C 前置（旧 §九）和 C0/C1 收口（§十）。

必读：

1. `docs/schema划分-一阶段执行计划.md` — 批次、割接、验证、回滚
2. `docs/schema归属地图.md` — 表和函数归属
3. `docs/schema划分专项.md` — 表盘点与 `chat_history` 字段审计
4. `ops/schema-split/snapshots/2026-08-25/批次A-双库基线与差异.md` — 双库实测基线
5. `docs/fix-postgrest-schema-exposure.md` — 动 PostgREST 时再读

---

## 一、一句话状态

**批次 A、B 已收口；批次 C 的 C0（停写热修）与 C1（生产 097）已完成。硬阻断已解除。**

下一步只剩 **C2 准备完整 schema 代码（先不合 `main`）→ C3 维护窗口跑 099 → 再部署新代码**。路径见 **§九**。

099 已于 2026-08-26 18:19 在 **test 提交执行**（耗时 8.92 秒），PostgREST 暴露列表已切换，
test 库现在是新形态：`miniapp` 空壳，22 表 + 1 视图 + 25 函数分布在五个域里。
新代码已随 PR #288 合入 `dev` 并部署到 Railway `development`，2026-08-27 独立跑过 API smoke（§8.6）。
回滚脚本已重新验证可用（§8.7）。

生产（2026-08-27 晚实测）：

- Railway `stminiapp` production 跑 `fd6533d`（PR #292），代码仍读 `miniapp.*`
- 097 已提交：`chat_history` / `current_chat_history` 均为 29 列；触发器与旧索引已没
- 099 **未执行**；无新域、无 FDW；22 表 + 1 视图 + 25 函数仍在 `miniapp`
- **不要把 `origin/dev` 的 schema 适配代码合入 `main`。** production 跟随 `main` 自动部署，099 之前会立刻 `schema/relation not found`

批次 A 的交付门（执行计划 §五 批次 A）四项都齐了：

| 交付门项                 | 状态                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| 代码可构建               | ✅ 5 包 typecheck / lint / build 全绿                                         |
| 单测                     | ✅ shared 55 + backend 308 + frontend 56 + admin 41，0 失败                   |
| 099 preflight 能阻止漂移 | ✅ 对象集合、函数集合、search_path 名单、目标 schema 不存在、类型残留逐项断言 |
| 099 与回滚脚本经人工审阅 | ✅ 2026-08-26 按 §6.0 四项审过，无阻断，见该节审查记录                        |

---

## 二、已拍板、不要重开讨论

| 项                     | 决定                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生产 097 顺序          | **已执行完 C0/C1。** 不能把整个 `dev` 提前发到生产。完整 schema 代码只在 099 + PostgREST + cron 之后部署。C2 的 PR **不要 merge**（production 跟 `main` 自动部署）。详见 §九 / §十 |
| `preset_id`            | 照原样删，接受丢失。123,574 行 ST 存量有值，但 `st_platform.platform_presets` 已随 088 消失，引用无法解析                                                                          |
| test `characters` 三列 | 单独 098，不塞进 099。已在 test 执行                                                                                                                                               |
| 函数 EXECUTE           | 按 prod 收敛，不授 `anon` / `authenticated`                                                                                                                                        |
| `public` 残留函数      | 099 只改限定名、不改行为；是否删除另开评审                                                                                                                                         |
| PostgREST              | 用 GUC 接管；列表必须先含现有 `miniapp_analytics` / `cs_platform`，再追加新域                                                                                                      |
| `aiero` schema         | 无关，永久排除                                                                                                                                                                     |
| 分支                   | schema 适配在 `origin/dev`（PR #288）。生产跟 `main` 自动部署。C2 只开 PR、**不合**；合入放到 C3 第 7 步                                                                           |
| 编号                   | 097 = chat_history 三列（原 092）；098 = characters 死列；099 = schema 划分                                                                                                        |
| 生产割接               | 低峰短停机硬切，不做兼容视图 / RPC wrapper                                                                                                                                         |

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

| 文件                                                                 | 库状态                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/migrations/097_chat_history_drop_dead_columns.sql`  | **test 已执行**（当时编号还是 092，全程 `IF EXISTS`）。**生产已执行**（2026-08-27 13:00:39–13:00:45 UTC，约 6 秒，见 §十） |
| `packages/shared/migrations/098_characters_drop_st_sync_columns.sql` | **test 已执行**，`characters` 31 列 → 28 列。生产是 no-op                                                                  |
| `packages/shared/migrations/099_schema_split_phase1.sql`             | 已写完。**test 已提交**（2026-08-26 18:19，8.92 秒）。**生产未执行**                                                       |
| `packages/shared/migrations/099_schema_split_phase1_rollback.sql`    | 已写完。test 往返空跑 + 2026-08-27 事务内 ROLLBACK 验证通过。**生产未执行**                                                |

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

2. **生产 097（已完成，见 §十）**  
   硬阻断已解除：停写热修 PR #292 已上生产，097 已提交。**新的硬约束**是不要在 099 之前把 `dev` 的 schema 适配合入 `main`（production 自动部署）。

3. **代码适配（已完成，见 §四之二）**

4. **数据层 `miniapp.*`**  
   除 `personas.sql_text` 外，`runtime_config` / `config_drafts` / `config_releases` 为 0。`audit_logs.schema_name = 'miniapp'` 是历史审计，不改。

5. **生产独有、099 只改限定名**  
   `public.compute_daily_metrics` 函数体含 `miniapp.*`；`miniapp_analytics` 生产有基表 `card_position_snapshot` + 一批视图，test 只有 `funnel_stats`。视图依赖按 OID 跟随，postflight 会 `SELECT 1 … LIMIT 0`。

---

## 六、新窗口接着做（顺序不要跳）

批次 A、B、C0、C1 已完成（§一 / §八 / §十）。§6.0 已审过。**下一步是 §九 的 C2/C3，不要重做批次 B 或 C0/C1。**

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

批次 B 已于 2026-08-27 收口（§8.6 / §8.7）。C0/C1 已于同日收口（§十）。下一步是 **§九 的 C2/C3**。

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
  它们的正向 preflight 要求起点是 `miniapp` 还满，现在会直接被断言挡下（这是对的，不是坏了）。
  只验回滚时：把回滚脚本末尾 `COMMIT` 换成 `ROLLBACK` 再跑，原文件不动。
- **不要把当前整个 `dev` 合入 `main` 或部署到生产。** 生产库仍是 `miniapp.*`，`dev` 已经读新 schema，会立刻 500。
  production 的 Railway `stminiapp` 跟随 GitHub `main` 自动部署，合 `main` 就是发生产。C2 的 PR 先挂着，合入放到 C3 第 7 步。

---

## 八、批次 B：test 割接演练记录（2026-08-26）

### 8.1 结果

| 交付门项（执行计划 §五 批次 B） | 状态                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| 迁移前快照与关键行数            | ✅ `ops/schema-split/snapshots/2026-08-26-pre099/test/`                 |
| 执行 099                        | ✅ 18:19 提交，**8.92 秒**（含 psql 启动与全部 preflight/postflight）   |
| PostgREST 暴露 + 热重载         | ✅ 10 个 schema，REST 实测 8 个域全 200                                 |
| TypeScript / 单测 / build       | ✅ 5 包全绿；backend **321 passed / 0 skipped**                         |
| MVP regression 全量             | ✅ 7 / 7                                                                |
| 数据库集成测试                  | ✅ 之前 skip 的 13 项这次真跑并通过                                     |
| 对象形态与行数核对              | ✅ 见 8.3                                                               |
| 全仓库 + 库内零 `miniapp.*`     | ✅ 见 8.4                                                               |
| 部署 test 后端 + 真机/API smoke | ✅ 2026-08-27 PR #288 环境（Railway `pr-288` + Vercel Preview）实测通过 |

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

> 以上是 2026-08-26 的取证。2026-08-27 上午 `miniapp` 曾被库外操作重建 6 张副本表
> （§8.7），同日晚间已按授权 `DROP`，`miniapp` 再次为空壳。代码侧零残留仍然成立。

### 8.5 批次 B 收口

交付门已全部满足，批次 B 结束。后续工作见 §九。

test 出问题就跑 `packages/shared/migrations/099_schema_split_phase1_rollback.sql`，
再执行 `ops/schema-split/postgrest-expose-test.sql` 的「回滚」小节，然后部署旧代码。
该脚本已于 2026-08-27 重新验证可用（§8.7）。

### 8.6 环境 smoke：PR #288 与合并后的 dev（2026-08-27）

**PR #288 环境**：Railway `pr-288` 后端 + Vercel Preview 前端实测通过，五个域（`app_core` /
`experience` / `billing` / `miniapp_features` / `cs_platform`）的接口全部 200 并返回迁移后 test 库的数据。

**合并后的 dev**：PR #288 已合入 `dev`（合并提交 `73627ba`）并部署到 Railway `development`。
对 `https://stminiapp-development.up.railway.app` 独立跑过一轮等价 API smoke，覆盖
`/health`、`/api/characters`（recommended / latest，271 条）、`/api/characters/:id`、
`/api/payment/plans`、`/api/platform/models`、`/api/wallet/balance`、`/api/favorites/ids`、
`/api/notifications`、`/api/support/unread`，全部 200。删除 §8.7 那 6 张副本表之后又复跑一遍，仍全绿。

> **不要重复排查这一条**：不带 `X-Init-Data` 直接打 wallet / favorites / notifications / support
> 会返回 200 而不是 401。这不是鉴权漏洞，是 `development` 环境显式设了 `DEV_AUTH_BYPASS=1`
> （`middleware/auth.ts` 在缺 initData 时注入固定测试用户 `99999`）。CS 接口走独立鉴权，
> 所以仍然是 401。生产没有这个变量，行为不同。

过程中前端一度报「门好像被风合上了」，**与 099 无关**：Vercel Preview 的
`NEXT_PUBLIC_API_URL` 是构建期固化的，当时还指向已随 PR #287 关闭而删除的
`stminiapp-pr-287`。改成 `stminiapp-pr-288` 重新部署即好。以后 PR 换号都会踩这个。

**一个曾经误判、现已证伪的结论**：`stminiapp-development` 返回的角色卡与 `pr-288` 不同
（352 行 vs 468 行），当时据此怀疑 development 连了生产库。实际两者连的是**同一个 test 库**
（`railway-pr-env.yml` 从 `development` 复制环境，只覆盖 `source.branch` / `PORT` /
`SENTRY_ENVIRONMENT` 和两个 payment URL，数据库变量原样继承）。差异来自代码不同：
旧代码读 `miniapp.characters`、新代码读 `app_core.characters`。**不存在生产库误连。**

### 8.7 计划外 FDW（保留）与 6 张副本表（已删，回滚已恢复）

2026-08-27 发现 test 库有：

- 外部服务器 `prod_readonly`（`postgres_fdw` → `db.wbtsfzozlmurljvglhpn.supabase.co`，生产）；
- schema `miniapp_fdw`，外部表（删除副本表后复核为 23 张）；
- `miniapp` 下曾重新出现 6 张**真实表**，装生产数据副本：`characters`(352 / 29 MB)、
  `chat_history`(81000 / 3806 MB)、`character_favorites`、`character_free_chat_quotas`、
  `character_free_chat_quota_decisions`、`character_ranking_scores`。

时间与来源：2026-08-26 的 post-099 快照里 `miniapp` 为空、`miniapp_fdw` 不存在；仓库内搜不到
`prod_readonly` / `postgres_fdw` / `IMPORT FOREIGN SCHEMA`。由 099 之外的库内操作建立，不在版本控制里。
已确认是有意为之（对照 / 取数用）。

**处理（2026-08-27 晚，已授权）**：

- `prod_readonly` 与 `miniapp_fdw` **保留**。
- 6 张 `miniapp.*` 副本表在确认零依赖（0 出入 FK / 0 触发器 / 0 视图引用）后，
  于单事务内按精确集合断言 `DROP TABLE ... RESTRICT`。删后 `miniapp` 关系对象 0、函数 0。
- 失败点其实是回滚脚本 §1.2 preflight（要求 `miniapp` 空壳），不是搬迁撞名；删表后该断言满足。
- 随后把 `099_schema_split_phase1_rollback.sql` 末尾 `COMMIT` 改成 `ROLLBACK` 在 test 上完整跑通
  （preflight → 搬回 23 表/视图、25 函数 → 改回 44 个函数体 / 13 处人群规则 → `DROP` 四 schema → postflight），
  事务外复核仍是 `miniapp` 空壳、四个新域仍在。**test 回滚安全网已恢复。**
  不要用 `dryrun-099-roundtrip.sh` 验这件事——它的正向 preflight 要求起点是未迁形态，现在会挡。

生产 2026-08-27 核对：**无** `prod_readonly` / `miniapp_fdw` / 新域，22 表 + 1 视图 + 25 函数全在 `miniapp`。
C3 窗口内执行 099 前仍须再核一次，避免窗口前又被手工改过。

---

## 九、批次 C：C2 / C3（2026-08-27 晚，C0/C1 已收口）

新窗口从这里执行。权威顺序仍是执行计划 §五 批次 C 的窗口内步骤。
C0/C1 的取证见 **§十**，不要重做停写热修，也不要再跑 097。

### 9.1 当前各面状态

| 面                 | 状态                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 代码 `dev`         | PR #288 已合（`73627ba`）。Railway `development` 已部署新 schema 代码，smoke 通过（§8.6）                                         |
| 代码 `main`        | 已含停写热修 PR #292（`fd6533d`）。**不含** schema 切换（无 `getDomainDb` / Prisma 多 schema / 099）                              |
| Railway production | `stminiapp` 已部署 `fd6533d`，`/health` 200。跟随 GitHub `main` **自动部署**                                                      |
| test 库            | 099 已提交；PostgREST 已切；`miniapp` 空壳；FDW 保留；回滚脚本已事务内验证                                                        |
| production 库      | **097 已执行**。`chat_history` / `current_chat_history` 29 列。099 未执行；无新域、无 FDW；22 表 + 1 视图 + 25 函数仍在 `miniapp` |
| production 098     | **已满足**。`characters` 无 `is_default` / `is_published` / `is_active`                                                           |
| cron job 5         | 仍是 `FROM miniapp.characters`；099 之后必须跑 `ops/schema-split/cron-job5-prod.sql`                                              |

### 9.2 当前硬约束（不要踩）

097 的部署阻断已经解除。现在唯一不能做错的是：

**不要把 `origin/dev` 的 schema 适配代码合入 `main`，也不要手动 `railway up` 那份镜像。**
`.railway/railway.ts` 里 production 的 `source.branch` 是 `main`。合 `main` = 立刻把 `getDomainDb('app_core')` 发到仍是 `miniapp.*` 的生产库，会 `schema/relation not found`。

因此必须继续拆成两份制品：

1. **停写热修**（已上生产，PR #292）— 不要再发一遍；
2. **完整 schema 适配**（现 `origin/dev`）— 099 + PostgREST + cron job 5 之后才合 `main` 部署。

097 SQL 在 `origin/dev` / 本分支，**不在 `main`**。已经对生产执行过，幂等 `IF EXISTS`，不必补进 `main` 才算完成。C3 用的 099 等文件也从 `origin/dev` 取。

### 9.3 新窗口逐步做什么

**C2. 准备完整代码，但先不部署、也不要合 `main`**

1. 从 `origin/dev` 开（或更新）`dev` → `main` 的 PR，只带 schema 适配；合 main 时上游只读，见 `.cursor/rules/upstream-merge-protection.mdc`。
2. CI 全绿后 **PR 保持打开，不要 merge**。
3. 确认可回退的旧生产制品：当前健康的是 Railway deployment `da7b25ee`（commit `fd6533d`，停写热修、097 之后仍读 `miniapp.*`）。

**C3. 生产维护窗口（执行计划 §五 批次 C，顺序不要改）**

1. 发维护通知，停入口流量和后端后台任务。cron job 5 是整点跑，窗口避开 `:00`。
2. `SNAP_DATE=... bash ops/schema-split/run-inventory.sh prod`，确认无 FDW / 无新域 / 097 已执行（三列不在）。
3. 确认可回退的旧部署制品、回滚 SQL 执行人。回滚文件：
   `packages/shared/migrations/099_schema_split_phase1_rollback.sql`。
4. `psql "$PROD_DIRECT_URL" -X -v ON_ERROR_STOP=1 -f packages/shared/migrations/099_schema_split_phase1.sql`
   失败则事务自动回滚，停下来，不要现场改 SQL。
   文件从 `origin/dev` 取，不要用 `main` 上没有的路径瞎找。
5. 先按 `ops/schema-split/postgrest-expose-prod.sql` 文首 **step 0 重新实测** 平台层暴露列表，
   再执行该文件（GUC 会**整体覆盖**平台层，漏写 `miniapp_analytics` / `cs_platform` 会掉线）。
6. `psql "$PROD_DIRECT_URL" -X -v ON_ERROR_STOP=1 -f ops/schema-split/cron-job5-prod.sql`
7. **这时才**把 C2 的 PR 合入 `main`，等 Railway production 部署完整新 schema 代码。
8. 最小上线验证（执行计划 §五 批次 C 那份清单）后恢复流量。
9. 下一个整点回来看 cron job 5 的 `cron.job_run_details`，期望 `succeeded`。

**不要**在生产跑 `dryrun-099.sh` / `dryrun-099-roundtrip.sh`（会拿 22 张表 ACCESS EXCLUSIVE 直到 ROLLBACK）。

### 9.4 连接与脚本

- 连接：仓库根 `.env.schema-split`（`TEST_POOL_URL` / `PROD_DIRECT_URL` / `PROD_SUPABASE_URL` 等）。不要写进 shell 历史。
- test 项目 ref `zoqelpfhurwehlvypryl`；prod `wbtsfzozlmurljvglhpn`。脚本里有 ref 闸。
- 生产 PostgREST 回滚是 `ALTER ROLE authenticator RESET pgrst.db_schemas`，不是手抄旧列表。

### 9.5 新窗口开工指令

> 前置阅读：`docs/schema划分-批次A进度交接.md` §一、§九，以及它列出的权威文档。C0/C1 记录在 §十，不要重做。
>
> 批次 A/B/C0/C1 已完成。生产 097 已执行，停写热修已在 `main`（PR #292，`fd6533d`）。
> **不要**把 `dev` 的 schema 适配代码合入 `main` 或部署到生产——Railway production 跟随 `main` 自动部署。
> 下一步：按 §9.3 做 C2（`dev` → `main` PR，CI 绿了先挂着）→ 进维护窗口跑 C3（099 → PostgREST → cron job 5 → 再合 PR 部署）。
> 保留上游行为，不改 `miniapp_traffic` / `miniapp_analytics` 的名称和内部设计。

---

## 十、批次 C 前置：C0 / C1 执行记录（2026-08-27）

不要重做本节。新窗口直接进 §九。

### 10.1 C0 停写热修

从当时的 `origin/main`（`ee9711c`）开 `hotfix/chat-history-stop-dead-columns`，只带 §9.2 旧文列出的运行时停写，外加 `conversation-context.test.ts` 去 `preset_id` 以免类型不过。

**刻意没带**：`getDomainDb` / Prisma 多 schema / 099、`8ecee42` 里的 lobby 注释、sync-job（`llm_usage_cache` 行为变更）、mvp-regression fixtures、097 SQL。

PR https://github.com/linshu368/ST_miniapp/pull/292 ，CI Quality Gate / Docker backend / Vercel 全绿后合入 `main`（合并提交 `fd6533d`）。

Railway `stminiapp` production 自动部署 `da7b25ee`，commit `fd6533d`，status SUCCESS。`/health` 200。

部署后、097 前只读抽查 `miniapp.chat_history`（`created_at >= 2026-08-27 12:56:51+00`）：5 行全是 `success`，都有 `session_id` / `llm_charge_id`；`preset_id`、`llm_model_markup` 均为空。

### 10.2 C1 生产 097

执行前消费方复核（与 097 文首预期一致）：

- 函数：仅 `miniapp.tf_set_user_character_round`
- 视图：仅 `miniapp.current_chat_history`
- cron：0 条

文件：`packages/shared/migrations/097_chat_history_drop_dead_columns.sql`（与 `origin/dev` 同内容，checksum `bbdb1cdf`）。`main` 上没有这个文件，从本分支执行。

```
psql "$PROD_DIRECT_URL" -X -v ON_ERROR_STOP=1 -f packages/shared/migrations/097_chat_history_drop_dead_columns.sql
```

提交时间：2026-08-27 **13:00:39–13:00:45 UTC**（约 6 秒）。`BEGIN` … `COMMIT` + `NOTIFY pgrst` 均成功。

验证节：

| 项                                           | 结果                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| 三列                                         | 0 行（`preset_id` / `llm_model_markup` / `user_character_round` 均不在） |
| 触发器 `trg_set_user_character_round`        | 0                                                                        |
| 索引 `idx_chat_history_character_user_round` | 0                                                                        |
| `chat_history` 列数                          | 29                                                                       |
| `current_chat_history` 列数                  | 29，可 `SELECT`                                                          |

097 之后新行（`created_at >= 2026-08-27 13:00:45+00`）：至少 2 条 `success`，有 `session_id` / `llm_charge_id` / `llm_intended_deduction`。删列没有把对话写挂。生产 `/health` 仍 200。
