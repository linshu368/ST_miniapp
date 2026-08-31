-- 099 回滚：把 099_schema_split_phase1.sql 已提交的效果整体反向撤销。
-- 对象搬回 miniapp、函数体与人群 SQL 的限定名改回 miniapp.*、删掉四个新建 schema。
--
-- 权威归属：docs/schema归属地图.md
-- 执行计划：docs/schema划分-一阶段执行计划.md（本文件对应 §六.2「提交后失败」）
-- 正向迁移：099_schema_split_phase1.sql（本文件的每一步与它逐节对应）
--
-- ============================ 什么时候用 ============================
-- 只在 099 **已 COMMIT** 之后发现问题时用，且必须仍处于停流量状态：
--   1. 保持入口流量与后台任务停止；
--   2. 执行本文件（单事务）；
--   3. 事务外回退 PostgREST 暴露列表与生产 cron job 5（见文件末尾）；
--   4. 部署 099 之前的旧代码制品。
-- 事务提交前失败不需要本文件——099 全程单事务，PostgreSQL 会自动回滚。
--
-- ============================ 为什么是文本反向，而不是内嵌旧函数体 ============================
-- 双库实测（批次A-双库基线与差异.md §三 A3）确认 13 个函数的函数体在 test 与 production
-- 并不相同。把旧函数体字面写进回滚脚本就必须维护两份、且随时会与库里的真实源码脱节。
-- 所以本文件与 099 一样只做**限定名的文本改写**，两库通用。
--
-- 反向改写是精确可逆的，前提是三条：
--   · 099 的 5a 把 miniapp.<obj> 换成 <target>.<obj>。四个新 schema 在 099 之前不存在
--     （§1.4 断言），所以改写后出现的 <target>.<obj> 只可能来自 099，反向替换不会误伤。
--   · 099 的 5b 把审计字面量 'miniapp', '<obj>' 换成 '<target>', '<obj>'，同理可逆。
--   · 099 的 5c 只动 SET search_path TO 'miniapp', 'public'，命中的函数集合由 099 preflight
--     断言为固定三个（§1.5b）。本文件按同一份名单反向恢复。
-- 因此**本文件的映射表必须与 099 §0 逐行一致**：改了一边就要改另一边，
-- 两边的 preflight 都会因为集合不符而停下来。
--
-- ============================ 不幂等 ============================
-- 单事务：任一步失败整体回滚，库回到执行前形态。成功提交后不可重跑
-- （起点已不存在，preflight 会拒绝）。要重来必须先重新执行 099。
--
-- ============================ 会删掉四个新 schema ============================
-- app_core / miniapp_features / experience / billing 由 099 创建，本文件用
-- DROP SCHEMA ... RESTRICT 删除（绝不 CASCADE）。里面残留任何对象都会先被 preflight 拦下，
-- 由人判断那个对象该去哪，而不是被脚本顺手删掉。
-- cs_platform / admin / miniapp_traffic / miniapp_analytics 是既有 schema，只把
-- support_conversations / support_messages 搬回 miniapp，其余一概不动。
--
-- ============================ 临时表命名 ============================
-- 本文件的临时表统一用 _unsplit_ 前缀，与 099 的 _split_ 不冲突，
-- 因此可以在同一个事务里先跑 099 再跑本文件做往返空跑：
--   bash ops/schema-split/dryrun-099-roundtrip.sh test

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '600s';

-- ===================================================================
-- 0. 反向映射：必须与 099 §0 的三张表逐行一致
-- ===================================================================

CREATE TEMP TABLE _unsplit_rel (obj text PRIMARY KEY, source text NOT NULL, kind "char" NOT NULL)
  ON COMMIT DROP;

