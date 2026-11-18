-- Domain: app_core / miniapp_traffic / miniapp_features / 平台配置（PostgREST 暴露列表）。
-- 数据库重组阶段 1d：删除已确认无读者的结构，规则见 docs/db/CONTRACT.md，
-- 计划见 .trellis/tasks/11-17-db-reorg-p1-foundation/design.md。
--
--   1) app_core.users.st_handle：ST 身份映射，代码、函数、视图零引用（112 写好但生产未执行）。
--      st_initialized_at 保留：miniapp_traffic.record_app_entry 经 to_jsonb(u) 读它作幕间资格依据，
--      阶段 3 随归因字段一起搬。
--   2) miniapp_traffic.botlinks 两个大写列改为小写；依赖它的视图 traffic_daily_stats 按列号引用，
--      改名后自动跟随，输出列名不变。
--   3) miniapp_features.wish_roles 及其两个函数：已被 character_wishes 取代，无运行时读者。
--   4) cs_platform（旧客服，已停用）与空的 miniapp schema：先从 PostgREST 暴露列表
--      （authenticator 的 pgrst.db_schemas / pgrst.db_extra_search_path，099 起由 GUC 接管）移除，
--      再删除；提交后 NOTIFY 让 PostgREST 先重载配置再重载 schema 缓存。
--      不能把不存在的 schema 留在暴露列表里，否则 PostgREST 重载失败。
--   5) public.compute_daily_metrics / show_dashboard 及调用它们的两个已停用 cron：
--      最后一次运行即报 relation does not exist。public schema 本身保留。
--
-- 归档：所有者 2026-11-17 确认以 Supabase 每日备份为准，不另外导出；执行前确认当天备份已完成。
-- Verify: bash scripts/test-db-reorg-p1d-migration.sh（PG17：两次幂等、暴露列表只去掉两项且保持顺序、
--   视图输出不变、无 GUC/cron 的环境安全跳过）。
-- Release: TEST -> Production（当天备份之后）-> 后端去掉 cs_platform 域客户端（不依赖顺序：后端不访问它）。
-- Recovery: 删除不可逆，只能从 Supabase 每日备份恢复；暴露列表可按 NOTICE 打印的旧值 ALTER ROLE 恢复。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1) st_handle（唯一索引随列删除）
ALTER TABLE app_core.users DROP COLUMN IF EXISTS st_handle;

-- 2) botlinks 列名
DO $botlinks$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'miniapp_traffic' AND table_name = 'botlinks' AND column_name = 'Purchase_amount') THEN
    ALTER TABLE miniapp_traffic.botlinks RENAME COLUMN "Purchase_amount" TO purchase_amount;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'miniapp_traffic' AND table_name = 'botlinks' AND column_name = 'Procurement_days') THEN
    ALTER TABLE miniapp_traffic.botlinks RENAME COLUMN "Procurement_days" TO procurement_days;
  END IF;
END $botlinks$;

-- 3) wish_roles
DROP FUNCTION IF EXISTS miniapp_features.create_wish_role(uuid, bigint, text, integer);
DROP FUNCTION IF EXISTS miniapp_features.complete_wish_role(uuid, bigint, uuid, text);
DROP TABLE IF EXISTS miniapp_features.wish_roles;

-- 4) 先改 PostgREST 暴露列表，再删 schema
DO $pgrst$
DECLARE
  v_setting text;
  v_name text;
  v_value text;
  v_new text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['pgrst.db_schemas', 'pgrst.db_extra_search_path'] LOOP
    SELECT split_part(c, '=', 2) INTO v_value
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid = s.setrole
    CROSS JOIN LATERAL unnest(s.setconfig) c
    WHERE r.rolname = 'authenticator' AND s.setdatabase = 0 AND c LIKE v_name || '=%';
    IF v_value IS NULL THEN
      RAISE NOTICE '% not set on authenticator, skipped', v_name;
      CONTINUE;
    END IF;
    -- 保持原顺序（第一项是默认 schema），只去掉两项
    SELECT string_agg(item, ', ' ORDER BY ord) INTO v_new
    FROM unnest(string_to_array(v_value, ',')) WITH ORDINALITY AS t(raw, ord)
    CROSS JOIN LATERAL (SELECT btrim(raw) AS item) x
    WHERE item NOT IN ('miniapp', 'cs_platform') AND item <> '';
    IF v_new IS DISTINCT FROM v_value THEN
      RAISE NOTICE '% old value: %', v_name, v_value;
      EXECUTE format('ALTER ROLE authenticator SET %s = %L', v_name, v_new);
      RAISE NOTICE '% new value: %', v_name, v_new;
    END IF;
  END LOOP;
END $pgrst$;

DROP SCHEMA IF EXISTS cs_platform CASCADE;
DROP SCHEMA IF EXISTS miniapp;

-- 5) public 里的死函数与停用 cron
DO $cron$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
    WHERE j.jobname IN ('daily_metrics_midnight', 'daily_metrics_noon');
  END IF;
END $cron$;
DROP FUNCTION IF EXISTS public.compute_daily_metrics(date, date);
DROP FUNCTION IF EXISTS public.show_dashboard();

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

COMMIT;
