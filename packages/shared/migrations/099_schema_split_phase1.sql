-- 099: schema 划分一阶段。把 miniapp 的 22 表 + 1 视图 + 24 函数搬到八个归属域，
-- 并改写全库函数体、运营人群 SQL 里的 miniapp.* 限定名。
--
-- 权威归属：docs/schema归属地图.md
-- 执行计划：docs/schema划分-一阶段执行计划.md（本文件对应 §六.6.1）
-- 实测基线：ops/schema-split/snapshots/2026-08-25/批次A-双库基线与差异.md
-- 回滚脚本：099_schema_split_phase1_rollback.sql（提交后失败时用，必须已人工审阅）
--
-- ============================ 前置条件 ============================
-- 1. 097 已在本库执行（chat_history 已无三个死列、tf_set_user_character_round 已删）。
-- 2. 098 已在本库执行（characters 已无 is_default / is_published / is_active）。
-- 3. 已停入口流量与后台任务。SET SCHEMA 不重写数据，但要拿对象的 ACCESS EXCLUSIVE 锁。
-- 上述三条都由 preflight 断言，缺一即整体回滚。
--
-- ============================ 不幂等 ============================
-- 本迁移按单事务一次性执行：事务内任一步失败则全部回滚，库回到执行前形态，修好后可直接重跑。
-- 但**成功提交后不可重跑**（起点已不存在，preflight 会拒绝）。要重来必须先执行回滚脚本。
--
-- ============================ 为什么这样搬 ============================
-- · ALTER TABLE/VIEW/FUNCTION ... SET SCHEMA 只改 pg_class.relnamespace / pg_proc.pronamespace，
--   不重写数据。chat_history 在生产 10 GB / 21.8 万行，搬迁本身是常数时间。
-- · 2026-08-25 双库实测确认这些「按 OID 跟随」的依赖无需手工重建：
--     - 7 条跨 schema FK（5 条 cs_platform.* → users，2 条 notifications/support_messages → admin.admin_users）；
--     - 12 个引用 miniapp.* 的视图（cs_platform.user_metrics、miniapp_traffic.traffic_daily_stats、
--       生产 10 个 miniapp_analytics 视图）——pg_get_viewdef 会自动渲染新位置；
--     - 表和函数上的 ACL、owner、触发器、索引、RLS 开关、注释；
--     - current_chat_history 视图对 chat_history 的依赖。
--   实测同时确认 miniapp 下**没有**序列、自定义类型、物化视图，也没有表进 publication，
--   所以没有「SET SCHEMA 带不走」的遗留对象。
-- · 反过来，下面这三类引用是**文本**，OID 机制完全帮不上忙，必须在同一事务里改：
--     - pg_proc.prosrc 里的 miniapp.* 限定名（miniapp 23 个 + admin 20 个 + 生产 public 1 个）；
--     - 3 个函数的 SET search_path TO 'miniapp', 'public'；
--     - cs_platform.personas.sql_text（运营手工维护的人群规则，生产 14/18 条命中）。
--   函数体改写用 pg_get_functiondef + CREATE OR REPLACE，保留 OID、owner、grants、
--   SECURITY DEFINER、参数与返回类型，因此触发器和下游依赖不会断。
--
-- ============================ 权限口径 ============================
-- 四个新 schema 照 miniapp 现状复制：owner = postgres，只把 USAGE 给 service_role。
-- **不给 anon / authenticated USAGE**——这不是疏漏，是当前的有效行为：
-- miniapp 上 anon/authenticated 虽然握有 9 张表的 DML 表级授权（自动暴露时代的残留），
-- 但因为没有 schema USAGE 而一直调不通。表级授权随表移动，若给了新 schema USAGE，
-- 等于把 chat_history（RLS 未开启）直接开放给匿名读写。postflight 对此有硬断言。
-- 表级残留授权本身不在本迁移范围内清理，另开评审。
--
-- ============================ 事务外的收尾 ============================
-- 以下两项不属于数据库事务，按同一维护窗口的独立步骤执行（见执行计划 §五 批次 C）：
--   · PostgREST 暴露列表：ops/schema-split/postgrest-expose-test.sql / -prod.sql
--   · 生产 pg_cron job 5：ops/schema-split/cron-job5-prod.sql
--       INSERT INTO miniapp_analytics.card_position_snapshot ... FROM miniapp.characters
--       改为 FROM app_core.characters（job 2 / 3 已 inactive 且不含 miniapp. 限定名，不动）

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '600s';

