# 阶段 7 设计：命名统一

## 第一批（p7a）

### 扩展迁移 `20261123_db_reorg_p7a_naming.sql`

一个 `DO` 块（一个事务）：

1. **前置检查**：旧 schema 在、新 schema 不在、6 个关系都在；要改写的函数都归当前角色所有。已执行过（新 schema 都在，旧 schema 只剩视图和 SQL 函数）就输出 NOTICE 跳过，其他情况拒绝。
2. **改名**：`ALTER SCHEMA … RENAME` ×3，`ALTER TABLE/VIEW … RENAME` ×6。名字里带旧表名的约束、索引、策略一起改（如 `grafana_core_daily_pkey`→`core_daily_pkey`、策略 `grafana_core_read`→`core_daily_read`）。看板刷新函数 `refresh_grafana_core_day`→`refresh_core_daily`。
3. **改写引用**：
   - 函数：对 `pg_get_functiondef` 依次替换旧 schema 名（限定名、审计字面量、`SET search_path`）、限定的旧表名、改了名的约束/索引/策略名（`ON CONFLICT ON CONSTRAINT` 按名字引用）。替换后仍匹配旧名字就整体回滚。生产只读试算：36 个函数全部干净改写，没有非限定的旧表名。
   - 定时任务：`grafana_core_*` 两个任务按原计划、原启停状态重建为 `core_daily_*`，其他任务只改命令。
   - 表、列、函数、schema 注释里的旧名字一起换。
4. **旧名兼容层**：重建三个旧 schema。新 schema 的每个表/视图在旧 schema 里对应一个同名（改了名的用旧名）`security_invoker` 视图；每个非触发器函数一个 SQL 转发函数（`SELECT * FROM new.f($1..$n)`，void 用 `SELECT new.f(...)`）。schema、视图、函数的权限按 `aclexplode` 逐条照抄（先撤掉建对象时的默认授权）。
   - `security_invoker`：RLS 与表权限按调用者算，和直接访问原表一致。
   - 简单视图自动可更新：INSERT/UPDATE/DELETE、`ON CONFLICT`（推断底表唯一索引）、`RETURNING`、`FOR UPDATE` 都照常可用，Prisma 和 PostgREST 不感知。
5. **PostgREST**：`authenticator` 的 `pgrst.db_schemas` 与 `pgrst.db_extra_search_path` 里在每个旧名字前插入新名字（已有就不再加，可重入）。之后 `pg_notify` 重载配置和 schema 缓存。Supabase 上 postgres 可以改这两个参数（20261117 已验证）。
6. **自检**：兼容视图数等于新 schema 的关系数；兼容视图、转发函数的权限与目标逐条相同；可调用函数数等于转发函数数；兼容层之外没有函数、定时任务还提旧名字。

### 锁与失败

- `SET LOCAL lock_timeout = '1s'`。表改名要 `AccessExclusiveLock`，推荐、曝光两张热表若在 1 秒内拿不到锁，整个事务回滚，原样重跑（同 checksum）。
- 只改目录、不搬数据，耗时与表大小无关；生产语句上限 2 分钟。

### 不受影响的东西

- 默认权限（`ALTER DEFAULT PRIVILEGES IN SCHEMA`）按 schema oid 记，改名后跟着新 schema 走。
- 外键、序列、触发器、RLS 策略内容都按 oid 引用，改名后不需要处理。
- 兼容层不提供触发器函数（只被触发器调用，外部不直接调）。

### 本地验证 `scripts/test-db-reorg-p7a-naming.sh`

Docker PG17（迁移用非超级用户 `app_admin` 执行）+ PostgREST v12.2.12：

- 夹具覆盖三个 schema 的真实对象形状：分区表、视图、RLS、`ON CONFLICT ON CONSTRAINT`、审计字面量、`SET search_path`、定时任务、PostgREST 配置、各读者角色的权限。
- 旧库 / 新库（直接用新名字）/ 兼容层（改名后仍用旧名字）三套跑同一组场景，包括从后端搬来的 Prisma 原生 SQL（推荐写入、曝光 `ON CONFLICT`、排名 upsert 与 `UPDATE … AS target`、刷新状态 upsert）、`grafana_cloud` 与 `authenticated` 的 RLS 读，导出结果逐行相同。
- PostgREST 用旧、新两个 profile 读写和 RPC，结果相同。
- 重跑无操作；预先存在 `features` schema 时拒绝。

### 发布顺序

1. 迁移 PR（本 PR，只含迁移、测试、任务文档）→ CI → 合入 dev → TEST 执行 → 生产执行 → 核对（结构、权限、定时任务下一次运行、PostgREST 新旧 profile、看板）。
2. 后端 PR：Prisma `schemas` / `@@schema`、`DOMAIN_SCHEMAS`、原生 SQL、集成测试、`supabase/config.toml`、运维 SQL、`docs/db` 全部换新名字；遗留引用守卫加旧名字规则（只扫阶段 7 之后的迁移）。发布后看 Railway error 日志。
3. Grafana：看板 01 的查询换新名字（其他看板不引用这些对象）。
4. 观察：pg_stat_statements 按角色两次采样，旧名字调用停涨。
5. 收缩迁移：删三个兼容 schema，PostgREST 列表去掉旧名字。

### 回滚

扩展步可以反向执行：删兼容 schema、改回旧名字、用改写前的函数定义重建、定时任务改回原名。旧后端在兼容层下本来就能跑，所以一般不需要回滚；出问题优先 forward-fix。

## 第二批、第三批

各自随 6b-4、文本计费收缩一起设计，沿用同一套"改名 + 兼容层"做法。
