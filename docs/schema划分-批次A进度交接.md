# Schema 划分 · 批次进度交接（A / B / C0–C3 全部完成，一阶段已上生产）

> 日期：2026-08-28（**C3 生产割接已完成**，见 §十二）  
> 分支：`main` 已含完整 schema 适配（PR #294 合并提交 `f7295a6`）。生产库已是新形态。  
> **一阶段割接到此结束。** 剩下的是两个遗留运维项，见 §12.7——其中「生产 Railway source 被临时固定到 GHCR 镜像」会让 `main` 不再自动部署生产，**下一次改后端前必须先处理**。
>
> **新窗口从这里开始读：§一 状态 → §十二 C3 记录 → §12.7 遗留项。**
> 不要重做 C0/C1（§十）、C2（§十一）或 C3（§十二）。
>
> 文件名沿用 `批次A`（其它文档按路径引用它），内容已覆盖批次 B（§八）、C 前置（旧 §九）、C0/C1（§十）、C2（§十一）和 C3（§十二）。

必读：

1. `docs/schema划分-一阶段执行计划.md` — 批次、割接、验证、回滚
2. `docs/schema归属地图.md` — 表和函数归属
3. `docs/schema划分专项.md` — 表盘点与 `chat_history` 字段审计
4. `ops/schema-split/snapshots/2026-08-25/批次A-双库基线与差异.md` — 双库实测基线
5. `docs/fix-postgrest-schema-exposure.md` — 动 PostgREST 时再读

---

## 一、一句话状态

**批次 A、B、C0、C1、C2、C3 全部完成。schema 划分一阶段已在生产落地。**

生产割接于 **2026-08-28 10:25–11:05（北京）** 完成，099 本身耗时 **9.435 秒**，
API 停机约 **38 分钟**（超出预算的部分全花在 Railway 构建卡死上，见 §12.5）。取证见 **§十二**。

生产现状（2026-08-28 实测）：

- 库：`miniapp` 空壳；22 表 + 1 视图 + 24 函数分布在 app_core / miniapp_features /
  experience / billing / cs_platform 五个域；库内 `miniapp.*` 残留三项全 0
- PostgREST：`authenticator` 的 `pgrst.db_schemas` GUC 已接管，10 个 schema 全部 REST 可达
- pg_cron job 5：已指向 `app_core.characters`，jobid 未变，11:00 那次 `succeeded`
- 代码：`main` = `f7295a6`（PR #294），三个 Railway 生产服务都跑新代码
- 真实用户流量已在新 schema 上跨 experience / billing / app_core 正常读写

**两个遗留项见 §12.7**，尤其：生产 `stminiapp` 的 Railway source 目前**固定在 GHCR 镜像**
`sha-a27ed29`，不再跟随 `main` 自动部署。

test 库同样是新形态（099 于 2026-08-26 18:19 提交，8.92 秒），回滚脚本已验证可用（§8.7）。

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
| 分支                   | schema 适配在 `origin/dev`（PR #288 + 上游 `main` 合并 `b16f8df`）。生产跟 `main` 自动部署。C2 的 PR #294 只开、**不合**；合入放到 C3 第 7 步                                      |
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

批次 A、B、C0、C1、C2 已完成（§一 / §八 / §十 / §十一）。§6.0 已审过。**下一步只剩 §9.3 的 C3，不要重做批次 B 或 C0/C1/C2。**

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

批次 B 已于 2026-08-27 收口（§8.6 / §8.7）。C0/C1（§十）与 C2（§十一）已于同日收口。下一步是 **§9.3 的 C3**。

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
- **099 跑完之前不要 merge PR #294，也不要手动把这份镜像部署到生产。** 生产库仍是 `miniapp.*`，
  `dev` 已经读新 schema，会立刻 500。production 的 Railway `stminiapp` 以及两个支付 cron 服务
  都跟随 GitHub `main` 自动部署，合 `main` 就是发生产。合入放到 C3 第 7 步。
  往 `dev` 推代码是安全的（`development` 环境才跟 `dev`，§11.4 已实测）。

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

生产 2026-08-27 核对：**无** `prod_readonly` / `miniapp_fdw` / 新域，22 表 + 1 视图 + 24 函数全在 `miniapp`。
C3 窗口内执行 099 前仍须再核一次，避免窗口前又被手工改过。

---

## 九、批次 C：C3 的执行计划（**已于 2026-08-28 执行完毕，本节转为历史**）

> **本节是 C3 执行前写的计划，已全部执行完，实际取证见 §十二。**
> 保留原文是为了对照「计划 vs 实际」——§12.5 / §12.6 记了两处与本节不符的地方
> （cron job 5 的 `UPDATE` 权限不足、Railway 构建卡死）。
> 本节里所有「不要 merge PR #294」「不要合入 main」的禁令**已经解除**，不要再照着执行。

C0/C1 的取证见 **§十**、C2 的见 **§十一**、C3 的见 **§十二**。