-- ===================================================================
-- 0. 归属映射：本迁移唯一的事实来源，搬迁和文本改写都由它驱动
-- ===================================================================

CREATE TEMP TABLE _split_rel (obj text PRIMARY KEY, target text NOT NULL, kind "char" NOT NULL)
  ON COMMIT DROP;

INSERT INTO _split_rel (obj, target, kind) VALUES
  -- app_core：删掉任何单个功能都必须仍然存在的根数据
  ('users',                              'app_core',         'r'),
  ('miniapp_user_settings',              'app_core',         'r'),
  ('characters',                         'app_core',         'r'),
  ('runtime_config',                     'app_core',         'r'),
  -- miniapp_features：功能下线可以一起删的状态
  ('character_favorites',                'miniapp_features', 'r'),
  ('character_ranking_scores',           'miniapp_features', 'r'),
  ('daily_checkins',                     'miniapp_features', 'r'),
  ('wish_roles',                         'miniapp_features', 'r'),
  ('notifications',                      'miniapp_features', 'r'),
  ('notification_reads',                 'miniapp_features', 'r'),
  -- experience：用户核心互动产生的大体量内容
  ('chat_sessions',                      'experience',       'r'),
  ('chat_history',                       'experience',       'r'),
  ('chat_message_audio',                 'experience',       'r'),
  ('current_chat_history',               'experience',       'v'),
  -- billing：钱、余额、免费权益
  ('payment_orders',                     'billing',          'r'),
  ('wallet_ledger',                      'billing',          'r'),
  ('user_wallets',                       'billing',          'r'),
  ('llm_usage_charges',                  'billing',          'r'),
  ('llm_usage_charge_dedup',             'billing',          'r'),
  ('character_free_chat_quotas',         'billing',          'r'),
  ('character_free_chat_quota_decisions','billing',          'r'),
  -- cs_platform：客服会话迁入既有 schema
  ('support_conversations',              'cs_platform',      'r'),
  ('support_messages',                   'cs_platform',      'r');

CREATE TEMP TABLE _split_fn (
  obj text PRIMARY KEY,
  target text NOT NULL,
  required boolean NOT NULL DEFAULT true
) ON COMMIT DROP;

-- RPC 跟随「主要写入表」所属域（执行计划 §二.1）。必选 24 个无同名重载，
-- 因此用函数名作为映射键；实际 ALTER 时仍按 oid::regprocedure 带全参数类型。
INSERT INTO _split_fn (obj, target) VALUES
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

-- test 在 2026-08-25 盘点之后多出来的语音扣费 RPC，仓库与生产都还没有。
-- 写的是 user_wallets / wallet_ledger，按地图归 billing。有则搬走，没有则跳过。
INSERT INTO _split_fn (obj, target, required) VALUES
  ('charge_voice_usage', 'billing', false);

-- 文本改写用的合并映射：任何 miniapp.<name> 都必须能在这里查到新家。
CREATE TEMP TABLE _split_name (obj text PRIMARY KEY, target text NOT NULL) ON COMMIT DROP;
INSERT INTO _split_name SELECT obj, target FROM _split_rel;
INSERT INTO _split_name SELECT obj, target FROM _split_fn;