INSERT INTO _unsplit_rel (obj, source, kind) VALUES
  ('users',                              'app_core',         'r'),
  ('miniapp_user_settings',              'app_core',         'r'),
  ('characters',                         'app_core',         'r'),
  ('runtime_config',                     'app_core',         'r'),
  ('character_favorites',                'miniapp_features', 'r'),
  ('character_ranking_scores',           'miniapp_features', 'r'),
  ('daily_checkins',                     'miniapp_features', 'r'),
  ('wish_roles',                         'miniapp_features', 'r'),
  ('notifications',                      'miniapp_features', 'r'),
  ('notification_reads',                 'miniapp_features', 'r'),
  ('chat_sessions',                      'experience',       'r'),
  ('chat_history',                       'experience',       'r'),
  ('chat_message_audio',                 'experience',       'r'),
  ('current_chat_history',               'experience',       'v'),
  ('payment_orders',                     'billing',          'r'),
  ('wallet_ledger',                      'billing',          'r'),
  ('user_wallets',                       'billing',          'r'),
  ('llm_usage_charges',                  'billing',          'r'),
  ('llm_usage_charge_dedup',             'billing',          'r'),
  ('character_free_chat_quotas',         'billing',          'r'),
  ('character_free_chat_quota_decisions','billing',          'r'),
  ('support_conversations',              'cs_platform',      'r'),
  ('support_messages',                   'cs_platform',      'r');

CREATE TEMP TABLE _unsplit_fn (
  obj text PRIMARY KEY,
  source text NOT NULL,
  required boolean NOT NULL DEFAULT true
) ON COMMIT DROP;

INSERT INTO _unsplit_fn (obj, source) VALUES
  ('increment_user_total_round',              'app_core'),
  ('tf_track_character_listing',              'app_core'),
  ('claim_daily_checkin',                     'miniapp_features'),
  ('complete_wish_role',                      'miniapp_features'),
  ('create_wish_role',                        'miniapp_features'),
  ('get_character_favorite_counts',           'miniapp_features'),
  ('list_character_favorites',                'miniapp_features'),
  ('set_character_favorite',                  'miniapp_features'),
  ('apply_context_window_flood',              'experience'),
  ('guard_chat_session_idle',                 'experience'),
  ('start_chat_history_regeneration',         'experience'),
  ('start_chat_history_turn',                 'experience'),
  ('tf_refresh_chat_session_stats_from_history', 'experience'),
  ('charge_llm_usage',                        'billing'),
  ('complete_payment_order',                  'billing'),
  ('deduct_wallet_credits',                   'billing'),
  ('expire_payment_orders',                   'billing'),
  ('finalize_character_free_chat_round',      'billing'),
  ('grant_new_user_signup_bonus',             'billing'),
  ('grant_wallet_on_user_insert',             'billing'),
  ('prepare_llm_usage_charge',                'billing'),
  ('reconcile_llm_usage',                     'billing'),
  ('reserve_character_free_chat_round',       'billing'),
  ('retain_recent_llm_usage_charges',         'billing');

-- 与 099 一致：test 独有的语音扣费 RPC，有则搬回，没有则跳过。
INSERT INTO _unsplit_fn (obj, source, required) VALUES
  ('charge_voice_usage', 'billing', false);

CREATE TEMP TABLE _unsplit_name (obj text PRIMARY KEY, source text NOT NULL) ON COMMIT DROP;
INSERT INTO _unsplit_name SELECT obj, source FROM _unsplit_rel;
INSERT INTO _unsplit_name SELECT obj, source FROM _unsplit_fn;