### 9.1 当前各面状态

| 面                    | 状态                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代码 `dev`            | 已含 PR #288（`73627ba`）与上游 `main`（合并提交 `b16f8df`）。Railway `development` 已部署合并后代码，smoke 通过（§11.4）                                  |
| 代码 `main`           | 停在停写热修 PR #292（`fd6533d`）。**不含** schema 切换（无 `getDomainDb` / Prisma 多 schema / 099）                                                       |
| C2 的 PR              | [#294](https://github.com/linshu368/ST_miniapp/pull/294) `dev` → `main`，CI 绿，**保持打开不要 merge**；合入是 C3 第 7 步                                  |
| Railway production    | `stminiapp` 已部署 `fd6533d`，`/health` 200。跟随 GitHub `main` **自动部署**                                                                               |
| Railway 生产 cron × 2 | `stminiapp-payment-reconcile-cron`（每分钟）、`stminiapp-payment-cron`（每 5 分钟）也跟随 `main`，都读 `payment_orders`。**C3 第 1 步必须先停，见 §11.3**  |
| test 库               | 099 已提交；PostgREST 已切；`miniapp` 空壳；FDW 保留；回滚脚本已事务内验证                                                                                 |
| production 库         | **097 已执行**。`chat_history` / `current_chat_history` 29 列。099 未执行；无新域、无 FDW；22 表 + 1 视图 + 24 函数仍在 `miniapp`                          |
| production 098        | **已满足**。`characters` 无 `is_default` / `is_published` / `is_active`                                                                                    |
| production 100        | **已执行**（上游 PR #290/#291 带来，不是本专项做的）。`miniapp.payment_orders` 现 16 列，多 4 个对账列 + 索引 `idx_payment_orders_due_reconcile`，见 §11.2 |
| cron job 5            | 仍是 `FROM miniapp.characters`；099 之后必须跑 `ops/schema-split/cron-job5-prod.sql`                                                                       |

### 9.2 当前硬约束（不要踩）

097 的部署阻断已经解除。现在唯一不能做错的是：

**在 099 跑完之前不要 merge PR #294，也不要手动 `railway up` 那份镜像。**
`.railway/railway.ts` 里 production 的 `source.branch` 是 `main`。合 `main` = 立刻把 `getDomainDb('app_core')` 发到仍是 `miniapp.*` 的生产库，会 `schema/relation not found`。
同一份 `main` 还喂着两个支付 cron 服务，它们会跟着一起换代码。

因此必须继续拆成两份制品：

1. **停写热修**（已上生产，PR #292）— 不要再发一遍；
2. **完整 schema 适配**（PR #294，head 是 `dev`）— 099 + PostgREST + cron job 5 之后才合 `main` 部署。

往 `dev` 推代码不会碰生产：`development` 环境的 `source.branch` 是 `dev`。§11.4 已实测过一次（推 `dev` 之后生产仍是 `fd6533d`、`/health` 与角色卡接口照常 200）。

097 SQL 在 `origin/dev`，**不在 `main`**。已经对生产执行过，幂等 `IF EXISTS`，不必补进 `main` 才算完成。C3 用的 099 等文件也从 `origin/dev` 取。

### 9.3 新窗口逐步做什么

**C2 已完成（2026-08-27 晚，取证见 §十一）**：`dev` 已合上游 `main`（`b16f8df`），
PR [#294](https://github.com/linshu368/ST_miniapp/pull/294) 已开、CI 绿、挂着不合。
可回退的旧生产制品是 Railway deployment `da7b25ee`（commit `fd6533d`，停写热修、097 之后仍读 `miniapp.*`）。

**C3 窗口前检查（进窗口前先做完，别在停服之后才发现）**

C2 收口于 2026-08-27，窗口定在 2026-08-29 10:05，中间隔着一天多，`main` 可能又进了 hotfix。
所以开窗口前先过这三条：

1. `git fetch origin && git log --oneline origin/dev..origin/main` —— 有输出就说明 `main` 有新东西没进 `dev`；
2. 有的话，在 `dev` 上重新 `git merge origin/main`（上游只读，见
   `.cursor/rules/upstream-merge-protection.mdc`），推 `dev`，**等 PR #294 的 CI 重新绿**。
   顺手看一眼新 hotfix 有没有引入 `.schema('miniapp')` 或 `miniapp.` 字面量——
   §11.2 就是这么发现上游支付对账那一批的；
3. `gh pr view 294 --json state,mergeStateStatus` —— 期望 `OPEN` + `CLEAN`。
   `UNSTABLE` 先看是哪项检查没过，`DIRTY` 说明有冲突，都要在停服之前解决。

第 2 条如果触发了，别忘了同步更新 §11.4 的验证记录，并考虑重跑一次
`pnpm --filter @miniapp/backend mvp:regression`（它用本地假上游，约 90 秒，不花钱）。

**C3. 生产维护窗口（执行计划 §五 批次 C，顺序不要改）**

1. 发维护通知，停入口流量和后端后台任务。**具体停什么、不停什么见 §9.4，不要笼统地「停所有生产服务」。**
2. `SNAP_DATE=... bash ops/schema-split/run-inventory.sh prod`，确认无 FDW / 无新域 / 097 已执行（三列不在）。
   `payment_orders` 应是 16 列（100 已执行，见 §11.2），这是对的，不要当漂移处理。
3. 确认可回退的旧部署制品、回滚 SQL 执行人。回滚文件：
   `packages/shared/migrations/099_schema_split_phase1_rollback.sql`。
4. `psql "$PROD_DIRECT_URL" -X -v ON_ERROR_STOP=1 -f packages/shared/migrations/099_schema_split_phase1.sql`
   失败则事务自动回滚，停下来，不要现场改 SQL。
   文件从 `origin/dev` 取，不要用 `main` 上没有的路径瞎找。
5. 先按 `ops/schema-split/postgrest-expose-prod.sql` 文首 **step 0 重新实测** 平台层暴露列表，
   再执行该文件（GUC 会**整体覆盖**平台层，漏写 `miniapp_analytics` / `cs_platform` 会掉线）。
6. `psql "$PROD_DIRECT_URL" -X -v ON_ERROR_STOP=1 -f ops/schema-split/cron-job5-prod.sql`
7. **这时才**把 PR #294 合入 `main`，等 Railway production 部署完整新 schema 代码。
   同一次合入也会给两个支付 cron 服务换上按域访问的代码，第 1 步停掉的它们要在这之后才恢复。
8. 最小上线验证（执行计划 §五 批次 C 那份清单）后恢复流量，并恢复两个支付 cron 服务。
   恢复后看一眼各自下一次运行的日志：`reconcile-payment-orders` 期望打印
   `Fast payment reconciliation: checked=…`，不是 `failed`。
9. 下一个整点回来看 cron job 5 的 `cron.job_run_details`，期望 `succeeded`。

**不要**在生产跑 `dryrun-099.sh` / `dryrun-099-roundtrip.sh`（会拿 22 张表 ACCESS EXCLUSIVE 直到 ROLLBACK）。

### 9.4 C3 窗口停什么、不停什么

判据只有两条，别按「保险起见全停」来做：

- **锁**：099 的几秒内要拿 22 张表的 ACCESS EXCLUSIVE。谁在那一刻持有或请求这些表的锁，就会与它互相排队——
  尤其是长事务，能把 test 实测 8.92 秒拖成不定长。
- **旧代码空窗**：099 提交后到第 7 步部署完（合 PR + Railway 构建部署，几分钟），
  旧代码读 `miniapp.*` 必然失败。

**必须停：**

| 对象                                                 | 为什么                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway `stminiapp`（backend API）                   | **不只是挡流量。**进程内有两个 `setInterval`（`app.ts` 启动时注册）：`chat-history-sync-job` 每 30 秒读写 `chat_history`；`lobby-ranking-refresh-job` 每 24 小时**整轮包在一个事务里**从 `chat_history` 聚合重写 `character_ranking_scores`。后者触发时刻取决于上次部署时间，撞上就是长事务顶住 099 |
| Railway `stminiapp-payment-reconcile-cron`（每分钟） | 可能正握着 `payment_orders` 的锁。失败本身无害（log + `exit 1`，`restartPolicyType: NEVER`，见 §11.3）                                                                                                                                                                                              |
| Railway `stminiapp-payment-cron`（每 5 分钟）        | 同上                                                                                                                                                                                                                                                                                                |
| 入口流量（前端维护页）                               | 为体验，也为了别让新对话轮次在窗口里起行                                                                                                                                                                                                                                                            |

停 `stminiapp` 有两种做法：Railway 控制台暂停/缩到 0，或把 `CHAT_HISTORY_SYNC_ENABLED`、
`LOBBY_RANKING_REFRESH_ENABLED` 置 false 再重启。**暂停服务更省事**——第 7 步合 PR 本来就会重新部署把它带回来。

**不要停：**

- **Supabase Postgres / PostgREST**：第 5 步是改 GUC 再 reload，不是停服务；停了没法按脚本 step 4 用 REST 实测。
- **库内 pg_cron**：job 5 只在整点跑，窗口避开 `:00` 即可；job 2/3 早已 inactive。不必改 `active`（少一个要记着还原的动作）。
- **Vercel 上的 admin / cs-platform / miniapp 前端**：都不直连数据库，全走 backend。挂维护页是体验问题，不是安全问题。

**两条要先确认的外部依赖：**

1. **旧 bot —— 已排除，不用再查**。2026-08-27 确认：仓库外那个旧 bot 处于不维护状态。
   099 会把 `public.compute_daily_metrics` 的函数体改写成 `experience.chat_history`，库内这侧自洽，
   不需要为它做任何额外动作。（本仓库 `.railway/railway.ts` 也只声明三个服务：backend + 两个 cron。）
2. **支付回调**。窗口里 `PAYMENT_NOTIFY_URL` 打过来会失败。缓解手段是上游刚加的快速对账：
   `payment_orders.next_reconcile_at` 会让恢复后的 cron 把未入账订单捞回来主动查单。
   所以**窗口要避开充值高峰**，而不是指望回调不丢。

**窗口时长预算（已定档 2026-08-29 10:05 开始）**

选 `:05` 起步是为了避开整点的 pg_cron job 5——下一次是 11:00，留出约 55 分钟余量。
test 实测 099 本身只有 8.92 秒，窗口的长度几乎全花在它前后：

| 段                                              | 预算       |
| ----------------------------------------------- | ---------- |
| 停服务、等在途请求排空                          | 3–5 分钟   |
| `run-inventory.sh prod` 取即时快照并核对        | 2–4 分钟   |
| 099                                             | < 1 分钟   |
| PostgREST：step 0 重新实测 + 执行 + REST 验各域 | 5–8 分钟   |
| cron job 5 脚本                                 | 1–2 分钟   |
| 合 #294 → Railway 构建 + 部署                   | 5–15 分钟  |
| 最小上线验证                                    | 10–20 分钟 |

合计**乐观 30 分钟、现实 45–60 分钟**，最大变量是 Railway 的构建部署耗时。
对外公告按 50–60 分钟报比较稳，别按 30 分钟承诺。

想压缩用户可感知的停服时长，可以把验证拆成两段：核心链路（登录 / 角色卡 / 新建会话发消息 / 钱包余额）
一过就撤维护页恢复流量，admin、CS、analytics 视图那些留在流量恢复之后继续核。
这是对交付门的排序优化，不是跳过——那份清单仍要全部走完。

### 9.5 连接与脚本

- 连接：仓库根 `.env.schema-split`（`TEST_POOL_URL` / `PROD_DIRECT_URL` / `PROD_SUPABASE_URL` 等）。不要写进 shell 历史。
- test 项目 ref `zoqelpfhurwehlvypryl`；prod `wbtsfzozlmurljvglhpn`。脚本里有 ref 闸。
- 生产 PostgREST 回滚是 `ALTER ROLE authenticator RESET pgrst.db_schemas`，不是手抄旧列表。

### 9.6 新窗口开工指令

C3 窗口已定档 **2026-08-29 10:05**（避开整点的 pg_cron job 5）。把下面整段粘进新窗口即可，
不需要额外补充背景——它引用的章节里已经有全部取证。

> 前置阅读：`docs/schema划分-批次A进度交接.md` §一、§9.1–§9.5、§十一，以及它列出的权威文档。
> 批次 A/B/C0/C1/C2 已完成，记录分别在 §八 / §十 / §十一，**都不要重做**。
>
> 生产 097 已执行；停写热修已在 `main`（PR #292，`fd6533d`）；完整 schema 适配已在
> PR [#294](https://github.com/linshu368/ST_miniapp/pull/294)（`dev` → `main`），CI 绿、一直挂着没合。
> **099 跑完之前不要 merge #294**——Railway production 与两个支付 cron 服务都跟随 `main` 自动部署。
>
> **先做 §9.3 的「C3 窗口前检查」三条**（`main` 可能在 C2 之后又进了 hotfix，需要重合上游并等 CI 再绿），
> 通过之后再停服。
>
> 然后执行 §9.3 的 C3，顺序不要改：
>
> 1. 按 **§9.4** 停服务——Railway `stminiapp`（backend，进程内有 30 秒的 chat_history sync job
>    和 24 小时一轮、整轮一个事务的大厅排序重算）、`stminiapp-payment-reconcile-cron`、
>    `stminiapp-payment-cron`，再挂前端维护页。PostgREST、库内 pg_cron、各前端**不要停**。
> 2. `run-inventory.sh prod` 取快照并核对（`payment_orders` 16 列是对的，见 §11.2）。
> 3. 确认回滚执行人与 `099_schema_split_phase1_rollback.sql`。
> 4. 跑 099。失败就停下来，不要现场改 SQL。
> 5. `postgrest-expose-prod.sql`：文首 step 0 当天重新实测暴露列表这一步不可跳过。
> 6. `cron-job5-prod.sql`。
> 7. **这时才**合 #294，等 production 与两个 cron 服务部署完。
> 8. 最小上线验证后恢复流量与两个 cron 服务。
> 9. 下一个整点回看 cron job 5 的 `cron.job_run_details`。
>
> 时长预算见 §9.4 末尾：乐观 30 分钟、现实 45–60 分钟，最大变量是 Railway 构建部署。
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

---

## 十一、C2 执行记录（2026-08-27 晚）

不要重做本节。新窗口直接进 §9.3 的 C3。

### 11.1 做了什么

| 步骤               | 结果                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 文档提交入 `dev`   | `dev_ST_remove` 的 `f50a513`（C0/C1 收口 + 097 文首注释）经 `d065401` 合入                                                            |
| 合入上游 `main`    | `b16f8df`，带上 PR #290 / #291 / #292。`git merge` **零冲突**，无需改上游行为                                                         |
| 开 PR              | [#294](https://github.com/linshu368/ST_miniapp/pull/294) `dev` → `main`。CI Quality Gate + Docker Build PR (backend) 绿。**保持打开** |
| 可回退的旧生产制品 | Railway deployment `da7b25ee`（commit `fd6533d`）                                                                                     |

`dev` 相对 `main` 带的东西：schema 适配代码、097/098/099 与回滚脚本、`ops/schema-split/*`、
双库盘点快照、四份文档，外加已在 `dev` 上的 `8ecee42`（chat_history 首轮字段瘦身）和
`f7dbb4c`（Railway production 配置显式选环境）。

### 11.2 上游带来的新东西：迁移 100 与支付对账代码

**这是 C2 期间新发现的一面，写进来免得 C3 窗口里当漂移误判。**

PR #290 / #291 在 `main` 上加了「支付订单快速对账」，涉及 `payment_orders`：

- `packages/shared/migrations/100_payment_reconciliation_schedule.sql` 给表加 4 列
  （`next_reconcile_at` / `last_reconciled_at` / `reconcile_attempts` / `reconcile_locked_until`）
  与索引 `idx_payment_orders_due_reconcile`。**它自己用 `to_regclass` 挑 `billing` 还是 `miniapp`**，
  所以能独立于 097–099 分别应用到两库。名字里的「调度」是应用层 cron，不是 pg_cron，**它不建库内 job**。
- 两库都已执行（2026-08-27 实测）：test 落在 `billing.payment_orders`、prod 落在 `miniapp.payment_orders`，
  两边都是 16 列 + 那个索引。

对 099 的影响：**没有**。列和索引随 `ALTER TABLE … SET SCHEMA` 跟着走；
099 的索引 / FK / 触发器断言全是同一事务内「迁前 vs 迁后」的对比（`v_base` 在事务开头取），
不是硬编码数量，所以多出来的列和索引不会顶掉断言。

合并语义已逐处复核（这是 §upstream-merge-protection 要求的「保留上游行为」）：

- `MiniappPaymentOrderRepository` 同时留住上游新增的对账方法与本分支的 `getDomainDb('billing')`；
- Prisma `miniapp_payment_orders` model 同时有上游 4 个对账列与本分支的 `@@schema("billing")`；
- 上游新增的 `FastPaymentReconciliation` / `ExpirePaymentOrders` / `reconcile-payment-orders.ts` /
  `diagnose-zqpay-query.ts` 里没有任何 `.schema('miniapp')` 或 `miniapp.` 字面量，它们都经
  repository 访问表，所以不需要额外适配。

### 11.3 两个跟随 `main` 的 Railway cron 服务

`.railway/railway.ts` 除 `stminiapp` 外还声明了两个 cron 服务，**`source.branch` 与 API 同为 `main`**：

| 服务                               | 频率      | 入口                                          |
| ---------------------------------- | --------- | --------------------------------------------- |
| `stminiapp-payment-reconcile-cron` | 每分钟    | `tsx src/scripts/reconcile-payment-orders.ts` |
| `stminiapp-payment-cron`           | 每 5 分钟 | `tsx src/scripts/expire-payment-orders.ts`    |

C3 窗口里它们是新增风险面（旧交接文档写「停后端后台任务」时还没有它们）：

- 099 之后、PR #294 合入前，它们跑的是旧代码，读 `miniapp.payment_orders` 会失败。
  失败本身无害：脚本 `catch` 之后只 log + `exit 1`，`restartPolicyType: NEVER`，不会把订单写成异常态。
- 真正的理由是**锁**：它们可能正握着 `payment_orders` 上的行锁/事务，
  让 099 的 ACCESS EXCLUSIVE 排队，把 test 实测 8.92 秒的窗口拖成不定长。

所以 §9.3 的 C3 第 1 步已改成明确点名停这两个服务，第 8 步再恢复。

### 11.4 验证

本地对合并后的代码跑过（`b16f8df`，之后的 `a636c81` 只多一次文档提交，代码同）。
与 CI 的 Quality Gate 重叠，但多跑了 backend 单测、数据库集成测试与 MVP regression：

| 项                       | 结果                                                        |
| ------------------------ | ----------------------------------------------------------- |
| 5 包 typecheck           | ✅ 全绿                                                     |
| lint + 跨包 import guard | ✅ 全绿                                                     |
| 单测                     | ✅ shared 55 / backend 330 / frontend 56 / admin 41，0 失败 |
| 数据库集成测试           | ✅ 13 项真跑（连已执行 099 的 test 库）通过，0 skip         |
| 5 包 build               | ✅ 全绿                                                     |
| MVP regression 全量      | ✅ **7 / 7**，76 项断言，0 未通过 0 跳过，约 88 秒          |

MVP regression 明细（对 test 库）：`create_session` 11 / `send_message` 28 / `free_quota` 6 /
`insufficient_balance` 9 / `regenerate` 8 / `client_disconnect` 6 / `conflict_guards` 8 项断言。
**它起本地假上游（`http://127.0.0.1:54363`）替代 OpenRouter，不打真实 LLM、不花钱**，
所以要复跑随时可以：`pnpm --filter @miniapp/backend mvp:regression`。
注意它会在 test 库留下计费幂等墓碑（§8.3 记过那 7 行的来历），
想要干净的行数对照就在跑它之前先取快照。

`development` 环境 smoke（`https://stminiapp-development.up.railway.app`，跑的就是 `b16f8df`）：
`/health`、`/api/characters?type=recommended|latest`、`/api/payment/plans`、`/api/platform/models`、
`/api/wallet/balance`、`/api/favorites/ids`、`/api/notifications`、`/api/support/unread` 全部 200。
（wallet / favorites / notifications / support 不带 `X-Init-Data` 也返回 200 是 `DEV_AUTH_BYPASS=1`，
见 §8.6，不要重复排查。）

**推 `dev` 不碰生产，已实测**：推送 `b16f8df` 之后，PR 上那条 Railway 检查是
`Success - stminiapp-development.up.railway.app`；同时生产 `https://stminiapp-production.up.railway.app`
的 `/health` 200、`/api/characters?type=recommended` 200 且仍返回 231 KB 数据——
生产仍跑 `fd6533d` 读 `miniapp.*`，未被本次推送影响。

### 11.5 一处已知的文档漂移

097 文件在 §10.2 记的 checksum `bbdb1cdf` 已经对不上了：`f50a513` 改了它的文首注释
（把「生产待执行」改成「已执行」）。**SQL 语句一个字没动**，且生产早已执行、全程 `IF EXISTS`。
不要因为 checksum 不符去重跑或回滚 097。

### 11.6 test 库 `miniapp_fdw` 的一个陈旧点（不挡 C3）

§8.7 保留的 `miniapp_fdw` 里，外部表 `chat_history` / `current_chat_history` 仍声明 32 列，
而生产实际已是 29 列（097 之后）。也就是说经 FDW 查这两张表、只要碰到那三个已删列就会报错。
它是库外手工建的对照/取数通道，不在版本控制里，也不参与 099；要用就得自己重新
`IMPORT FOREIGN SCHEMA`。这里只记一笔，避免下次撞上时以为是 099 弄坏的。

---

## 十二、C3 生产割接执行记录（2026-08-28）

一阶段到此收口。**不要重做本节。** 后续要动的只有 §12.7 的两个遗留项。

窗口实际是 8/28 10:25–11:05（北京），比 §9.4 定档的 8/29 10:05 提前一天执行。
起步时刻在 `:25` 而非 `:05`，距整点 pg_cron job 5 只剩 35 分钟，实际赶在 10:36 就改完了 job 5，没有踩到整点。

### 12.1 窗口前检查（§9.3 三条）

| 检查                         | 结果                                                                      |
| ---------------------------- | ------------------------------------------------------------------------- |
| 1. `origin/dev..origin/main` | **空** —— C2 之后 `main` 没进新 hotfix，**第 2 条不触发**，不需要重合上游 |
| 3. `gh pr view 294`          | `OPEN` + `CLEAN` + `MERGEABLE`，head `a27ed29`；`gh pr checks` 全 pass    |

额外做了两件本可以留在窗口里、提前做完更省时间的事：

- **生产库 099 preflight 事实只读预核**（停服之前）：22 表 + 1 视图与映射逐个一致、无同名重载、
  固定 `search_path` 恰好 3 个函数、无 FDW / 无新域、`payment_orders` 16 列、`authenticator` 无
  `pgrst.db_schemas`、无长事务。
- **PostgREST step 0 当天实测**（02:21:51Z）：hint 为
  `graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin`，
  与脚本 `EXPECTED_BASELINE` **逐项一致、顺序也一致**，所以脚本 step 2 的硬编码列表不需要改。

### 12.2 两处文档旧数（已核实，都不是漂移）

1. **生产 `miniapp` 的函数是 24 个不是 25 个。** §9.1 / §8.7 原来写的 25 是 097 之前的数；
   少的那个是 097 按设计删掉的 `tf_set_user_character_round`。099 的必选映射正好 24 个，
   与生产逐个一致。这两处已就地改成 24。
   **注意 §三 / §八 里关于 test 的「25 函数」是对的、不要跟着改**——test 多一个可选的
   `charge_voice_usage`（§五 第 1 条），所以 test 是 24 必选 + 1 可选 = 25，生产没有它。
2. **`cs_platform.personas` 引用 `miniapp.*` 的是 15 条不是 14 条**（总 18 条）。099 文首注释写的
   「生产 14/18」是 08-25 的数。099 不硬编码这个数——它在事务内动态取「哪些本来就能通过校验」的基线，
   只追究改写后变坏的。迁移前 18 条全部通过 `validate_persona_sql`，迁移后仍全部通过。

### 12.3 九步的实际执行

| 步  | 动作                        | 时间（UTC）           | 结果                                                                                  |
| --- | --------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| 1   | 停三个 Railway 生产服务     | 02:25:38–02:25:57     | `railway down` × 3，`activeDeployments=0`，backend 域名 404。**前端维护页按决定跳过** |
| 2   | `run-inventory.sh prod`     | 02:28:48–02:29:08     | 20 秒，stderr 0 字节。快照 `snapshots/2026-08-28-pre099/prod/`                        |
| 3   | 回滚执行人与回滚脚本        | —                     | 回滚脚本 md5 `84428ca1…`，与 099 的映射表互校逐行一致；可回退制品 `fd6533d`           |
| 4   | **099**                     | **02:30:32–02:30:41** | **9.435 秒**，`COMMIT` + `NOTIFY`。postflight 全过                                    |
| 5   | `postgrest-expose-prod.sql` | 02:31:51–02:31:54     | GUC 写入 10 个 schema，REST 实测 10 域全 200                                          |
| 6   | `cron-job5-prod.sql`        | 02:36:05–02:36:08     | **原脚本失败，改用 `cron.alter_job` 才成功，见 §12.4**                                |
| 7   | 合 PR #294                  | 02:37:14              | 合并提交 `f7295a6`。三个服务被触发部署；**backend 构建卡死，见 §12.5**                |
| 8   | 最小上线验证 + 恢复         | 03:03:53              | `/health` 200，核心接口全 200，需鉴权接口正确 401                                     |
| 9   | job 5 回看                  | 03:00（=11:00 北京）  | run 967 `succeeded`，`INSERT 0 193`，与改写前的 966/965 同数                          |

**099 的实测输出**：preflight 通过（待搬 23 表/视图、24 函数；可选函数 `charge_voice_usage`
不存在→跳过）→ 建四 schema → 改写 **44 个函数体**（与 test 同数）→ 改写**人群规则 23 处**
（test 是 13 处，生产人群规则更多）→ postflight 全过。

**迁后核对**：`miniapp` 0 表 0 视图 0 函数；app_core 4/2、miniapp_features 6/6、
experience 3 表 + 1 视图/5、billing 7/11（无可选函数）、cs_platform 收到 2 张表。
库内 `miniapp.*` 残留三项（`prosrc` / `pg_get_viewdef` / `personas.sql_text`）全 0。
行数与迁前分毫不差（`characters` 360、`chat_history` 232167、`payment_orders` 468、`users` 5451、
`character_favorites` 1122）。四个新域 ACL 恰好 `service_role=U`，`anon` / `authenticated` 无 USAGE。
6 条 `cs_platform.* → app_core.users` 跨域 FK 按 OID 自动跟随。

**迁前与 08-25 基线的结构 diff 全部可归因**：触发器 −1 与索引 −1（097）、
索引 +1 `idx_payment_orders_due_reconcile`（上游 100）、视图 `current_chat_history` 少 `preset_id`（097）；
关系对象 / 约束 / 表授权 / 类型 / 序列 0 差异。

### 12.4 cron job 5：`UPDATE cron.job` 权限不足（脚本已修）

**这一步 §四 早就说过在 test 上演练不了（test 没有 pg_cron），所以是生产窗口里第一次暴露。**

原脚本的 `UPDATE cron.job` 报 `permission denied for table job`。取证：Supabase 上 `cron.job`
归 `supabase_admin`，`postgres` 只有 SELECT（`postgres=r*`）——**以 `postgres` 身份永远不可能成功**，
不是偶发。事务整体回滚，job 5 未被改坏。

合法路径：`cron.alter_job` 是 pg_cron 的 **C 函数**（`cron_alter_job`），直接操作 catalog、
绕过表级 ACL，只校验「必须是 job 所有者」——job 5 的 `username = postgres`，
`cron.job` 上的 RLS 策略也正好是 `username = CURRENT_USER`。它按 `job_id` 原地更新，**保留 jobid**，
正是原脚本拒绝 `cron.schedule()` 的那个理由。

`ops/schema-split/cron-job5-prod.sql` 已改成用 `cron.alter_job`，**两个断言块（guard / verify）一字未动**；
文件末尾「回滚」小节里那条 `UPDATE cron.job` 会撞同一道墙，也一并改了，否则回滚路径是坏的。

### 12.5 Railway backend 构建卡死（本次超时的唯一原因）

合 PR 之后，`stminiapp` 的构建卡在
`RUN pnpm install --frozen-lockfile ...` 那一层的
`! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.15.9.tgz`，
第一次卡了约 20 分钟，重触发一次仍然卡住。

**已排除的原因**：`Dockerfile.backend`、根 `package.json`、`pnpm-lock.yaml` 在
`fd6533d` → `f7295a6` 之间**逐字未变**；同一份 Dockerfile 在两个 payment cron 服务上
同一时刻构建成功；PR #294 的 CI（`Docker Build PR (backend)` 1m18s、`Build & Push backend` 4m0s）
也全绿。也**不是** Corepack 在等确认——Docker 构建里 stdin 不是 TTY，那行 `!` 是信息性输出。
最像的是 Railway 那台 Metal builder（`builder-cexsbx`）到 `registry.npmjs.org` 的出网卡住。
**根因未定论，Dockerfile 侧的正式修复留作遗留项，见 §12.7。**

**当时的应急处置**：`build-and-push.yml` 在 push 到 `dev` 时会把 backend 多架构镜像推到 GHCR，
而 `git diff a27ed29 f7295a6` 为空（两者 tree 完全相同），所以 CI 已经有一份和 `main` 等价的镜像。
实测 `ghcr.io/linshu368/st-miniapp-backend:sha-a27ed29` **可匿名拉取**（无需给 Railway 配凭据），于是：

```bash
railway service source connect --image ghcr.io/linshu368/st-miniapp-backend:sha-a27ed29 \
  --service stminiapp --environment production
```

部署直接进 `DEPLOYING`（不再 BUILDING），**25 秒**后 `/health` 200。

> 一条实测结论，与官方文档不符，记下来省得下次重查：GraphQL 的 `serviceInstanceUpdate` 文档说
> 非 fork 环境的更新会应用到**所有**非 fork 环境，而本项目三个环境都不是 fork。
> 但 `railway service source connect --environment production` 实测**只改了 production**，
> `development` 仍是 `repo=linshu368/ST_miniapp`。以实测为准。

### 12.6 两次窗口内 cron 触发（无害，但纠正一条判断）

`railway down` **不阻止** Railway 按 cron schedule 重新拉起部署。
`stminiapp-payment-cron`（每 5 分钟）在窗口里触发了两次：`005ae5d4`(02:30:20Z) 与 `e6f6e1c8`(02:35:04Z)。
`stminiapp-payment-reconcile-cron`（每分钟）一次都没触发。原因未查。

两次都按 §11.3 的预期无害失败：报
`Could not find the table 'miniapp.payment_orders' in the schema cache`，
失败在 `listUnsettledAroundExpiry` 的**第一个读**上，也就是在任何写之前就 `exit`。
而且 `005ae5d4` 容器冷启动花了约 2 分钟、真正发查询是 02:32:22Z，**099 在 02:30:41Z 就已提交，
两者从未争锁**。数据侧复核：`payment_orders` 468 行不变、窗口内 0 新建 0 对账、无 `pending` 订单。
**零影响，无需补偿动作。**

### 12.7 遗留项（下一个窗口/下一次动后端前处理）

1. **生产 Railway source 被固定在 GHCR 镜像**（**这一条影响后续所有后端发布**）。
   `stminiapp` production 现在是 `image=ghcr.io/linshu368/st-miniapp-backend:sha-a27ed29`，
   **不再跟随 `main` 自动部署**，与 `.railway/railway.ts` 声明的 `source: github(REPO, {branch:'main'})` 漂移。

   > **最危险的后果是版本错位，不是「发不出去」。** 两个 payment cron 的 source **仍跟随 `main`**
   > （实测 `repo=linshu368/ST_miniapp`）。所以下一次有人合 `main`：两个 cron 会换上新代码，
   > 而 backend 仍停在 `sha-a27ed29`。它们共用 `payment_orders` 与同一套 repository，
   > 一旦那次改动涉及支付/计费的表结构或字段语义，就会出现「cron 用新契约、API 用旧契约」的
   > 静默不一致。**在改回 source 之前，不要往 `main` 合任何涉及后端的改动。**

   直接改回去会立刻触发一次构建，可能再次卡死，所以顺序是：**先解决 §12.5 的构建问题，再改回**：

   ```bash
   railway service source connect --repo linshu368/ST_miniapp --branch main \
     --service stminiapp --environment production
   ```

2. **`Dockerfile.backend` 的 corepack 取包在 Railway 上不可靠**（§12.5）。两个方向，都还没做：
   - 把 `corepack prepare pnpm@9.15.9 --activate` 挪进 `apt-get` 那个**稳定层**。
     现在下载发生在 `pnpm install` 层里，而该层被每次源码变更打穿，等于每次构建都重下一遍；
     挪进稳定层之后只下一次、之后一直命中缓存。
   - 加 `ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0`（消除任何 prompt 相关分支）。
     注意文件头把「corepack pnpm@9.15.9」列为继承自 M1 的硬约束，动它要连注释一起改。
     改完在 Railway 上真跑一次构建验证，别只看 GitHub Actions 绿。

另外两条不影响运行、只是别再重查：

- §11.5 的 097 checksum 漂移仍然成立。
- §11.6 的 test `miniapp_fdw` 列数陈旧仍然成立。