-- preflight 记下基线，postflight 逐项比对。
CREATE TEMP TABLE _split_baseline (metric text PRIMARY KEY, val bigint NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE _split_persona_baseline (id uuid PRIMARY KEY, valid boolean NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE _split_view_baseline (nsp text, rel text, queryable boolean NOT NULL,
                                        PRIMARY KEY (nsp, rel)) ON COMMIT DROP;

-- ===================================================================
-- 1. preflight：只读断言。结构漂移一律停在这里
-- ===================================================================

DO $preflight$
DECLARE
  v_txt  text;
  v_n    bigint;
  v_ok   boolean;
  r      RECORD;
BEGIN
  -- 1.1 起点必须还是 miniapp
  IF to_regclass('miniapp.chat_history') IS NULL THEN
    RAISE EXCEPTION '099 preflight: miniapp.chat_history 不存在。099 可能已执行；重跑请先执行回滚脚本';
  END IF;

  -- 1.2 097 已执行
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_txt
  FROM pg_attribute a
  WHERE a.attrelid = 'miniapp.chat_history'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname IN ('preset_id', 'llm_model_markup', 'user_character_round');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: 097 未执行，chat_history 仍有死列 %', v_txt;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'miniapp'::regnamespace
                AND p.proname = 'tf_set_user_character_round') THEN
    RAISE EXCEPTION '099 preflight: 097 未执行，miniapp.tf_set_user_character_round 仍存在';
  END IF;

  -- 1.3 098 已执行
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_txt
  FROM pg_attribute a
  WHERE a.attrelid = 'miniapp.characters'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname IN ('is_default', 'is_published', 'is_active');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: 098 未执行，characters 仍有死列 %', v_txt;
  END IF;

  -- 1.4 miniapp 的表/视图集合必须与映射逐个一致：多一个少一个都停
  SELECT string_agg(x.obj, ', ' ORDER BY x.obj) INTO v_txt
  FROM (
    SELECT m.obj FROM _split_rel m
    WHERE NOT EXISTS (SELECT 1 FROM pg_class c
                       WHERE c.relnamespace = 'miniapp'::regnamespace
                         AND c.relname = m.obj AND c.relkind = m.kind)
  ) x;
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: 映射里有对象不在 miniapp 或类型不符：%', v_txt;
  END IF;

  SELECT string_agg(c.relname || '(' || c.relkind::text || ')', ', ' ORDER BY c.relname) INTO v_txt
  FROM pg_class c
  WHERE c.relnamespace = 'miniapp'::regnamespace
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND NOT EXISTS (SELECT 1 FROM _split_rel m WHERE m.obj = c.relname);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: miniapp 有映射未覆盖的对象：%。先更新归属地图与本迁移', v_txt;
  END IF;

  -- 1.5 miniapp 的函数集合必须覆盖全部必选映射；未登记的多余函数一律停。
  -- 可选函数（目前只有 charge_voice_usage）有则搬走，没有则从本事务映射里删掉。
  SELECT string_agg(m.obj, ', ' ORDER BY m.obj) INTO v_txt
  FROM _split_fn m
  WHERE m.required
    AND NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.pronamespace = 'miniapp'::regnamespace AND p.proname = m.obj);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: 映射里有函数不在 miniapp：%', v_txt;
  END IF;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_txt
  FROM pg_proc p
  WHERE p.pronamespace = 'miniapp'::regnamespace
    AND NOT EXISTS (SELECT 1 FROM _split_fn m WHERE m.obj = p.proname);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: miniapp 有映射未覆盖的函数：%。先更新归属地图与本迁移', v_txt;
  END IF;

  FOR r IN
    SELECT m.obj, m.target,
           EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.pronamespace = 'miniapp'::regnamespace AND p.proname = m.obj) AS present
    FROM _split_fn m
    WHERE NOT m.required
  LOOP
    IF r.present THEN
      RAISE NOTICE '099 preflight: 可选函数 %.% 存在，一并搬走', r.target, r.obj;
    ELSE
      RAISE NOTICE '099 preflight: 可选函数 % 不存在，跳过', r.obj;
    END IF;
  END LOOP;

  DELETE FROM _split_fn m
  WHERE NOT m.required
    AND NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.pronamespace = 'miniapp'::regnamespace AND p.proname = m.obj);

  -- 同名重载会让「按函数名映射」失真
  SELECT count(*) INTO v_n
  FROM (SELECT p.proname FROM pg_proc p
        WHERE p.pronamespace = 'miniapp'::regnamespace
        GROUP BY 1 HAVING count(*) > 1) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 preflight: miniapp 下存在同名重载函数 % 组，映射键不再唯一', v_n;
  END IF;

  -- 1.5b 下面 §5c 会把 SET search_path TO 'miniapp', 'public' 改成函数自己所在的 schema。
  -- 命中集合必须恰好是这三个函数：回滚脚本按同一份硬编码名单反向恢复，
  -- 因为改写之后已经无法从库里区分「被 099 改过」和「本来就指向自己 schema」。
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_txt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f', 'p')
    AND p.proconfig IS NOT NULL
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_%'
    AND n.nspname <> 'aiero'
    AND pg_get_functiondef(p.oid) LIKE $q$%SET search_path TO 'miniapp', 'public'%$q$
    AND p.proname NOT IN ('increment_user_total_round', 'grant_new_user_signup_bonus',
                          'grant_wallet_on_user_insert');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: 这些函数也把 search_path 固定成 miniapp：%。先同步更新 §5c 与回滚脚本的名单', v_txt;
  END IF;

  -- 1.6 miniapp 下不应有 SET SCHEMA 带不走的对象
  SELECT string_agg(t.typname, ', ' ORDER BY t.typname) INTO v_txt
  FROM pg_type t
  WHERE t.typnamespace = 'miniapp'::regnamespace
    AND t.typtype IN ('e', 'd', 'r');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: miniapp 下有自定义类型 %，需先决定归属', v_txt;
  END IF;

  -- 1.7 四个新 schema 必须完全不存在。
  -- 本迁移单事务，失败不会留下半成品 schema，所以正常情况下它们必然不存在；
  -- 而回滚脚本会把这四个 schema DROP 掉，因此必须确定它们是 099 自己建的。
  -- 若已存在（哪怕是空的），说明有人另有用途，停下来由人决定。
  SELECT string_agg(n.nspname, ', ' ORDER BY n.nspname) INTO v_txt
  FROM pg_namespace n
  WHERE n.nspname IN ('app_core', 'miniapp_features', 'experience', 'billing');
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: 目标 schema % 已存在。099 可能已执行，或该名字另有用途；不要在已存在的 schema 上继续', v_txt;
  END IF;

  -- 1.8 引用 miniapp.* 的函数只允许出现在这三个 schema。多出来的说明盘点漏了消费方
  SELECT string_agg(DISTINCT n.nspname, ', ') INTO v_txt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'miniapp', 'admin', 'public')
    AND n.nspname NOT LIKE 'pg\_%'
    AND n.nspname <> 'aiero'      -- test 独有的无关 schema，永久排除
    AND p.prosrc ~ 'miniapp\.';
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 preflight: 未预期的 schema 存在引用 miniapp.* 的函数：%', v_txt;
  END IF;

  -- 1.9 记录基线，供 postflight 比对
  INSERT INTO _split_baseline (metric, val)
  SELECT 'triggers_on_moved', count(*)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  WHERE NOT t.tgisinternal AND c.relnamespace = 'miniapp'::regnamespace;

  -- 全库 FK 总数：SET SCHEMA 不增删约束，迁移后必须一模一样
  INSERT INTO _split_baseline (metric, val)
  SELECT 'fks_db_total', count(*) FROM pg_constraint WHERE contype = 'f';

  INSERT INTO _split_baseline (metric, val)
  SELECT 'cross_schema_fks', count(*)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_class fc ON fc.oid = con.confrelid
  WHERE con.contype = 'f' AND c.relnamespace <> fc.relnamespace;

  INSERT INTO _split_baseline (metric, val)
  SELECT 'fks_total_on_moved', count(*)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  WHERE con.contype = 'f' AND c.relnamespace = 'miniapp'::regnamespace;

  INSERT INTO _split_baseline (metric, val)
  SELECT 'indexes_on_moved', count(*)
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  WHERE c.relnamespace = 'miniapp'::regnamespace;

  -- 1.10 人群 SQL 基线：先记下哪些本来就能通过校验，postflight 只追究「改写后变坏」的
  FOR r IN SELECT p.id, p.sql_text FROM cs_platform.personas p LOOP
    IF coalesce(btrim(r.sql_text), '') = '' THEN
      v_ok := true;   -- 空规则不参与校验，视为无需追究
    ELSE
      BEGIN
        PERFORM cs_platform.validate_persona_sql(r.sql_text);
        v_ok := true;
      EXCEPTION WHEN OTHERS THEN
        v_ok := false;
      END;
    END IF;
    INSERT INTO _split_persona_baseline (id, valid) VALUES (r.id, v_ok);
  END LOOP;

  SELECT count(*) INTO v_n FROM _split_persona_baseline WHERE NOT valid;
  IF v_n > 0 THEN
    RAISE NOTICE '099 preflight: % 条人群规则在迁移前就无法通过校验，postflight 不追究这些', v_n;
  END IF;

  -- 1.11 视图可查性基线：同理，只追究「迁移前能查、迁移后查不了」的
  FOR r IN
    SELECT n.nspname AS nsp, c.relname AS rel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v'
      AND n.nspname IN ('miniapp', 'admin', 'cs_platform', 'miniapp_traffic',
                        'miniapp_analytics', 'public')
  LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM %I.%I LIMIT 0', r.nsp, r.rel);
      v_ok := true;
    EXCEPTION WHEN OTHERS THEN
      v_ok := false;
    END;
    -- miniapp.current_chat_history 迁移后会落到 experience，按新位置登记
    INSERT INTO _split_view_baseline (nsp, rel, queryable)
    VALUES (coalesce((SELECT m.target FROM _split_rel m
                       WHERE m.obj = r.rel AND m.kind = 'v' AND r.nsp = 'miniapp'), r.nsp),
            r.rel, v_ok);
  END LOOP;

  SELECT count(*) INTO v_n FROM _split_view_baseline WHERE NOT queryable;
  IF v_n > 0 THEN
    RAISE NOTICE '099 preflight: % 个视图在迁移前就查不了，postflight 不追究这些', v_n;
  END IF;

  RAISE NOTICE '099 preflight 通过：待搬 % 表/视图、% 函数',
    (SELECT count(*) FROM _split_rel), (SELECT count(*) FROM _split_fn);
