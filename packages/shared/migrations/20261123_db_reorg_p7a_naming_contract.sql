-- Domain: 全库命名——数据库重组阶段 7 第一批收缩：删除旧名字兼容层。
-- 计划见 .trellis/tasks/11-23-db-reorg-p7-naming/design.md。前置：后端（#1094 / #1095）与 Grafana 看板 01 已改用新名字。
--
-- 一个事务：
--   1. 前置检查：三个新 schema 都在；三个旧 schema 只剩兼容层（视图 + SQL 转发函数）；
--      兼容层之外没有函数、定时任务还提旧名字（函数体不进依赖表，删了会在运行时才报错）；
--   2. 逐个删转发函数、兼容视图，再删空 schema——都不带 CASCADE：库里还有对象依赖它们就整体回滚；
--   3. PostgREST 暴露列表与 extra_search_path 去掉旧名字，重载配置与 schema 缓存；
--   4. 自检：旧 schema 不在，PostgREST 配置不再含旧名字。
-- 已执行过就跳过。lock_timeout 1 秒（删兼容视图只锁视图本身，不锁底表）。
--
-- Verify: bash scripts/test-db-reorg-p7a-naming.sh（含收缩阶段）
-- Release: 后端发布并确认旧名字停止调用 -> TEST -> Production。
-- Rollback: 重跑 20261123_db_reorg_p7a_naming.sql 的兼容层部分（第 4、5 步）即可重建；数据不受影响。

DO $p7a_contract$
DECLARE
  c_old constant text[] := ARRAY['miniapp_analytics', 'miniapp_features', 'miniapp_traffic'];
  c_new constant text[] := ARRAY['analytics', 'features', 'traffic'];
  c_old_re constant text := '\mminiapp_(analytics|features|traffic)\M';
  c_rel_re constant text := '\m(grafana_core_daily|v_card_quality_session|telegram_community_update_receipts|user_lobby_recommendations|character_ranking_scores|user_character_exposures|refresh_grafana_core_day)\M';
  v_list text;
  v_fns int := 0;
  v_views int := 0;
  r record;
BEGIN
  SET LOCAL lock_timeout = '1s';

  -- 0. 已执行过
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ANY (c_old))
     AND NOT EXISTS (SELECT 1 FROM pg_roles ro, unnest(ro.rolconfig) c
                     WHERE ro.rolname = 'authenticator' AND c ~ '^pgrst\.' AND c ~ c_old_re) THEN
    RAISE NOTICE 'p7a-naming-contract: compat layer already removed; nothing to do';
    RETURN;
  END IF;

  -- 1. 前置检查
  IF (SELECT count(*) FROM pg_namespace WHERE nspname = ANY (c_new)) <> 3 THEN
    RAISE EXCEPTION 'p7a-naming-contract: new schemas are missing; run 20261123_db_reorg_p7a_naming.sql first';
  END IF;
  SELECT string_agg(format('%s.%s(%s)', n.nspname, c.relname, c.relkind), ', ') INTO v_list
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY (c_old) AND c.relkind <> 'v';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'p7a-naming-contract: old schemas hold non-compat relations: %', v_list;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = ANY (c_old) AND p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'p7a-naming-contract: old schemas hold non-forwarder functions: %', v_list;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname <> ALL (c_old)
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND (p.prosrc ~ c_old_re OR p.prosrc ~ c_rel_re OR coalesce(array_to_string(p.proconfig, ','), '') ~ c_old_re);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'p7a-naming-contract: functions outside the compat layer still name old objects: %', v_list;
  END IF;
  -- 两层 IF：PL/pgSQL 整体解析条件，没装 pg_cron（TEST）时同一条件里的 cron.job 会直接报错
  IF to_regclass('cron.job') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE command ~ c_old_re OR command ~ c_rel_re) THEN
      RAISE EXCEPTION 'p7a-naming-contract: cron jobs still name old objects';
    END IF;
  END IF;

  -- 2. 逐个删，不带 CASCADE
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = ANY (c_old) ORDER BY p.oid LOOP
    EXECUTE format('DROP FUNCTION %s', r.oid::regprocedure);
    v_fns := v_fns + 1;
  END LOOP;
  FOR r IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ANY (c_old) AND c.relkind = 'v' ORDER BY c.oid LOOP
    EXECUTE format('DROP VIEW %s', r.oid::regclass);
    v_views := v_views + 1;
  END LOOP;
  FOR i IN 1 .. 3 LOOP
    EXECUTE format('DROP SCHEMA IF EXISTS %I', c_old[i]);
  END LOOP;

  -- 3. PostgREST：去掉旧名字
  FOR r IN SELECT split_part(c, '=', 1) AS key, substr(c, length(split_part(c, '=', 1)) + 2) AS val
           FROM pg_roles ro, unnest(ro.rolconfig) c
           WHERE ro.rolname = 'authenticator' AND split_part(c, '=', 1) IN ('pgrst.db_schemas', 'pgrst.db_extra_search_path') LOOP
    SELECT string_agg(y.s, ', ' ORDER BY x.k) INTO v_list
    FROM unnest(string_to_array(r.val, ',')) WITH ORDINALITY AS x(raw, k), LATERAL (SELECT btrim(x.raw) AS s) y
    WHERE y.s <> ALL (c_old);
    IF v_list IS DISTINCT FROM r.val THEN
      RAISE NOTICE 'p7a-naming-contract: authenticator % was: %', r.key, r.val;
      EXECUTE format('ALTER ROLE authenticator SET %s = %L', r.key, v_list);
    END IF;
  END LOOP;
  PERFORM pg_notify('pgrst', 'reload config');
  PERFORM pg_notify('pgrst', 'reload schema');

  -- 4. 自检
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ANY (c_old)) THEN
    RAISE EXCEPTION 'p7a-naming-contract: old schemas still exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles ro, unnest(ro.rolconfig) c
             WHERE ro.rolname = 'authenticator' AND c ~ '^pgrst\.' AND c ~ c_old_re) THEN
    RAISE EXCEPTION 'p7a-naming-contract: PostgREST settings still name old schemas';
  END IF;

  RAISE NOTICE 'p7a-naming-contract: dropped % forwarders, % compat views and 3 schemas', v_fns, v_views;
END
$p7a_contract$;
