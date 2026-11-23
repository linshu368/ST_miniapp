-- Domain: 全库命名——数据库重组阶段 7 第一批：去掉 schema 的 miniapp_ 前缀，6 个表名对齐契约（扩展步）。
-- 计划见 .trellis/tasks/11-23-db-reorg-p7-naming/design.md。
--
-- 一个事务里完成：
--   1. schema 改名：miniapp_analytics→analytics、miniapp_features→features、miniapp_traffic→traffic；
--   2. 6 个表/视图改名（grafana_core_daily→core_daily、v_card_quality_session→card_quality_sessions、
--      telegram_community_update_receipts→community_update_receipts、user_lobby_recommendations→lobby_recommendations、
--      character_ranking_scores→lobby_ranking_scores、user_character_exposures→lobby_exposures），
--      名字里带旧表名的约束、索引、策略一起改；看板刷新函数 refresh_grafana_core_day→refresh_core_daily；
--   3. 改写所有提到旧名字的函数（schema 限定名、审计日志里的 schema 字面量、search_path），
--      两个看板刷新定时任务换新名字和新命令；对象注释里的旧名字一起换；
--   4. 旧名字留兼容层：同名 schema 里每张表/视图一个 security_invoker 视图、每个函数一个转发函数，
--      权限与原对象逐条相同——旧后端、Grafana 在切到新名字之前照常读写；
--   5. PostgREST 暴露列表与 extra_search_path 加入新名字（旧名字保留到收缩步），重载配置；
--   6. 自检：兼容层对象数与权限逐条一致；兼容层之外没有函数、定时任务还提旧名字。
-- 已执行过（新 schema 已在、旧 schema 只剩兼容层）就跳过。热路径表改名要排他锁：lock_timeout 1 秒，失败重跑。
--
-- Verify: bash scripts/test-db-reorg-p7a-naming.sh
-- Release: TEST -> Production -> 后端发布（改用新名字）-> Grafana 看板改新名字；兼容层在收缩步删除。

DO $p7a$
DECLARE
  c_old constant text[] := ARRAY['miniapp_analytics', 'miniapp_features', 'miniapp_traffic'];
  c_new constant text[] := ARRAY['analytics', 'features', 'traffic'];
  -- {新 schema, 旧名, 新名}
  c_rel constant text[] := ARRAY[
    ['analytics', 'grafana_core_daily', 'core_daily'],
    ['analytics', 'v_card_quality_session', 'card_quality_sessions'],
    ['features', 'telegram_community_update_receipts', 'community_update_receipts'],
    ['features', 'user_lobby_recommendations', 'lobby_recommendations'],
    ['features', 'character_ranking_scores', 'lobby_ranking_scores'],
    ['features', 'user_character_exposures', 'lobby_exposures']];
  c_old_re constant text := '\mminiapp_(analytics|features|traffic)\M';
  -- 以旧表名开头的任何名字（表本身、约束、索引、策略）都算旧名字
  c_rel_re constant text := '\m(grafana_core_daily|v_card_quality_session|telegram_community_update_receipts|telegram_community_receipt|user_lobby_recommendations|character_ranking_scores|user_character_exposures|grafana_core_read|refresh_grafana_core_day)';
  c_compat_note constant text := 'p7a 兼容层：旧名字转发到新对象，后端与看板切到新名字后在收缩步删除';
  v_row text[];
  v_fns oid[];
  v_fn oid;
  v_def text;
  v_new text;
  v_oid oid;
  v_job bigint;
  v_kind "char";
  v_name text;
  v_old_name text;
  v_cmd text;
  v_list text;
  v_n int;
  v_m int;
  v_rewritten int := 0;
  v_dep_old text[] := '{}';
  v_dep_new text[] := '{}';
  v_views int := 0;
  v_wrappers int := 0;
  r record;
  g record;
