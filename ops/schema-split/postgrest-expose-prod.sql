-- PostgREST 暴露列表 · production（wbtsfzozlmurljvglhpn）
--
-- 099 的事务外收尾之一。执行时机：099 在生产提交之后、部署新代码之前，停流量窗口内。
-- 上游文档：docs/fix-postgrest-schema-exposure.md、docs/schema划分-一阶段执行计划.md §4.4
-- 实测基线：ops/schema-split/snapshots/2026-08-25/prod/sections/14_role_settings.txt
--          ops/schema-split/snapshots/2026-08-25/批次A-双库基线与差异.md §三 A2 / B4
--
-- ############################ 本文件与 test 版的根本区别 ############################
-- 生产的暴露列表**不是**数据库 GUC 配的。2026-08-25 实测：
--   · REST 实际暴露：graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin
--   · authenticator 的 setconfig 里只有 pgrst.db_extra_search_path，**没有 pgrst.db_schemas**
-- 也就是说这份列表来自 Supabase 平台层（Dashboard / Management API）。
--
-- 本文件按 Q5 的拍板改用 GUC 接管（可热重载、可版本化）。代价是：
-- **GUC 一旦存在就整体覆盖平台层配置，不是与之合并。**
-- 漏写 miniapp_analytics 就是看数掉线，漏写 cs_platform 就是 CS 平台掉线，
-- 而且这两个都不在 099 的动刀范围内，出事时最容易归因错方向。
-- 所以 step 0 的重新实测**不是**可选步骤。
--
-- 生产没有暴露 public，本文件也不加——保持现状，不借这一步改行为。
-- 列表顺序照抄实测顺序、只在末尾追加：第一项是请求不带 Accept-Profile 时的默认 schema。
--
-- pgrst.db_extra_search_path 不动（同 test 版的理由）。
--
-- ============================ 执行 ============================
--   psql "$PROD_DIRECT_URL" -X -v ON_ERROR_STOP=1 -f ops/schema-split/postgrest-expose-prod.sql
-- 连接串取自仓库根 .env.schema-split，不要写进命令行或 shell 历史。

\echo '=== step 0（不可跳过）: 当天重新实测平台层的暴露列表 ==='
-- 在执行本文件之前，先在 shell 里跑：
--
--   . ./.env.schema-split
--   curl -s "$PROD_SUPABASE_URL/rest/v1/x" \
--     -H "apikey: $PROD_SERVICE_ROLE_KEY" -H "Accept-Profile: __nope__"
--
-- hint 里那一串就是当前真实生效的列表。把它与下面 EXPECTED_BASELINE 逐项比对：
--
--   EXPECTED_BASELINE = graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin
--
-- 只要有任何一项不同（多、少、顺序变了），**停下**：先把实测结果抄进本文件的
-- step 2 与「回滚」小节，再执行。不要凭这份 2026-08-25 的基线硬跑。
--
-- 顺带留档 Management API 里存的配置（可选，需要 SUPABASE_ACCESS_TOKEN）：
--   curl -s "https://api.supabase.com/v1/projects/wbtsfzozlmurljvglhpn/postgrest" \
--     -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"

\echo '=== step 1: 记录数据库侧现状（贴进割接记录） ==='
SELECT r.rolname, s.setconfig
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
WHERE r.rolname = 'authenticator';

\echo '=== step 2: 断言 GUC 尚不存在，然后一次性写入完整列表 ==='

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

  -- 基线是「生产没有这个 GUC」。已经有了说明有人先接管过一次，
  -- 那么当前生效的列表就不是本文件假设的那份，必须由人重新确认。
  IF v_cur IS NOT NULL THEN
    RAISE EXCEPTION '生产已存在 pgrst.db_schemas（%），与基线不符。先确认当前生效列表，再决定怎么改', v_cur;
  END IF;
END
$guard$;

-- 前 6 项 = step 0 实测的平台层列表，原样照抄、顺序不动
-- 后 4 项 = 099 新建的四个域
ALTER ROLE authenticator SET pgrst.db_schemas =
  'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing';

COMMIT;

\echo '=== step 3: 让 PostgREST 热加载（先 config 再 schema，缺一不可） ==='
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

\echo '=== step 4: 复核写入结果 ==='
SELECT u.c AS db_schemas
FROM pg_db_role_setting s
JOIN pg_roles r ON r.oid = s.setrole
CROSS JOIN LATERAL unnest(s.setconfig) AS u(c)
WHERE r.rolname = 'authenticator' AND u.c LIKE 'pgrst.db_schemas=%';

\echo '=== step 5: REST 实测，重点是原有两个域没掉 ==='
--   curl -s "$PROD_SUPABASE_URL/rest/v1/x" \
--     -H "apikey: $PROD_SERVICE_ROLE_KEY" -H "Accept-Profile: __nope__"
-- 期望 hint 含全部 10 个 schema。
--
-- 然后按域点真实可达性（期望 200），**miniapp_analytics 与 cs_platform 必须一起验**：
--   for s in app_core miniapp_features experience billing cs_platform miniapp_analytics miniapp_traffic admin; do
--     curl -s -o /dev/null -w "$s %{http_code}\n" \
--       "$PROD_SUPABASE_URL/rest/v1/?select=1" \
--       -H "apikey: $PROD_SERVICE_ROLE_KEY" \
--       -H "Authorization: Bearer $PROD_SERVICE_ROLE_KEY" \
--       -H "Accept-Profile: $s"
--   done
--
-- 若只见到旧列表，再发一次 reload config；
-- 若报 PGRST205 Could not find table in schema cache，再发一次 reload schema。

-- ===================================================================
-- 回滚（配合 packages/shared/migrations/099_schema_split_phase1_rollback.sql）
-- ===================================================================
-- 生产的正确反向是 **RESET**，不是「写回旧列表」：
-- 基线状态是「没有这个 GUC，由平台层配置生效」。RESET 之后平台层重新接管，
-- 列表回到 step 0 实测的那 6 个。写一份手抄的旧列表进去反而是把接管永久化了。
--
--   ALTER ROLE authenticator RESET pgrst.db_schemas;
--   NOTIFY pgrst, 'reload config';
--   NOTIFY pgrst, 'reload schema';
--
-- 然后必须用 step 0 的 curl 复核 hint 回到那 6 个。
-- 如果 RESET 之后 hint 反而变空或只剩 public，说明平台层配置也没了——
-- 那就立刻改用显式写回（用 step 0 抄下来的实测列表），不要留着 REST 全线不可用：
--
--   ALTER ROLE authenticator SET pgrst.db_schemas =
--     'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin';
--   NOTIFY pgrst, 'reload config';
--   NOTIFY pgrst, 'reload schema';