END
$preflight$;

-- ===================================================================
-- 2. 新建四个 schema，权限照 miniapp 复制
-- ===================================================================

-- 不用 IF NOT EXISTS：preflight §1.7 已断言四者都不存在，
-- 且回滚脚本会 DROP 它们，所以必须确定是本迁移创建的。
CREATE SCHEMA app_core         AUTHORIZATION postgres;
CREATE SCHEMA miniapp_features AUTHORIZATION postgres;
CREATE SCHEMA experience       AUTHORIZATION postgres;
CREATE SCHEMA billing          AUTHORIZATION postgres;

GRANT USAGE ON SCHEMA app_core, miniapp_features, experience, billing TO service_role;

COMMENT ON SCHEMA app_core IS
  'app_core 域：跨模块共享的根数据（users / miniapp_user_settings / characters / runtime_config）。删除任何单个功能它必须仍然存在。';
COMMENT ON SCHEMA miniapp_features IS
  'miniapp_features 域：具体产品功能产生的状态（收藏、签到、许愿、通知、大厅排序得分）。功能下线可随之删除。';
COMMENT ON SCHEMA experience IS
  'experience 域：用户核心互动产生的大体量内容（会话、逐轮生成日志、语音产物）。';
COMMENT ON SCHEMA billing IS
  'billing 域：钱、余额与免费权益（支付事实、星尘账本、余额投影、LLM 计费、免费额度）。';