BEGIN
  SET LOCAL lock_timeout = '1s';

  -- 0. 已执行过：三个新 schema 都在，旧 schema 里只有兼容层（视图 + SQL 转发函数）
  IF (SELECT count(*) FROM pg_namespace WHERE nspname = ANY (c_new)) = 3 THEN
    IF (SELECT count(*) FROM pg_namespace WHERE nspname = ANY (c_old)) = 3
       AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = ANY (c_old) AND c.relkind <> 'v')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = ANY (c_old) AND p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql')) THEN
      RAISE NOTICE 'p7a-naming: already renamed; nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'p7a-naming: new schema names exist but the old schemas are not a pure compat layer; refusing';
  END IF;

  -- 1. 前置检查
  FOR i IN 1 .. 3 LOOP
    IF to_regnamespace(c_old[i]) IS NULL THEN
      RAISE EXCEPTION 'p7a-naming: schema % is missing', c_old[i];
    END IF;
    IF to_regnamespace(c_new[i]) IS NOT NULL THEN
      RAISE EXCEPTION 'p7a-naming: schema % already exists', c_new[i];
    END IF;
  END LOOP;
  FOREACH v_row SLICE 1 IN ARRAY c_rel LOOP
    IF to_regclass(format('%I.%I', c_old[array_position(c_new, v_row[1])], v_row[2])) IS NULL THEN
      RAISE EXCEPTION 'p7a-naming: relation %.% is missing', c_old[array_position(c_new, v_row[1])], v_row[2];
    END IF;
  END LOOP;

  -- 要改写的函数：正文或 search_path 提到旧 schema 名，或正文提到要改名的表/函数
  SELECT array_agg(p.oid ORDER BY p.oid) INTO v_fns
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND (p.prosrc ~ c_old_re OR p.prosrc ~ c_rel_re OR coalesce(array_to_string(p.proconfig, ','), '') ~ c_old_re);
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_list
  FROM pg_proc p WHERE p.oid = ANY (v_fns) AND NOT pg_has_role(current_user, p.proowner, 'USAGE');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'p7a-naming: cannot rewrite functions owned by other roles: %', v_list;
  END IF;

  -- 2. 改名：schema → 表/视图（连同名字里带旧表名的约束、索引、策略）→ 看板刷新函数
  FOR i IN 1 .. 3 LOOP
    EXECUTE format('ALTER SCHEMA %I RENAME TO %I', c_old[i], c_new[i]);
  END LOOP;

  FOREACH v_row SLICE 1 IN ARRAY c_rel LOOP
    SELECT c.oid, c.relkind INTO v_oid, v_kind
    FROM pg_class c WHERE c.relnamespace = to_regnamespace(v_row[1]) AND c.relname = v_row[2];
    EXECUTE format('ALTER %s %I.%I RENAME TO %I',
      CASE v_kind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      v_row[1], v_row[2], v_row[3]);
    -- 约束（主键/唯一约束改名会连带改它背后的索引）
    FOR r IN SELECT co.conname FROM pg_constraint co WHERE co.conrelid = v_oid ORDER BY co.conname LOOP
      v_name := replace(replace(replace(r.conname, v_row[2], v_row[3]),
        'telegram_community_receipt', 'community_receipt'), 'grafana_core_read', 'core_daily_read');
      IF v_name <> r.conname THEN
        EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I', v_row[1], v_row[3], r.conname, v_name);
        v_dep_old := v_dep_old || r.conname::text;
        v_dep_new := v_dep_new || v_name;
      END IF;
    END LOOP;
    -- 不背约束的索引
    FOR r IN SELECT i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
             WHERE x.indrelid = v_oid
               AND NOT EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conindid = x.indexrelid)
             ORDER BY i.relname LOOP
      v_name := replace(replace(r.relname, v_row[2], v_row[3]), 'telegram_community_receipt', 'community_receipt');
      IF v_name <> r.relname THEN
        EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', v_row[1], r.relname, v_name);
        v_dep_old := v_dep_old || r.relname::text;
        v_dep_new := v_dep_new || v_name;
      END IF;
    END LOOP;
    -- 策略
    FOR r IN SELECT po.polname FROM pg_policy po WHERE po.polrelid = v_oid ORDER BY po.polname LOOP
      v_name := replace(replace(r.polname, v_row[2], v_row[3]), 'grafana_core_read', 'core_daily_read');
      IF v_name <> r.polname THEN
        EXECUTE format('ALTER POLICY %I ON %I.%I RENAME TO %I', r.polname, v_row[1], v_row[3], v_name);
        v_dep_old := v_dep_old || r.polname::text;
        v_dep_new := v_dep_new || v_name;
      END IF;
    END LOOP;
  END LOOP;

  FOR r IN SELECT p.oid FROM pg_proc p
           WHERE p.pronamespace = 'analytics'::regnamespace AND p.proname = 'refresh_grafana_core_day' LOOP
    EXECUTE format('ALTER FUNCTION %s RENAME TO refresh_core_daily', r.oid::regprocedure);
  END LOOP;

  -- 3. 改写函数：旧 schema 名（限定名、字面量、search_path）→ 新名；限定的旧表名/函数名 → 新名
  FOREACH v_fn IN ARRAY coalesce(v_fns, '{}') LOOP
    v_def := pg_get_functiondef(v_fn);
    v_new := regexp_replace(v_def, c_old_re, '\1', 'g');
    FOREACH v_row SLICE 1 IN ARRAY c_rel LOOP
      v_new := regexp_replace(v_new, format('\m%s\.%s\M', v_row[1], v_row[2]), v_row[1] || '.' || v_row[3], 'g');
    END LOOP;
    v_new := regexp_replace(v_new, '\manalytics\.refresh_grafana_core_day\M', 'analytics.refresh_core_daily', 'g');
    -- 按名字引用的约束/索引/策略（ON CONFLICT ON CONSTRAINT 等）
    FOR k IN 1 .. coalesce(array_length(v_dep_old, 1), 0) LOOP
      v_new := regexp_replace(v_new, '\m' || v_dep_old[k] || '\M', v_dep_new[k], 'g');
    END LOOP;
    IF v_new ~ c_old_re OR v_new ~ c_rel_re THEN
      RAISE EXCEPTION 'p7a-naming: % still names an old object after rewrite (unqualified table name?)', v_fn::regprocedure;
    END IF;
    IF v_new <> v_def THEN
      EXECUTE v_new;
      v_rewritten := v_rewritten + 1;
    END IF;
  END LOOP;

  -- 定时任务：命令换新名字；名字带 grafana 的任务换名（新建同计划任务再删旧的）
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR r IN SELECT jobid, jobname, schedule, command, active FROM cron.job
             WHERE command ~ c_old_re OR command ~ c_rel_re OR jobname ~ '^grafana_core_' ORDER BY jobid LOOP
      v_cmd := regexp_replace(r.command, c_old_re, '\1', 'g');
      FOREACH v_row SLICE 1 IN ARRAY c_rel LOOP
        v_cmd := regexp_replace(v_cmd, format('\m%s\.%s\M', v_row[1], v_row[2]), v_row[1] || '.' || v_row[3], 'g');
      END LOOP;
      v_cmd := regexp_replace(v_cmd, '\manalytics\.refresh_grafana_core_day\M', 'analytics.refresh_core_daily', 'g');
      v_name := regexp_replace(r.jobname, '^grafana_core_', 'core_daily_');
      IF v_name IS DISTINCT FROM r.jobname THEN
        v_job := cron.schedule(v_name, r.schedule, v_cmd);
        PERFORM cron.alter_job(v_job, active := r.active);
        PERFORM cron.unschedule(r.jobid);
      ELSE
        PERFORM cron.alter_job(r.jobid, command := v_cmd);
      END IF;
    END LOOP;
  END IF;

  -- 注释里的旧名字（表、列、函数、schema）
  FOR r IN SELECT d.classoid, d.objoid, d.objsubid, d.description FROM pg_description d
           WHERE d.description ~ c_old_re OR d.description ~ c_rel_re LOOP
    v_new := regexp_replace(r.description, c_old_re, '\1', 'g');
    FOREACH v_row SLICE 1 IN ARRAY c_rel LOOP
      v_new := regexp_replace(v_new, format('\m%s\.%s\M', v_row[1], v_row[2]), v_row[1] || '.' || v_row[3], 'g');
    END LOOP;
    v_new := regexp_replace(v_new, '\manalytics\.refresh_grafana_core_day\M', 'analytics.refresh_core_daily', 'g');
    IF r.classoid = 'pg_class'::regclass AND r.objsubid = 0 THEN
      SELECT CASE relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE'
                          WHEN 'i' THEN 'INDEX' ELSE 'TABLE' END INTO v_cmd FROM pg_class WHERE oid = r.objoid;
      EXECUTE format('COMMENT ON %s %s IS %L', v_cmd, r.objoid::regclass, v_new);
    ELSIF r.classoid = 'pg_class'::regclass THEN
      EXECUTE format('COMMENT ON COLUMN %s.%I IS %L', r.objoid::regclass,
        (SELECT attname FROM pg_attribute WHERE attrelid = r.objoid AND attnum = r.objsubid), v_new);
    ELSIF r.classoid = 'pg_proc'::regclass THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.objoid::regprocedure, v_new);
    ELSIF r.classoid = 'pg_namespace'::regclass THEN
      EXECUTE format('COMMENT ON SCHEMA %I IS %L', (SELECT nspname FROM pg_namespace WHERE oid = r.objoid), v_new);
    END IF;
  END LOOP;

  -- 4. 兼容层：旧 schema 名下每个关系一个视图、每个非触发器函数一个转发函数，权限照抄
  FOR i IN 1 .. 3 LOOP
    EXECUTE format('CREATE SCHEMA %I', c_old[i]);
    EXECUTE format('COMMENT ON SCHEMA %I IS %L', c_old[i], format('%s（%s）', c_compat_note, c_new[i]));
    FOR g IN SELECT a.grantee, a.privilege_type, a.is_grantable
             FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = c_new[i] AND a.grantee <> n.nspowner LOOP
      EXECUTE format('GRANT %s ON SCHEMA %I TO %s%s', g.privilege_type, c_old[i],
        CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END,
        CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;

    FOR r IN SELECT c.oid, c.relname, c.relacl, c.relowner FROM pg_class c
             WHERE c.relnamespace = to_regnamespace(c_new[i]) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             ORDER BY c.relname LOOP
      v_old_name := r.relname;
      FOREACH v_row SLICE 1 IN ARRAY c_rel LOOP
        IF v_row[1] = c_new[i] AND v_row[3] = r.relname THEN v_old_name := v_row[2]; END IF;
      END LOOP;
      EXECUTE format('CREATE VIEW %I.%I WITH (security_invoker = true) AS SELECT * FROM %I.%I',
        c_old[i], v_old_name, c_new[i], r.relname);
      EXECUTE format('COMMENT ON VIEW %I.%I IS %L', c_old[i], v_old_name, format('%s（%s.%s）', c_compat_note, c_new[i], r.relname));
      v_oid := format('%I.%I', c_old[i], v_old_name)::regclass;
      FOR g IN SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a
               WHERE c.oid = v_oid AND a.grantee <> c.relowner LOOP
        EXECUTE format('REVOKE ALL ON %s FROM %s', v_oid::regclass,
          CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
      END LOOP;
      FOR g IN SELECT a.grantee, a.privilege_type, a.is_grantable FROM aclexplode(r.relacl) a
               WHERE a.grantee <> r.relowner LOOP
        EXECUTE format('GRANT %s ON %s TO %s%s', g.privilege_type, v_oid::regclass,
          CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END,
          CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
      v_views := v_views + 1;
    END LOOP;

    FOR r IN SELECT p.oid, p.proname, p.proacl, p.proowner, p.provolatile, p.proisstrict, p.prorettype,
                    p.pronargs, p.proargtypes
             FROM pg_proc p
             WHERE p.pronamespace = to_regnamespace(c_new[i]) AND p.prokind = 'f'
               AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
             ORDER BY p.proname, p.oid LOOP
      v_old_name := CASE WHEN c_new[i] = 'analytics' AND r.proname = 'refresh_core_daily'
                         THEN 'refresh_grafana_core_day' ELSE r.proname END;
      SELECT coalesce(string_agg('$' || k, ', ' ORDER BY k), '') INTO v_list FROM generate_series(1, r.pronargs) k;
      EXECUTE format('CREATE FUNCTION %I.%I(%s) RETURNS %s LANGUAGE sql %s%s AS %L',
        c_old[i], v_old_name, pg_get_function_arguments(r.oid), pg_get_function_result(r.oid),
        CASE r.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END,
        CASE WHEN r.proisstrict THEN ' STRICT' ELSE '' END,
        CASE WHEN r.prorettype = 'void'::regtype
             THEN format('SELECT %I.%I(%s)', c_new[i], r.proname, v_list)
             ELSE format('SELECT * FROM %I.%I(%s)', c_new[i], r.proname, v_list) END);
      SELECT p.oid INTO v_oid FROM pg_proc p
      WHERE p.pronamespace = to_regnamespace(c_old[i]) AND p.proname = v_old_name AND p.proargtypes = r.proargtypes;
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', v_oid::regprocedure,
        format('%s（%s）', c_compat_note, r.oid::regprocedure));
      -- proacl 为空 = 默认权限（PUBLIC 可执行），新建函数本来就是；否则清掉默认授权再照抄
      IF r.proacl IS NOT NULL THEN
        FOR g IN SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = v_oid AND a.grantee <> p.proowner LOOP
          EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', v_oid::regprocedure,
            CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
        END LOOP;
        FOR g IN SELECT a.grantee, a.privilege_type, a.is_grantable FROM aclexplode(r.proacl) a
                 WHERE a.grantee <> r.proowner LOOP
          EXECUTE format('GRANT %s ON FUNCTION %s TO %s%s', g.privilege_type, v_oid::regprocedure,
            CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END,
            CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
        END LOOP;
      END IF;
      v_wrappers := v_wrappers + 1;
    END LOOP;
  END LOOP;

  -- 5. PostgREST：暴露列表与 extra_search_path 里每个旧名字前插入新名字（旧名字留到收缩步）
  FOR r IN SELECT split_part(c, '=', 1) AS key, substr(c, length(split_part(c, '=', 1)) + 2) AS val
           FROM pg_roles ro, unnest(ro.rolconfig) c
           WHERE ro.rolname = 'authenticator' AND split_part(c, '=', 1) IN ('pgrst.db_schemas', 'pgrst.db_extra_search_path') LOOP
    SELECT string_agg(CASE WHEN array_position(c_old, y.s) IS NOT NULL
                                AND NOT c_new[array_position(c_old, y.s)] = ANY (
                                  SELECT btrim(e) FROM unnest(string_to_array(r.val, ',')) e)
                           THEN c_new[array_position(c_old, y.s)] || ', ' || y.s ELSE y.s END, ', ' ORDER BY x.k)
    INTO v_list
    FROM unnest(string_to_array(r.val, ',')) WITH ORDINALITY AS x(raw, k), LATERAL (SELECT btrim(x.raw) AS s) y;
    IF v_list IS DISTINCT FROM r.val THEN
      RAISE NOTICE 'p7a-naming: authenticator % was: %', r.key, r.val;
      EXECUTE format('ALTER ROLE authenticator SET %s = %L', r.key, v_list);
    END IF;
  END LOOP;
  PERFORM pg_notify('pgrst', 'reload config');
  PERFORM pg_notify('pgrst', 'reload schema');

  -- 6. 自检
  FOR i IN 1 .. 3 LOOP
    SELECT count(*) INTO v_n FROM pg_class WHERE relnamespace = to_regnamespace(c_new[i]) AND relkind IN ('r', 'p', 'v', 'm', 'f');
    SELECT count(*) INTO v_m FROM pg_class WHERE relnamespace = to_regnamespace(c_old[i]) AND relkind = 'v';
    IF v_n <> v_m OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = to_regnamespace(c_old[i]) AND relkind NOT IN ('v')) THEN
      RAISE EXCEPTION 'p7a-naming: % has % relations but % has % compat views', c_new[i], v_n, c_old[i], v_m;
    END IF;
  END LOOP;
  -- 兼容视图与原对象权限逐条相同
  SELECT string_agg(format('%s.%s', o.nspname, oc.relname), ', ') INTO v_list
  FROM pg_class oc JOIN pg_namespace o ON o.oid = oc.relnamespace AND o.nspname = ANY (c_old)
  JOIN pg_rewrite rw ON rw.ev_class = oc.oid
  JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid AND d.refclassid = 'pg_class'::regclass
    AND d.refobjid <> oc.oid AND d.deptype = 'n'
  JOIN pg_class nc ON nc.oid = d.refobjid
  WHERE (SELECT coalesce(array_agg(format('%s:%s:%s', a.grantee, a.privilege_type, a.is_grantable) ORDER BY 1), '{}')
         FROM aclexplode(oc.relacl) a WHERE a.grantee <> oc.relowner)
     IS DISTINCT FROM
        (SELECT coalesce(array_agg(format('%s:%s:%s', a.grantee, a.privilege_type, a.is_grantable) ORDER BY 1), '{}')
         FROM aclexplode(nc.relacl) a WHERE a.grantee <> nc.relowner);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'p7a-naming: compat view grants differ from their targets: %', v_list;
  END IF;
  -- 转发函数与原函数权限逐条相同（空 ACL 按默认权限展开再比）
  SELECT string_agg(w.oid::regprocedure::text, ', ') INTO v_list
  FROM pg_proc w JOIN pg_namespace o ON o.oid = w.pronamespace AND o.nspname = ANY (c_old)
  JOIN pg_proc t ON t.pronamespace = to_regnamespace(c_new[array_position(c_old, o.nspname::text)])
    AND t.proname = CASE WHEN w.proname = 'refresh_grafana_core_day' THEN 'refresh_core_daily' ELSE w.proname END
    AND t.proargtypes = w.proargtypes
  WHERE (SELECT array_agg(format('%s:%s:%s', a.grantee, a.privilege_type, a.is_grantable) ORDER BY 1)
         FROM aclexplode(coalesce(w.proacl, acldefault('f', w.proowner))) a WHERE a.grantee <> w.proowner)
     IS DISTINCT FROM
        (SELECT array_agg(format('%s:%s:%s', a.grantee, a.privilege_type, a.is_grantable) ORDER BY 1)
         FROM aclexplode(coalesce(t.proacl, acldefault('f', t.proowner))) a WHERE a.grantee <> t.proowner);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'p7a-naming: forwarder grants differ from their targets: %', v_list;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = ANY (c_new) AND p.prokind = 'f' AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype);
  SELECT count(*) INTO v_m FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ANY (c_old);
  IF v_n <> v_m THEN
    RAISE EXCEPTION 'p7a-naming: % callable functions but % forwarders', v_n, v_m;
  END IF;
  -- 兼容层之外不再有函数、定时任务提旧名字
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname <> ALL (c_old)
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    AND (p.prosrc ~ c_old_re OR p.prosrc ~ c_rel_re OR coalesce(array_to_string(p.proconfig, ','), '') ~ c_old_re);
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'p7a-naming: functions still name old objects: %', v_list;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL
     AND EXISTS (SELECT 1 FROM cron.job WHERE command ~ c_old_re OR command ~ c_rel_re OR jobname ~ '^grafana_core_') THEN
    RAISE EXCEPTION 'p7a-naming: cron jobs still name old objects';
  END IF;

  RAISE NOTICE 'p7a-naming: renamed 3 schemas and % relations, rewrote % functions; compat layer has % views and % forwarders',
    array_length(c_rel, 1), v_rewritten, v_views, v_wrappers;
END
$p7a$;
