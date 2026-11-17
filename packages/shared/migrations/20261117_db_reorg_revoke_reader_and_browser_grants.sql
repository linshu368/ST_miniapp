-- Domain: 跨域授权收口（experience / miniapp_traffic / app_core / billing / miniapp_features / drama_archive / miniapp_analytics）。
-- 数据库重组阶段 2c，规则见 docs/db/CONTRACT.md §1（外部读者只经视图层），计划见
-- .trellis/tasks/11-17-db-reorg-p2-observability/design.md 2c。
--
-- 1. 看板只读账号 first_token_metrics_reader（grafana_cloud 的上级角色）只经视图读：
--    miniapp_analytics.chat_first_token_facts 由 security_invoker 改为所有者权限（与同 schema 其他分析视图一致），
--    然后收回它对 experience 三张表的直接/列级 SELECT、experience 的 USAGE，删除三条 first_token_metrics_read 策略。
--    chat_first_token_report 只读这个视图，不受影响；后端畅聊评估以 postgres 读视图，不受影响。
-- 2. 收回浏览器角色 anon / authenticated 在业务 schema（不含 admin）里遗留的表/视图权限。
--    这些授权是表早先建在 public、后来 SET SCHEMA 时带过来的；两角色对这些 schema 都没有 USAGE，
--    所以收回不改变任何现有行为，只去掉"将来有人开了 USAGE 就全表可读写"的隐患。
-- 3. 仍未开启行级安全的三张表开启 RLS：experience.chat_history、miniapp_traffic.botlinks、
--    miniapp_traffic.traffic_clicks。生产上能访问它们的只有 postgres（所有者）与 service_role，二者都 BYPASSRLS。
--
-- Verify: bash scripts/test-db-reorg-p2c-migration.sh（PG17 非超级用户：两次幂等；看板账号与 grafana_cloud
--   读视图与报表行数不变、直读 experience 被拒；anon/authenticated 在业务 schema 无任何表权限、admin 不变；
--   三张表 RLS 开启后 service_role 照常读写）。
-- Release: TEST -> Production。无应用代码改动。
-- Recovery: 视图 SET (security_invoker = true)，按 scripts/sql/grant-first-token-metrics-reader.sql 旧版重授；
--   浏览器角色授权本就无效，不恢复；RLS 可 DISABLE。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. 看板账号只经视图读。
ALTER VIEW miniapp_analytics.chat_first_token_facts SET (security_invoker = false);

DO $reader$
DECLARE
  v_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_token_metrics_reader') THEN
    RETURN;
  END IF;
  FOREACH v_table IN ARRAY ARRAY[
    'experience.chat_generation_requests', 'experience.chat_generation_attempts', 'experience.chat_history'
  ] LOOP
    -- REVOKE ... ON TABLE 同时收回该表的列级权限。
    EXECUTE format('REVOKE ALL ON %s FROM first_token_metrics_reader', v_table);
    EXECUTE format('DROP POLICY IF EXISTS first_token_metrics_read ON %s', v_table);
  END LOOP;
  REVOKE ALL ON SCHEMA experience FROM first_token_metrics_reader;
END
$reader$;

-- 2. 浏览器角色在业务 schema 的遗留表/视图权限。
DO $browser$
DECLARE
  v_rel record;
BEGIN
  FOR v_rel IN
    SELECT DISTINCT c.oid::regclass AS rel, r.rolname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname IN ('app_core', 'experience', 'billing', 'miniapp_features', 'miniapp_traffic',
                        'miniapp_analytics', 'media_plaza', 'drama_archive', 'ops', 'cs_feed')
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND r.rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM %I', v_rel.rel, v_rel.rolname);
  END LOOP;
END
$browser$;

-- 3. 补开行级安全（无策略：只有 BYPASSRLS 角色与所有者可访问，正是现状）。
ALTER TABLE experience.chat_history ENABLE ROW LEVEL SECURITY;
DO $traffic$
BEGIN
  IF to_regclass('miniapp_traffic.botlinks') IS NOT NULL THEN
    ALTER TABLE miniapp_traffic.botlinks ENABLE ROW LEVEL SECURITY;
  END IF;
  IF to_regclass('miniapp_traffic.traffic_clicks') IS NOT NULL THEN
    ALTER TABLE miniapp_traffic.traffic_clicks ENABLE ROW LEVEL SECURITY;
  END IF;
END
$traffic$;

COMMIT;
