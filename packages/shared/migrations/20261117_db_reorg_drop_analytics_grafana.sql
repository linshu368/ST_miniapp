-- Domain: miniapp_analytics（看数唯一入口）——删除已无读者的 analytics_grafana。
-- 数据库重组阶段 1f，规则见 docs/db/CONTRACT.md §1.1，计划见 .trellis/tasks/11-17-db-reorg-p1-foundation/design.md。
--
-- 原计划把 analytics_grafana（11 个物化视图、35 个视图）并入 miniapp_analytics。2026-11-17 核对后改为删除：
--   - Grafana 现存看板与告警规则没有任何面板引用 analytics_grafana（经营看板与短剧诊断看板只查 miniapp_analytics，
--     其余看板走 Loki/Faro）；引用它的 9 个过期看板已于 2026-11-04 删除；
--   - 11 个物化视图最后一次刷新在 2026-10-24~26 或从未刷新，没有任何 cron/函数维护它们；
--   - 没有函数、cron、其他 schema 的视图引用它；仓库代码零引用；总大小约 1.7 MB。
-- 同时删除只在该 schema 上有授权的组角色 grafana_reader（grafana_cloud 的上级角色）：仅当删 schema 后它再无
-- 依赖、且 postgres 对它有 ADMIN 时才删，否则打印 NOTICE 保留，不影响本迁移。
--
-- Verify: bash scripts/test-db-reorg-p1f-migration.sh（PG17 非超级用户：两次幂等、schema 与组角色删除、
--   grafana_cloud 对 miniapp_analytics 的读取不受影响、存在外部依赖时安全跳过）。
-- Release: TEST -> Production。无应用代码改动。
-- Recovery: 不可逆（视图定义可从历史 migration 取回重建）；所有者已确认无读者的对象可直接删除。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  v_ref text;
BEGIN
  IF to_regnamespace('analytics_grafana') IS NULL THEN
    RETURN;
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE position('analytics_grafana' IN p.prosrc) > 0 AND n.nspname <> 'analytics_grafana';
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'functions still reference analytics_grafana: %', v_ref; END IF;

  SELECT string_agg(DISTINCT dv.relnamespace::regnamespace::text || '.' || dv.relname, ', ') INTO v_ref
  FROM pg_depend d
  JOIN pg_rewrite rw ON rw.oid = d.objid
  JOIN pg_class dv ON dv.oid = rw.ev_class
  JOIN pg_class t ON t.oid = d.refobjid
  WHERE t.relnamespace = 'analytics_grafana'::regnamespace AND dv.relnamespace <> 'analytics_grafana'::regnamespace;
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'views outside depend on analytics_grafana: %', v_ref; END IF;

  IF to_regnamespace('cron') IS NOT NULL THEN
    EXECUTE $q$SELECT string_agg(jobname, ', ') FROM cron.job WHERE position('analytics_grafana' IN command) > 0$q$ INTO v_ref;
    IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'cron jobs reference analytics_grafana: %', v_ref; END IF;
  END IF;
END $guard$;

DROP SCHEMA IF EXISTS analytics_grafana CASCADE;

DO $role$
DECLARE
  v_role oid;
  v_admin boolean;
  v_left int;
BEGIN
  SELECT oid INTO v_role FROM pg_roles WHERE rolname = 'grafana_reader';
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_left FROM pg_shdepend WHERE refobjid = v_role AND deptype <> 'o';
  SELECT bool_or(admin_option) INTO v_admin FROM pg_auth_members
  WHERE roleid = v_role AND member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
  IF v_left > 0 OR NOT coalesce(v_admin, false) THEN
    RAISE NOTICE 'grafana_reader kept: % remaining dependencies, admin option %', v_left, coalesce(v_admin, false);
    RETURN;
  END IF;
  EXECUTE 'DROP ROLE grafana_reader';
END $role$;

COMMIT;
