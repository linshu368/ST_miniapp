-- PostgREST 暴露列表 · test（zoqelpfhurwehlvypryl）
--
-- 099 的事务外收尾之一。执行时机：099 在 test 提交之后、部署适配新 schema 的 test 后端之前。
-- 上游文档：docs/fix-postgrest-schema-exposure.md、docs/schema划分-一阶段执行计划.md §4.4
-- 实测基线：ops/schema-split/snapshots/2026-08-25/test/sections/14_role_settings.txt
--
-- ============================ 为什么必须改 ============================
-- 099 之后业务表不再在 miniapp 里。后端用 supabase-js 的 .schema('app_core') 等访问它们，
-- PostgREST 只会放行 db_schemas 里列出的 schema，漏一个就是 PGRST106 Invalid schema。
--
-- ============================ 相对现状的三处变化 ============================
-- 现状（2026-08-25 实测，authenticator 角色 GUC）：
--   pgrst.db_schemas = public, graphql_public, miniapp, miniapp_traffic, admin
-- 新列表 = 原样保留上面 5 个（顺序不动）+ 追加 5 个：
--   1. app_core / miniapp_features / experience / billing —— 099 新建的四个域；
--   2. cs_platform —— **test 之前没暴露**。support_conversations / support_messages 被 099
--      迁入 cs_platform，而 routes/support.ts 是走 supabase-js 读写它们的，不加就直接 500。
--      生产本来就暴露 cs_platform，这一步是让 test 与生产一致，不是放宽权限：
--      cs_platform 的 schema ACL 只给 service_role USAGE，anon / authenticated 进不来。
--   3. miniapp 暂时**保留**在列表里。099 只把它掏空，schema 本身留到批次 D 再删；
--      在割接窗口里留着它，回滚时不必再动这份配置。批次 D 删 miniapp 时一并从列表移除。
--
-- 顺序只追加、不重排：db_schemas 的第一项是请求不带 Accept-Profile 时的默认 schema，
-- 重排会静默改变默认目标。
--
-- pgrst.db_extra_search_path 本阶段**不动**（现状 public, graphql_public, miniapp,
-- miniapp_traffic）。库内函数与视图全部是 schema 限定名，RPC 由 Accept-Profile 定位，
-- 不依赖它；而 search_path 里列一个空的（将来不存在的）schema 在 PostgreSQL 里是静默忽略的。
--
-- ============================ 执行 ============================
--   psql "$TEST_POOL_URL" -X -v ON_ERROR_STOP=1 -f ops/schema-split/postgrest-expose-test.sql
-- 连接串取自仓库根 .env.schema-split，不要写进命令行或 shell 历史。

\echo '=== step 0: 改之前先记下现状（贴进割接记录） ==='
SELECT r.rolname, s.setconfig
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
WHERE r.rolname = 'authenticator';

\echo '=== step 1: 断言现状与基线一致，然后写入新列表 ==='

BEGIN;

DO $guard$
DECLARE
  v_cur text;
BEGIN
  SELECT c INTO v_cur
  FROM pg_db_role_setting s
  JOIN pg_roles r ON r.oid = s.setrole
  CROSS JOIN LATERAL unnest(s.setconfig) AS u(c)
  WHERE r.rolname = 'authenticator' AND c LIKE 'pgrst.db_schemas=%';

  IF v_cur IS NULL THEN
    RAISE EXCEPTION 'test 的 authenticator 没有 pgrst.db_schemas GUC。现状与基线不符，先重新盘点再改';
  END IF;

  IF v_cur <> 'pgrst.db_schemas=public, graphql_public, miniapp, miniapp_traffic, admin' THEN
    RAISE EXCEPTION '现状与基线不符：%。有人改过暴露列表；先把它抄进本文件的「回滚」小节再继续', v_cur;
  END IF;
END
$guard$;

ALTER ROLE authenticator SET pgrst.db_schemas =
  'public, graphql_public, miniapp, miniapp_traffic, admin, cs_platform, app_core, miniapp_features, experience, billing';

COMMIT;

\echo '=== step 2: 让 PostgREST 热加载（先 config 再 schema，缺一不可） ==='
-- reload config：重读 db_schemas 本身
-- reload schema：重扫新 schema 里的表与函数
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

\echo '=== step 3: 复核写入结果 ==='
SELECT u.c AS db_schemas
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
CROSS JOIN LATERAL unnest(s.setconfig) AS u(c)
WHERE r.rolname = 'authenticator' AND u.c LIKE 'pgrst.db_schemas=%';

\echo '=== step 4: 必须用 REST 实测，SQL 侧看不出 PostgREST 有没有真的加载 ==='
-- 用一个不存在的 profile 触发 PGRST106，hint 会列出实际生效的完整列表：
--
--   . ./.env.schema-split
--   curl -s "$TEST_SUPABASE_URL/rest/v1/x" \
--     -H "apikey: $TEST_SERVICE_ROLE_KEY" -H "Accept-Profile: __nope__"
--
-- 期望 hint 含全部 10 个 schema。若只见到旧的 5 个，再发一次 reload config；
-- 若报 PGRST205 Could not find table in schema cache，再发一次 reload schema。
--
-- 再按域点一下真实可达性（期望 200）：
--   for s in app_core miniapp_features experience billing cs_platform; do
--     curl -s -o /dev/null -w "$s %{http_code}\n" \
--       "$TEST_SUPABASE_URL/rest/v1/?select=1" \
--       -H "apikey: $TEST_SERVICE_ROLE_KEY" \
--       -H "Authorization: Bearer $TEST_SERVICE_ROLE_KEY" \
--       -H "Accept-Profile: $s"
--   done

-- ===================================================================
-- 回滚（配合 packages/shared/migrations/099_schema_split_phase1_rollback.sql）
-- ===================================================================
-- 099 回滚之后必须把这里也退回去，否则 PostgREST 还在放行四个已被 DROP 的 schema。
-- 顺序：先跑回滚迁移，再执行下面三句。
--
--   ALTER ROLE authenticator SET pgrst.db_schemas =
--     'public, graphql_public, miniapp, miniapp_traffic, admin';
--   NOTIFY pgrst, 'reload config';
--   NOTIFY pgrst, 'reload schema';
--
-- 然后同样用 step 4 的 curl 复核 hint 只剩这 5 个。