-- ===================================================================
-- 3. 搬表与视图
-- ===================================================================

DO $move_rel$
DECLARE r RECORD;
BEGIN
  -- 先表后视图（"char" 序 r < v），确保视图依赖的基表已在新位置
  FOR r IN SELECT obj, target, kind FROM _split_rel ORDER BY kind, obj LOOP
    IF r.kind = 'v' THEN
      EXECUTE format('ALTER VIEW miniapp.%I SET SCHEMA %I', r.obj, r.target);
    ELSE
      EXECUTE format('ALTER TABLE miniapp.%I SET SCHEMA %I', r.obj, r.target);
    END IF;
  END LOOP;
END
$move_rel$;

-- ===================================================================
-- 4. 搬函数（保留 OID / owner / grants / SECURITY DEFINER / 触发器依赖）
-- ===================================================================

DO $move_fn$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, m.target
    FROM _split_fn m
    JOIN pg_proc p ON p.proname = m.obj AND p.pronamespace = 'miniapp'::regnamespace
    ORDER BY m.obj
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET SCHEMA %I', r.sig, r.target);
  END LOOP;
END
$move_fn$;

-- ===================================================================
-- 5. 改写函数体：miniapp.<obj> 限定名、SET search_path、审计用的 schema 名字面量
-- ===================================================================

