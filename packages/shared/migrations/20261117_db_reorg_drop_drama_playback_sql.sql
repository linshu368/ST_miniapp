-- Domain: miniapp_analytics——删除已停写的短剧播放 SQL 观测链路。
-- 数据库重组阶段 2b，计划见 .trellis/tasks/11-17-db-reorg-p2-observability/design.md。
--
-- 2026-10-29 起接收端不再写库，2026-11-04 已删写库代码、导入脚本与 DRAMA_TIMING_PERSIST_ENABLED；
-- 短剧启动诊断改走 Loki（看板 st-engineering-drama）。表里只剩 10-27~10-29 的 1307 行，旧看板
-- st-drama-playback 只查最近 14 天，11-12 起一直为空。所有者原则：没在用的直接去掉（2026-11-17）。
-- 删除：drama_playback_observations 表（含 RLS 策略）、drama_playback_facts 视图、record/cleanup 两个函数、
-- 已停用的 cron drama_metrics_cleanup_daily；只服务这些对象的组角色 drama_metrics_reader 在无残留依赖时删除。
-- Grafana 旧看板 st-drama-playback 与两处链接在同一发布中删除（见 design.md 2b）。
--
-- Verify: bash scripts/test-db-reorg-p2b-drama-migration.sh（PG17 非超级用户：两次幂等；对象与角色删除；
--   grafana_cloud 对其他 miniapp_analytics 视图的读取不受影响；有近期写入或外部依赖时拒绝且不改动）。
-- Release: TEST -> Production。无应用代码改动。
-- Recovery: 不可逆；表结构与函数可从 20261027_drama_playback_observability*.sql 重建，历史行以 Supabase 每日备份为准。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  v_ref text;
BEGIN
  IF to_regclass('miniapp_analytics.drama_playback_observations') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM miniapp_analytics.drama_playback_observations
             WHERE last_received_at > timestamptz '2026-11-01 00:00+08') THEN
    RAISE EXCEPTION 'drama_playback_observations received rows after 2026-11-01; writer still alive';
  END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE (position('drama_playback_observations' IN p.prosrc) > 0 OR position('drama_playback_facts' IN p.prosrc) > 0)
    AND p.proname NOT IN ('record_drama_playback_observation', 'cleanup_drama_playback_observations');
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'functions still reference drama playback objects: %', v_ref; END IF;

  SELECT string_agg(DISTINCT dv.oid::regclass::text, ', ') INTO v_ref
  FROM pg_depend d
  JOIN pg_rewrite rw ON rw.oid = d.objid
  JOIN pg_class dv ON dv.oid = rw.ev_class
  WHERE d.refobjid IN ('miniapp_analytics.drama_playback_observations'::regclass)
    AND dv.oid NOT IN (SELECT oid FROM pg_class WHERE oid = to_regclass('miniapp_analytics.drama_playback_facts'));
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'views depend on drama_playback_observations: %', v_ref; END IF;

  IF to_regclass('miniapp_analytics.drama_playback_facts') IS NOT NULL THEN
    SELECT string_agg(DISTINCT dv.oid::regclass::text, ', ') INTO v_ref
    FROM pg_depend d
    JOIN pg_rewrite rw ON rw.oid = d.objid
    JOIN pg_class dv ON dv.oid = rw.ev_class
    WHERE d.refobjid = 'miniapp_analytics.drama_playback_facts'::regclass
      AND dv.oid <> 'miniapp_analytics.drama_playback_facts'::regclass;
    IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'views depend on drama_playback_facts: %', v_ref; END IF;
  END IF;
END
$guard$;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'drama_metrics_cleanup_daily';
  END IF;
END
$cron$;

DROP VIEW IF EXISTS miniapp_analytics.drama_playback_facts;
DROP FUNCTION IF EXISTS miniapp_analytics.record_drama_playback_observation(text, jsonb, text, timestamptz, text);
DROP FUNCTION IF EXISTS miniapp_analytics.cleanup_drama_playback_observations(integer);
DROP TABLE IF EXISTS miniapp_analytics.drama_playback_observations;

DO $role$
DECLARE
  v_role oid;
  v_admin boolean;
  v_left int;
BEGIN
  SELECT oid INTO v_role FROM pg_roles WHERE rolname = 'drama_metrics_reader';
  IF v_role IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON SCHEMA miniapp_analytics FROM drama_metrics_reader';
  SELECT count(*) INTO v_left FROM pg_shdepend WHERE refobjid = v_role AND deptype <> 'o';
  SELECT bool_or(admin_option) INTO v_admin FROM pg_auth_members
  WHERE roleid = v_role AND member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
  IF v_left > 0 OR NOT coalesce(v_admin, false) THEN
    RAISE NOTICE 'drama_metrics_reader kept: % remaining dependencies, admin option %', v_left, coalesce(v_admin, false);
    RETURN;
  END IF;
  EXECUTE 'DROP ROLE drama_metrics_reader';
END
$role$;

COMMIT;