-- 099 §5c 改过 search_path 的函数（由 099 preflight §1.5b 断言恰好是这三个）。
CREATE TEMP TABLE _unsplit_searchpath (obj text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _unsplit_searchpath (obj) VALUES
  ('increment_user_total_round'),
  ('grant_new_user_signup_bonus'),
  ('grant_wallet_on_user_insert');

CREATE TEMP TABLE _unsplit_baseline (metric text PRIMARY KEY, val bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE _unsplit_persona_baseline (id uuid PRIMARY KEY, valid boolean NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE _unsplit_view_baseline (nsp text, rel text, queryable boolean NOT NULL,
                                          PRIMARY KEY (nsp, rel)) ON COMMIT DROP;

-- ===================================================================
-- 1. preflight：确认现在确实处于「099 已提交」的形态
-- ===================================================================

DO $preflight$
DECLARE
  v_txt text;
  v_n   bigint;
  v_ok  boolean;
  r     RECORD;
BEGIN
  -- 1.1 miniapp schema 还在（批次 D 删掉 miniapp 之后本文件不再适用）
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'miniapp') THEN
    RAISE EXCEPTION '099 回滚 preflight: miniapp schema 已不存在（批次 D 已收口？），本脚本不适用';
  END IF;

  -- 1.2 起点必须是「099 已提交」：miniapp 空壳，四个新 schema 都在
  SELECT count(*) INTO v_n FROM pg_class c
  WHERE c.relnamespace = 'miniapp'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S');
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 回滚 preflight: miniapp 下还有 % 个表/视图，说明 099 未提交或已被回滚', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p WHERE p.pronamespace = 'miniapp'::regnamespace;
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 回滚 preflight: miniapp 下还有 % 个函数，说明 099 未提交或已被回滚', v_n;
  END IF;

  FOR r IN SELECT unnest(ARRAY['app_core', 'miniapp_features', 'experience', 'billing']) AS nsp LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = r.nsp) THEN
      RAISE EXCEPTION '099 回滚 preflight: schema % 不存在，099 未提交或已被回滚', r.nsp;
    END IF;
  END LOOP;

  -- 1.3 映射里的每个对象都必须在 099 指定的位置、类型未变
  SELECT string_agg(m.source || '.' || m.obj, ', ' ORDER BY m.obj) INTO v_txt
  FROM _unsplit_rel m
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c
                     WHERE c.relnamespace = m.source::regnamespace
                       AND c.relname = m.obj AND c.relkind = m.kind);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 preflight: 这些对象不在 099 迁入的位置：%', v_txt;
  END IF;

  SELECT string_agg(m.source || '.' || m.obj, ', ' ORDER BY m.obj) INTO v_txt
  FROM _unsplit_fn m
  WHERE m.required
    AND NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.pronamespace = m.source::regnamespace AND p.proname = m.obj);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 preflight: 这些函数不在 099 迁入的位置：%', v_txt;
  END IF;

  FOR r IN
    SELECT m.obj, m.source,
           EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.pronamespace = m.source::regnamespace AND p.proname = m.obj) AS present
    FROM _unsplit_fn m
    WHERE NOT m.required
  LOOP
    IF r.present THEN
      RAISE NOTICE '099 回滚 preflight: 可选函数 %.% 存在，一并搬回', r.source, r.obj;
    ELSE
      RAISE NOTICE '099 回滚 preflight: 可选函数 % 不存在，跳过', r.obj;
    END IF;
  END LOOP;

  DELETE FROM _unsplit_fn m
  WHERE NOT m.required
    AND NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.pronamespace = m.source::regnamespace AND p.proname = m.obj);
  DELETE FROM _unsplit_name m
  WHERE NOT EXISTS (SELECT 1 FROM _unsplit_rel r2 WHERE r2.obj = m.obj)
    AND NOT EXISTS (SELECT 1 FROM _unsplit_fn f2 WHERE f2.obj = m.obj);

  -- 1.4 四个新 schema 里不允许有映射之外的对象。
  -- 它们马上要被 DROP，多出来的东西必须由人决定去哪，脚本不擅自处置。
  SELECT string_agg(n.nspname || '.' || c.relname || '(' || c.relkind::text || ')',
                    ', ' ORDER BY n.nspname, c.relname) INTO v_txt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('app_core', 'miniapp_features', 'experience', 'billing')
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT EXISTS (SELECT 1 FROM _unsplit_rel m
                     WHERE m.obj = c.relname AND m.source = n.nspname);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 preflight: 新 schema 里有 099 没搬进去的对象：%。先决定它们的归属，再回滚', v_txt;
  END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_txt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('app_core', 'miniapp_features', 'experience', 'billing')
    AND NOT EXISTS (SELECT 1 FROM _unsplit_fn m
                     WHERE m.obj = p.proname AND m.source = n.nspname);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 preflight: 新 schema 里有 099 没搬进去的函数：%。先决定它们的归属，再回滚', v_txt;
  END IF;

  -- 同名重载会让「按函数名映射」失真（与 099 §1.5 同口径）
  SELECT count(*) INTO v_n
  FROM (SELECT p.pronamespace, p.proname FROM pg_proc p
        WHERE p.pronamespace IN ('app_core'::regnamespace, 'miniapp_features'::regnamespace,
                                 'experience'::regnamespace, 'billing'::regnamespace)
        GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 回滚 preflight: 新 schema 下存在同名重载函数 % 组，映射键不再唯一', v_n;
  END IF;

  -- 1.5 099 §5c 的三个函数必须仍是 099 改写后的样子，否则名单已经过期
  FOR r IN
    SELECT m.obj, m.source, p.oid
    FROM _unsplit_searchpath sp
    JOIN _unsplit_fn m ON m.obj = sp.obj
    JOIN pg_proc p ON p.proname = m.obj AND p.pronamespace = m.source::regnamespace
  LOOP
    IF pg_get_functiondef(r.oid) NOT LIKE
       ('%SET search_path TO ''' || r.source || ''', ''public''%') THEN
      RAISE EXCEPTION '099 回滚 preflight: %.% 的 search_path 不是 099 写入的 ''%'', ''public''，名单已过期',
        r.source, r.obj, r.source;
    END IF;
  END LOOP;

  -- 1.6 miniapp 下不允许残留 SET SCHEMA 带不走的对象（与 099 §1.6 同口径）
  SELECT string_agg(t.typname, ', ' ORDER BY t.typname) INTO v_txt
  FROM pg_type t
  WHERE t.typnamespace = 'miniapp'::regnamespace
    AND t.typtype IN ('e', 'd', 'r');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 preflight: miniapp 下有自定义类型 %，与 099 的前提不符', v_txt;
  END IF;

  -- 1.7 依赖计数基线：搬回之后必须一个不少
  INSERT INTO _unsplit_baseline (metric, val)
  SELECT 'triggers_on_moved', count(*)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN _unsplit_rel m ON m.obj = c.relname AND c.relnamespace = m.source::regnamespace
  WHERE NOT t.tgisinternal;

  -- 全库 FK 总数：搬 schema 不增删约束，回滚后必须一模一样。
  -- 这是比「跨 schema FK 条数」更强的守卫——后者在回滚方向上本就应该下降
  -- （22 张表重新聚回 miniapp，原本跨域的 FK 又变成同 schema 内部的）。
  INSERT INTO _unsplit_baseline (metric, val)
  SELECT 'fks_db_total', count(*) FROM pg_constraint WHERE contype = 'f';

  INSERT INTO _unsplit_baseline (metric, val)
  SELECT 'cross_schema_fks', count(*)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_class fc ON fc.oid = con.confrelid
  WHERE con.contype = 'f' AND c.relnamespace <> fc.relnamespace;

  INSERT INTO _unsplit_baseline (metric, val)
  SELECT 'fks_total_on_moved', count(*)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN _unsplit_rel m ON m.obj = c.relname AND c.relnamespace = m.source::regnamespace
  WHERE con.contype = 'f';

  INSERT INTO _unsplit_baseline (metric, val)
  SELECT 'indexes_on_moved', count(*)
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN _unsplit_rel m ON m.obj = c.relname AND c.relnamespace = m.source::regnamespace;

  -- 1.8 人群 SQL 与视图可查性基线：只追究「回滚前能用、回滚后不能用」的
  FOR r IN SELECT p.id, p.sql_text FROM cs_platform.personas p LOOP
    IF coalesce(btrim(r.sql_text), '') = '' THEN
      v_ok := true;
    ELSE
      BEGIN
        PERFORM cs_platform.validate_persona_sql(r.sql_text);
        v_ok := true;
      EXCEPTION WHEN OTHERS THEN
        v_ok := false;
      END;
    END IF;
    INSERT INTO _unsplit_persona_baseline (id, valid) VALUES (r.id, v_ok);
  END LOOP;

  SELECT count(*) INTO v_n FROM _unsplit_persona_baseline WHERE NOT valid;
  IF v_n > 0 THEN
    RAISE NOTICE '099 回滚 preflight: % 条人群规则在回滚前就无法通过校验，postflight 不追究这些', v_n;
  END IF;

  FOR r IN
    SELECT n.nspname AS nsp, c.relname AS rel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v'
      AND n.nspname IN ('miniapp', 'admin', 'cs_platform', 'miniapp_traffic',
                        'miniapp_analytics', 'public', 'experience')
  LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM %I.%I LIMIT 0', r.nsp, r.rel);
      v_ok := true;
    EXCEPTION WHEN OTHERS THEN
      v_ok := false;
    END;
    -- experience.current_chat_history 回滚后落回 miniapp，按回滚后的位置登记
    INSERT INTO _unsplit_view_baseline (nsp, rel, queryable)
    VALUES (CASE WHEN EXISTS (SELECT 1 FROM _unsplit_rel m
                               WHERE m.obj = r.rel AND m.kind = 'v' AND m.source = r.nsp)
                 THEN 'miniapp' ELSE r.nsp END,
            r.rel, v_ok);
  END LOOP;

  SELECT count(*) INTO v_n FROM _unsplit_view_baseline WHERE NOT queryable;
  IF v_n > 0 THEN
    RAISE NOTICE '099 回滚 preflight: % 个视图在回滚前就查不了，postflight 不追究这些', v_n;
  END IF;

  RAISE NOTICE '099 回滚 preflight 通过：待搬回 % 表/视图、% 函数',
    (SELECT count(*) FROM _unsplit_rel), (SELECT count(*) FROM _unsplit_fn);
END
$preflight$;

-- ===================================================================
-- 2. 搬回表与视图（099 §3 的反向；先视图后表）
-- ===================================================================

DO $move_rel$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT obj, source, kind FROM _unsplit_rel ORDER BY kind DESC, obj LOOP
    IF r.kind = 'v' THEN
      EXECUTE format('ALTER VIEW %I.%I SET SCHEMA miniapp', r.source, r.obj);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I SET SCHEMA miniapp', r.source, r.obj);
    END IF;
  END LOOP;
END
$move_rel$;

-- ===================================================================
-- 3. 搬回函数（099 §4 的反向，同样保留 OID / owner / grants / 触发器依赖）
-- ===================================================================

DO $move_fn$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM _unsplit_fn m
    JOIN pg_proc p ON p.proname = m.obj AND p.pronamespace = m.source::regnamespace
    ORDER BY m.obj
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET SCHEMA miniapp', r.sig);
  END LOOP;
END
$move_fn$;

-- ===================================================================
-- 4. 函数体改回 miniapp.*（099 §5 的反向）
-- ===================================================================

DO $rewrite_fn$
DECLARE
  r          RECORD;
  m          RECORD;
  v_def      text;
  v_pat      text;
  v_rep      text;
  v_scan_dot text;
  v_scan_lit text;
  v_sp       text;
  v_cnt      int := 0;
BEGIN
  -- 扫描用的正则：099 改写后可能留下的两种形态
  SELECT string_agg($q$\m$q$ || source || $q$\.$q$ || obj || $q$\M$q$, '|')
    INTO v_scan_dot FROM _unsplit_name;
  SELECT string_agg($q$'$q$ || source || $q$'\s*,\s*'$q$ || obj || $q$'$q$, '|')
    INTO v_scan_lit FROM _unsplit_name;

  FOR r IN
    SELECT p.oid, p.proname, n.nspname AS nsp, p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%'
      AND n.nspname <> 'aiero'
      AND (p.prosrc ~ v_scan_dot
           OR p.prosrc ~ v_scan_lit
           OR (p.pronamespace = 'miniapp'::regnamespace
               AND p.proname IN (SELECT obj FROM _unsplit_searchpath)))
    ORDER BY 3, 4
  LOOP
    v_def := pg_get_functiondef(r.oid);

    FOR m IN SELECT obj, source FROM _unsplit_name ORDER BY length(obj) DESC, obj LOOP
      -- 4a. 反向 5a：限定名
      v_pat := $q$\m$q$ || m.source || $q$\.$q$ || m.obj || $q$\M$q$;
      v_def := regexp_replace(v_def, v_pat, 'miniapp.' || m.obj, 'g');

      -- 4b. 反向 5b：admin RPC 写进 admin.audit_logs.schema_name 的字面量
      v_pat := $q$'$q$ || m.source || $q$'(\s*,\s*)'$q$ || m.obj || $q$'$q$;
      v_rep := $q$'miniapp'\1'$q$ || m.obj || $q$'$q$;
      v_def := regexp_replace(v_def, v_pat, v_rep, 'g');
    END LOOP;

    -- 4c. 反向 5c：只恢复 099 确实改过的那三个函数的 search_path
    -- 别名不能叫 m：本块把 m 声明成了 RECORD，plpgsql 会认为 m.obj 有歧义
    SELECT f.source INTO v_sp
    FROM _unsplit_searchpath sp
    JOIN _unsplit_fn f ON f.obj = sp.obj
    WHERE sp.obj = r.proname;
    IF v_sp IS NOT NULL THEN
      v_def := replace(v_def,
                       $q$SET search_path TO '$q$ || v_sp || $q$', 'public'$q$,
                       $q$SET search_path TO 'miniapp', 'public'$q$);
    END IF;

    IF v_def ~ v_scan_dot OR v_def ~ v_scan_lit THEN
      RAISE EXCEPTION '099 回滚: 函数 % 改写后仍残留新 schema 引用，映射不完整', r.sig;
    END IF;

    EXECUTE v_def;
    v_cnt := v_cnt + 1;
  END LOOP;

  RAISE NOTICE '099 回滚: 改回 % 个函数体', v_cnt;
END
$rewrite_fn$;

-- ===================================================================
-- 5. 人群 SQL 改回 miniapp.*（099 §6 的反向）
-- ===================================================================
-- 与 099 一致：只动 cs_platform.personas.sql_text。
-- persona_refresh_runs.sql_text 与 admin.audit_logs 历史行都是审计记录，不动。

DO $rewrite_persona$
DECLARE
  m     RECORD;
  v_pat text;
  v_n   bigint := 0;
  v_i   bigint;
BEGIN
  FOR m IN SELECT obj, source FROM _unsplit_name ORDER BY length(obj) DESC, obj LOOP
    v_pat := $q$\m$q$ || m.source || $q$\.$q$ || m.obj || $q$\M$q$;
    UPDATE cs_platform.personas
       SET sql_text = regexp_replace(sql_text, v_pat, 'miniapp.' || m.obj, 'g')
     WHERE sql_text ~ v_pat;
    GET DIAGNOSTICS v_i = ROW_COUNT;
    v_n := v_n + v_i;
  END LOOP;

  RAISE NOTICE '099 回滚: 改回人群规则 % 处', v_n;
END
$rewrite_persona$;

-- ===================================================================
-- 6. 删掉 099 创建的四个 schema
-- ===================================================================
-- RESTRICT（而非 CASCADE）：残留对象一律让 DROP 失败并整体回滚，
-- 由人决定去处。§1.4 已经先做过一次同样的检查，这里是最后一道闸。

DROP SCHEMA app_core         RESTRICT;
DROP SCHEMA miniapp_features RESTRICT;
DROP SCHEMA experience       RESTRICT;
DROP SCHEMA billing          RESTRICT;

-- ===================================================================
-- 7. postflight：形态必须回到 099 执行之前，且 099 可以再次执行
-- ===================================================================

DO $postflight$
DECLARE
  r      RECORD;
  v_txt  text;
  v_n    bigint;
  v_base bigint;
  v_scan_dot text;
  v_scan_lit text;
BEGIN
  SELECT string_agg($q$\m$q$ || source || $q$\.$q$ || obj || $q$\M$q$, '|')
    INTO v_scan_dot FROM _unsplit_name;
  SELECT string_agg($q$'$q$ || source || $q$'\s*,\s*'$q$ || obj || $q$'$q$, '|')
    INTO v_scan_lit FROM _unsplit_name;

  -- 7.1 四个 schema 已消失
  SELECT string_agg(n.nspname, ', ' ORDER BY n.nspname) INTO v_txt
  FROM pg_namespace n
  WHERE n.nspname IN ('app_core', 'miniapp_features', 'experience', 'billing');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 postflight: schema % 仍存在', v_txt;
  END IF;

  -- 7.2 每个对象都回到 miniapp，且类型未变
  SELECT string_agg(m.obj, ', ' ORDER BY m.obj) INTO v_txt
  FROM _unsplit_rel m
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c
                     WHERE c.relnamespace = 'miniapp'::regnamespace
                       AND c.relname = m.obj AND c.relkind = m.kind);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 postflight: 这些对象没回到 miniapp：%', v_txt;
  END IF;

  SELECT string_agg(m.obj, ', ' ORDER BY m.obj) INTO v_txt
  FROM _unsplit_fn m
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.pronamespace = 'miniapp'::regnamespace AND p.proname = m.obj);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 postflight: 这些函数没回到 miniapp：%', v_txt;
  END IF;

  -- miniapp 里不应多出映射之外的东西（等价于 099 §1.4/§1.5 的「多一个就停」）
  SELECT string_agg(c.relname || '(' || c.relkind::text || ')', ', ' ORDER BY c.relname) INTO v_txt
  FROM pg_class c
  WHERE c.relnamespace = 'miniapp'::regnamespace
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT EXISTS (SELECT 1 FROM _unsplit_rel m WHERE m.obj = c.relname);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 postflight: miniapp 多出映射之外的对象：%', v_txt;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_txt
  FROM pg_proc p
  WHERE p.pronamespace = 'miniapp'::regnamespace
    AND NOT EXISTS (SELECT 1 FROM _unsplit_fn m WHERE m.obj = p.proname);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 postflight: miniapp 多出映射之外的函数：%', v_txt;
  END IF;

  -- 7.3 全库不允许残留指向新 schema 的文本引用
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_txt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_%'
    AND n.nspname <> 'aiero'
    AND (p.prosrc ~ v_scan_dot OR p.prosrc ~ v_scan_lit);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 postflight: 函数体仍引用新 schema：%', v_txt;
  END IF;

  SELECT string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY n.nspname, c.relname) INTO v_txt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm')
    AND n.nspname NOT LIKE 'pg\_%'
    AND n.nspname NOT IN ('information_schema', 'aiero')
    AND pg_get_viewdef(c.oid) ~ v_scan_dot;
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 回滚 postflight: 视图定义仍引用新 schema：%', v_txt;
  END IF;

  SELECT count(*) INTO v_n FROM cs_platform.personas WHERE sql_text ~ v_scan_dot;
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 回滚 postflight: % 条人群规则仍引用新 schema', v_n;
  END IF;

  -- 7.4 三个函数的 search_path 已恢复
  FOR r IN
    SELECT sp.obj, p.oid
    FROM _unsplit_searchpath sp
    JOIN pg_proc p ON p.proname = sp.obj AND p.pronamespace = 'miniapp'::regnamespace
  LOOP
    IF pg_get_functiondef(r.oid) NOT LIKE $q$%SET search_path TO 'miniapp', 'public'%$q$ THEN
      RAISE EXCEPTION '099 回滚 postflight: miniapp.% 的 search_path 未恢复为 ''miniapp'', ''public''', r.obj;
    END IF;
  END LOOP;

  -- 7.5 依赖计数不得变少
  SELECT count(*) INTO v_n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND c.relnamespace = 'miniapp'::regnamespace;
  SELECT val INTO v_base FROM _unsplit_baseline WHERE metric = 'triggers_on_moved';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 回滚 postflight: 搬回后触发器 % 个，回滚前 % 个', v_n, v_base;
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  WHERE con.contype = 'f' AND c.relnamespace = 'miniapp'::regnamespace;
  SELECT val INTO v_base FROM _unsplit_baseline WHERE metric = 'fks_total_on_moved';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 回滚 postflight: 搬回表上的 FK % 条，回滚前 % 条', v_n, v_base;
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint WHERE contype = 'f';
  SELECT val INTO v_base FROM _unsplit_baseline WHERE metric = 'fks_db_total';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 回滚 postflight: 全库 FK % 条，回滚前 % 条', v_n, v_base;
  END IF;

  -- 跨 schema FK 只可能减少（22 张表重新聚回 miniapp）。增加说明有 FK 指错了地方。
  SELECT count(*) INTO v_n
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_class fc ON fc.oid = con.confrelid
  WHERE con.contype = 'f' AND c.relnamespace <> fc.relnamespace;
  SELECT val INTO v_base FROM _unsplit_baseline WHERE metric = 'cross_schema_fks';
  IF v_n > v_base THEN
    RAISE EXCEPTION '099 回滚 postflight: 跨 schema FK 从 % 条涨到 % 条', v_base, v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  WHERE c.relnamespace = 'miniapp'::regnamespace;
  SELECT val INTO v_base FROM _unsplit_baseline WHERE metric = 'indexes_on_moved';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 回滚 postflight: 搬回表上的索引 % 个，回滚前 % 个', v_n, v_base;
  END IF;

  -- 7.5b 5 条 cs_platform → users 的外部 FK 必须重新指向 miniapp.users
  SELECT count(*) INTO v_n
  FROM pg_constraint con
  JOIN pg_class fc ON fc.oid = con.confrelid
  WHERE con.contype = 'f'
    AND con.conname IN ('audit_logs_user_id_fkey', 'outreach_messages_user_id_fkey',
                        'outreach_sessions_user_id_fkey', 'persona_member_snapshots_user_id_fkey',
                        'persona_member_state_user_id_fkey')
    AND fc.relnamespace = 'miniapp'::regnamespace
    AND fc.relname = 'users';
  IF v_n <> 5 THEN
    RAISE EXCEPTION '099 回滚 postflight: 指向 miniapp.users 的 cs_platform 外部 FK 只有 % 条，应为 5 条', v_n;
  END IF;

  -- 7.6 回滚前能查的视图，回滚后必须仍能查
  FOR r IN SELECT b.nsp, b.rel FROM _unsplit_view_baseline b WHERE b.queryable ORDER BY 1, 2 LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM %I.%I LIMIT 0', r.nsp, r.rel);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '099 回滚 postflight: 视图 %.% 回滚前可查、现在不可查：%', r.nsp, r.rel, SQLERRM;
    END;
  END LOOP;

  -- 7.7 人群规则改回后仍能通过校验
  FOR r IN
    SELECT p.id, p.slug, p.sql_text
    FROM cs_platform.personas p
    JOIN _unsplit_persona_baseline b ON b.id = p.id AND b.valid
    WHERE coalesce(btrim(p.sql_text), '') <> ''
  LOOP
    BEGIN
      PERFORM cs_platform.validate_persona_sql(r.sql_text);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '099 回滚 postflight: 人群规则 %（%）改回后校验失败：%', r.slug, r.id, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '099 回滚 postflight 全部通过：库已回到 099 执行前的形态';
END
$postflight$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ===================================================================
-- 提交后的独立步骤（与 099 对称，同一维护窗口内完成）
-- ===================================================================
--   1. PostgREST 暴露列表回退：
--        test：ops/schema-split/postgrest-expose-test.sql 的「回滚」小节
--        prod：ops/schema-split/postgrest-expose-prod.sql 的「回滚」小节
--      生产尤其注意列表必须保留 miniapp_analytics / cs_platform。
--   2. 生产 pg_cron job 5 回退：ops/schema-split/cron-job5-prod.sql 的「回滚」小节
--      （FROM app_core.characters 改回 FROM miniapp.characters）
--   3. 部署 099 之前的旧代码制品，再恢复入口流量。
--
-- ===================================================================
-- 人工复核（执行后逐条跑，期望值写在后面）
-- ===================================================================
--   -- 四个 schema 已消失
--   SELECT count(*) FROM pg_namespace
--    WHERE nspname IN ('app_core','miniapp_features','experience','billing');   -- 0
--
--   -- miniapp 恢复为 22 表 + 1 视图 + 24 函数（test 若有 charge_voice_usage 则 25）
--   SELECT count(*) FILTER (WHERE relkind = 'r') AS tables,
--          count(*) FILTER (WHERE relkind = 'v') AS views
--     FROM pg_class WHERE relnamespace = 'miniapp'::regnamespace;              -- 22 / 1
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'miniapp'::regnamespace; -- 24 或 25
--
--   -- support_* 已搬离 cs_platform
--   SELECT count(*) FROM pg_class WHERE relnamespace = 'cs_platform'::regnamespace
--     AND relname IN ('support_conversations','support_messages');              -- 0
--
--   -- 全库零残留新 schema 引用
--   SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE p.prosrc ~ '\m(app_core|miniapp_features|experience)\.';            -- 0 行
--   SELECT count(*) FROM cs_platform.personas
--    WHERE sql_text ~ '\m(app_core|miniapp_features|experience|billing)\.';    -- 0
--
--   -- 行数与回滚前一致（搬 schema 不动数据，这里是保险）
--   SELECT 'users', count(*) FROM miniapp.users
--   UNION ALL SELECT 'chat_history', count(*) FROM miniapp.chat_history
--   UNION ALL SELECT 'wallet_ledger', count(*) FROM miniapp.wallet_ledger;