DO $rewrite_fn$
DECLARE
  r      RECORD;
  m      RECORD;
  v_def  text;
  v_pat  text;
  v_rep  text;
  v_cnt  int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, n.nspname AS nsp, p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_%'
      AND n.nspname <> 'aiero'
      AND p.prosrc ~ 'miniapp\.'
    ORDER BY 2, 3
  LOOP
    v_def := pg_get_functiondef(r.oid);

    FOR m IN SELECT obj, target FROM _split_name ORDER BY length(obj) DESC, obj LOOP
      -- 5a. 限定名。\m / \M 是词边界，避免 miniapp.users 误伤 miniapp.user_wallets，
      --     也避免 miniapp_analytics.* 被当成 miniapp.*
      v_pat := $q$\mminiapp\.$q$ || m.obj || $q$\M$q$;
      v_def := regexp_replace(v_def, v_pat, m.target || '.' || m.obj, 'g');

      -- 5b. admin 的 13 个 RPC 把 schema 名当值写进 admin.audit_logs.schema_name，
      --     形如 'miniapp', 'characters'。表已搬走，继续记 'miniapp' 就是记了个不存在的位置。
      --     全仓库无任何代码按 schema_name 过滤（只写不读），改它不影响任何调用方。
      --     历史行不动（那是当时的真实位置）。
      v_pat := $q$'miniapp'(\s*,\s*)'$q$ || m.obj || $q$'$q$;
      v_rep := $q$'$q$ || m.target || $q$'\1'$q$ || m.obj || $q$'$q$;
      v_def := regexp_replace(v_def, v_pat, v_rep, 'g');
    END LOOP;

    -- 5c. 3 个函数把 search_path 固定成 'miniapp', 'public'。函数体已全限定，
    --     search_path 只是兜底，但留着一个即将不存在的 schema 名没有意义。
    v_def := replace(v_def,
                     $q$SET search_path TO 'miniapp', 'public'$q$,
                     $q$SET search_path TO '$q$ || r.nsp || $q$', 'public'$q$);

    IF v_def ~ 'miniapp\.' OR v_def ~ $q$'miniapp'$q$ THEN
      RAISE EXCEPTION '099: 函数 % 改写后仍残留 miniapp 引用，映射不完整', r.sig;
    END IF;

    EXECUTE v_def;
    v_cnt := v_cnt + 1;
  END LOOP;

  RAISE NOTICE '099: 改写 % 个函数体', v_cnt;
END
$rewrite_fn$;

-- ===================================================================
-- 6. 改写运营人群 SQL（cs_platform.personas.sql_text）
-- ===================================================================
-- 这是运营在 CS 平台手工维护的只读 SELECT，由 cs_platform.refresh_persona_members
-- 动态 EXECUTE。它存在数据里，搬 schema 不会跟随，不改就是刷新人群时报「关系不存在」。
-- cs_platform.persona_refresh_runs.sql_text 是历史执行日志，不改（改了等于篡改审计）。

DO $rewrite_persona$
DECLARE
  m     RECORD;
  v_pat text;
  v_n   bigint := 0;
  v_i   bigint;
BEGIN
  FOR m IN SELECT obj, target FROM _split_name ORDER BY length(obj) DESC, obj LOOP
    v_pat := $q$\mminiapp\.$q$ || m.obj || $q$\M$q$;
    UPDATE cs_platform.personas
       SET sql_text = regexp_replace(sql_text, v_pat, m.target || '.' || m.obj, 'g')
     WHERE sql_text ~ v_pat;
    GET DIAGNOSTICS v_i = ROW_COUNT;
    v_n := v_n + v_i;
  END LOOP;

  RAISE NOTICE '099: 改写人群规则 % 处（同一条规则引用多张表会计多次）', v_n;
END
$rewrite_persona$;

-- ===================================================================
-- 7. postflight：搬完必须逐项验，验不过整体回滚
-- ===================================================================

DO $postflight$
DECLARE
  r      RECORD;
  v_txt  text;
  v_n    bigint;
  v_base bigint;
BEGIN
  -- 7.1 miniapp 必须清空（schema 本身留到批次 D 观察期后再删）
  SELECT count(*) INTO v_n FROM pg_class c
  WHERE c.relnamespace = 'miniapp'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S');
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 postflight: miniapp 仍有 % 个表/视图未搬走', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p WHERE p.pronamespace = 'miniapp'::regnamespace;
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 postflight: miniapp 仍有 % 个函数未搬走', v_n;
  END IF;

  -- 7.2 每个对象都在映射指定的位置，且类型未变
  SELECT string_agg(m.target || '.' || m.obj, ', ' ORDER BY m.obj) INTO v_txt
  FROM _split_rel m
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c
                     WHERE c.relnamespace = m.target::regnamespace
                       AND c.relname = m.obj AND c.relkind = m.kind);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 postflight: 这些对象不在预期位置：%', v_txt;
  END IF;

  SELECT string_agg(m.target || '.' || m.obj, ', ' ORDER BY m.obj) INTO v_txt
  FROM _split_fn m
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.pronamespace = m.target::regnamespace AND p.proname = m.obj);
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 postflight: 这些函数不在预期位置：%', v_txt;
  END IF;

  -- 7.3 全库不允许残留运行时 miniapp.* 文本引用
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_txt
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_%'
    AND n.nspname <> 'aiero'
    AND p.prosrc ~ 'miniapp\.';
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 postflight: 函数体仍引用 miniapp.*：%', v_txt;
  END IF;

  SELECT string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY n.nspname, c.relname) INTO v_txt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('v', 'm')
    AND n.nspname NOT LIKE 'pg\_%'
    AND n.nspname NOT IN ('information_schema', 'aiero')
    AND pg_get_viewdef(c.oid) ~ 'miniapp\.';
  IF v_txt IS NOT NULL THEN
    RAISE EXCEPTION '099 postflight: 视图定义仍引用 miniapp.*：%', v_txt;
  END IF;

  SELECT count(*) INTO v_n FROM cs_platform.personas WHERE sql_text ~ 'miniapp\.';
  IF v_n > 0 THEN
    RAISE EXCEPTION '099 postflight: % 条人群规则仍引用 miniapp.*', v_n;
  END IF;

  -- 7.4 依赖计数不得变少：触发器、FK、索引都应随对象跟到新 schema
  SELECT count(*) INTO v_n
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN _split_rel m ON m.obj = c.relname AND c.relnamespace = m.target::regnamespace
  WHERE NOT t.tgisinternal;
  SELECT val INTO v_base FROM _split_baseline WHERE metric = 'triggers_on_moved';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 postflight: 搬迁后触发器 % 个，迁移前 % 个', v_n, v_base;
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN _split_rel m ON m.obj = c.relname AND c.relnamespace = m.target::regnamespace
  WHERE con.contype = 'f';
  SELECT val INTO v_base FROM _split_baseline WHERE metric = 'fks_total_on_moved';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 postflight: 搬迁表上的 FK % 条，迁移前 % 条', v_n, v_base;
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint WHERE contype = 'f';
  SELECT val INTO v_base FROM _split_baseline WHERE metric = 'fks_db_total';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 postflight: 全库 FK % 条，迁移前 % 条', v_n, v_base;
  END IF;

  -- 跨 schema FK 只可能增加（22 张表散到四个新域）。减少说明有 FK 掉了
  SELECT count(*) INTO v_n
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_class fc ON fc.oid = con.confrelid
  WHERE con.contype = 'f' AND c.relnamespace <> fc.relnamespace;
  SELECT val INTO v_base FROM _split_baseline WHERE metric = 'cross_schema_fks';
  IF v_n < v_base THEN
    RAISE EXCEPTION '099 postflight: 跨 schema FK 从 % 条降到 % 条', v_base, v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN _split_rel m ON m.obj = c.relname AND c.relnamespace = m.target::regnamespace;
  SELECT val INTO v_base FROM _split_baseline WHERE metric = 'indexes_on_moved';
  IF v_n <> v_base THEN
    RAISE EXCEPTION '099 postflight: 搬迁表上的索引 % 个，迁移前 % 个', v_n, v_base;
  END IF;

  -- 7.4b 5 条 cs_platform → users 的外部 FK 必须已指向 app_core.users。
  -- 这是「OID 跟随」这一整套假设最直接的证据，单独验。
  SELECT count(*) INTO v_n
  FROM pg_constraint con
  JOIN pg_class fc ON fc.oid = con.confrelid
  WHERE con.contype = 'f'
    AND con.conname IN ('audit_logs_user_id_fkey', 'outreach_messages_user_id_fkey',
                        'outreach_sessions_user_id_fkey', 'persona_member_snapshots_user_id_fkey',
                        'persona_member_state_user_id_fkey')
    AND fc.relnamespace = 'app_core'::regnamespace
    AND fc.relname = 'users';
  IF v_n <> 5 THEN
    RAISE EXCEPTION '099 postflight: 指向 app_core.users 的 cs_platform 外部 FK 只有 % 条，应为 5 条', v_n;
  END IF;

  -- 7.5 anon / authenticated 不得拿到新 schema 的 USAGE。
  -- 它们在 9 张表上还留着自动暴露时代的 DML 表级授权（随表移动），
  -- 一旦补上 schema USAGE，chat_history（RLS 未开启）就直接对匿名可读写。
  FOR r IN SELECT unnest(ARRAY['app_core', 'miniapp_features', 'experience', 'billing']) AS nsp LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND has_schema_privilege('anon', r.nsp, 'USAGE') THEN
      RAISE EXCEPTION '099 postflight: anon 拿到了 schema % 的 USAGE，与 miniapp 现状不符', r.nsp;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       AND has_schema_privilege('authenticated', r.nsp, 'USAGE') THEN
      RAISE EXCEPTION '099 postflight: authenticated 拿到了 schema % 的 USAGE，与 miniapp 现状不符', r.nsp;
    END IF;
    IF NOT has_schema_privilege('service_role', r.nsp, 'USAGE') THEN
      RAISE EXCEPTION '099 postflight: service_role 缺少 schema % 的 USAGE', r.nsp;
    END IF;
  END LOOP;

  -- 7.6 迁移前能查的视图，迁移后必须仍能查（含 analytics / traffic / cs_platform 跨域视图）
  FOR r IN SELECT b.nsp, b.rel FROM _split_view_baseline b WHERE b.queryable ORDER BY 1, 2 LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM %I.%I LIMIT 0', r.nsp, r.rel);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '099 postflight: 视图 %.% 迁移前可查、现在不可查：%', r.nsp, r.rel, SQLERRM;
    END;
  END LOOP;

  -- 7.7 人群规则改写后仍能通过校验（validate_persona_sql 会 EXPLAIN，等于验了新表名解析）
  FOR r IN
    SELECT p.id, p.slug, p.sql_text
    FROM cs_platform.personas p
    JOIN _split_persona_baseline b ON b.id = p.id AND b.valid
    WHERE coalesce(btrim(p.sql_text), '') <> ''
  LOOP
    BEGIN
      PERFORM cs_platform.validate_persona_sql(r.sql_text);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION '099 postflight: 人群规则 %（%）改写后校验失败：%', r.slug, r.id, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE '099 postflight 全部通过';
END
$postflight$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ===================================================================
-- 提交后的独立步骤（同一维护窗口内完成，不属于本事务）
-- ===================================================================
--   1. PostgREST 暴露列表：ops/schema-split/postgrest-expose-{test,prod}.sql
--      两库现状不同（test 有 GUC，生产靠平台配置），必须分库执行。
--   2. 生产 pg_cron job 5：ops/schema-split/cron-job5-prod.sql
--   3. 部署适配新 schema 的代码。
--
-- ===================================================================
-- 人工复核（执行后逐条跑，期望值写在后面）
-- ===================================================================
--   -- miniapp 应为空壳
--   SELECT count(*) FROM pg_class WHERE relnamespace = 'miniapp'::regnamespace
--     AND relkind IN ('r','v','m','S');                                    -- 0
--   SELECT count(*) FROM pg_proc WHERE pronamespace = 'miniapp'::regnamespace;  -- 0
--
--   -- 新四域对象数
--   SELECT n.nspname, count(*) FILTER (WHERE c.relkind = 'r') AS tables,
--          count(*) FILTER (WHERE c.relkind = 'v') AS views
--     FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid
--    WHERE n.nspname IN ('app_core','miniapp_features','experience','billing')
--    GROUP BY 1 ORDER BY 1;
--   -- app_core 4/0  billing 7/0  experience 3/1  miniapp_features 6/0
--
--   SELECT n.nspname, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname IN ('app_core','miniapp_features','experience','billing')
--    GROUP BY 1 ORDER BY 1;
--   -- app_core 2  billing 11  experience 5  miniapp_features 6
--
--   -- cs_platform 收到两张客服表
--   SELECT relname FROM pg_class WHERE relnamespace = 'cs_platform'::regnamespace
--     AND relname IN ('support_conversations','support_messages');          -- 2 行
--
--   -- 全库零残留
--   SELECT n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
--      AND p.prosrc ~ 'miniapp\.';                                         -- 0 行
--   SELECT count(*) FROM cs_platform.personas WHERE sql_text ~ 'miniapp\.'; -- 0
--
--   -- 行数与迁移前一致（搬 schema 不动数据，这里是保险）
--   SELECT 'users', count(*) FROM app_core.users
--   UNION ALL SELECT 'chat_history', count(*) FROM experience.chat_history
--   UNION ALL SELECT 'wallet_ledger', count(*) FROM billing.wallet_ledger;
--
--   -- 真实角色可达性（PostgREST 重载后）
--   SET ROLE service_role;
--     SELECT count(*) FROM app_core.characters;
--     SELECT count(*) FROM experience.current_chat_history;
--   RESET ROLE;
