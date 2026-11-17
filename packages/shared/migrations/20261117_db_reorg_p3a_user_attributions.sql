-- Domain: miniapp_traffic（归因）+ experience（聊天统计）+ app_core（用户身份）。
-- 数据库重组阶段 3a（扩展步），规则见 docs/db/CONTRACT.md §1/§3，计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md。
--
-- 终态：app_core.users 只留身份（id、tg_id、时间戳）。
--   miniapp_traffic.user_attributions  ← users.source_id / bot_entered_at / miniapp_entered_at / st_initialized_at
--   experience.user_chat_stats         ← users.total_round（与 miniapp_user_settings.total_round 重复，以 users 为准）
-- 本文件（扩展）：
--   1. 建两张新表并从 users 回填；
--   2. 新函数：app_core.ensure_user（只建身份）、miniapp_traffic.enter_user（建用户+写归因，一次往返，无变化不写）、
--      experience.increment_user_total_round / experience.user_total_round；
--   3. record_app_entry、check_invite_chat_rounds_reward、cs_feed.user_profiles、traffic_daily_stats 改读新表；
--   4. 删除 8 个无人使用的分析视图（同期群/LTV/生态/漏斗，10-23 起 0~1 次查询，只授给已弃用的画像簇账号）；
--   5. 发布窗口兼容：旧后端仍写 users 的归因列 → 触发器同步到新表（只补空值）；
--      旧后端仍调 app_core.increment_user_total_round → 改为写新表并顺带维护旧列。
-- 收缩步（后端发布后）：20261117_db_reorg_p3a_user_attributions_contract.sql 删触发器、旧函数、旧列。
--
-- Verify: bash scripts/test-db-reorg-p3a-migration.sh
-- Release: TEST -> Production -> 后端发布 -> 收缩步。
-- Recovery: 扩展步不删任何旧列；回退后端即可。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. 新表 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS miniapp_traffic.user_attributions (
  user_id uuid PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  source_id text,
  bot_entered_at timestamptz,
  miniapp_entered_at timestamptz,
  st_initialized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_attributions_source_idx
  ON miniapp_traffic.user_attributions (source_id) WHERE source_id IS NOT NULL;
COMMENT ON TABLE miniapp_traffic.user_attributions IS
  '用户渠道归因与入口时间（每用户一行）。写入方 miniapp_traffic.enter_user / record_app_entry、邀请绑定。';
COMMENT ON COLUMN miniapp_traffic.user_attributions.st_initialized_at IS
  '历史使用标记（旧 ST 初始化时间），只读，作幕间资格依据。';

CREATE TABLE IF NOT EXISTS experience.user_chat_stats (
  user_id uuid PRIMARY KEY REFERENCES app_core.users(id) ON DELETE CASCADE,
  total_round bigint NOT NULL DEFAULT 0 CHECK (total_round >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE experience.user_chat_stats IS
  '用户累计成功对话轮数（派生计数，每用户一行，无行=0）。写入方 experience.increment_user_total_round。';

ALTER TABLE miniapp_traffic.user_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.user_chat_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_traffic.user_attributions, experience.user_chat_stats FROM PUBLIC;
DO $acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON miniapp_traffic.user_attributions, experience.user_chat_stats FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON miniapp_traffic.user_attributions TO service_role;
    GRANT SELECT ON experience.user_chat_stats TO service_role;
  END IF;
END
$acl$;

-- 2. 回填（可重跑：只补空值、轮数取大）---------------------------------------
INSERT INTO miniapp_traffic.user_attributions AS ua
  (user_id, source_id, bot_entered_at, miniapp_entered_at, st_initialized_at, created_at, updated_at)
SELECT u.id, u.source_id, u.bot_entered_at, u.miniapp_entered_at,
  (to_jsonb(u) ->> 'st_initialized_at')::timestamptz, u.created_at, u.updated_at
FROM app_core.users u
ON CONFLICT (user_id) DO UPDATE SET
  source_id = COALESCE(ua.source_id, EXCLUDED.source_id),
  bot_entered_at = COALESCE(ua.bot_entered_at, EXCLUDED.bot_entered_at),
  miniapp_entered_at = COALESCE(ua.miniapp_entered_at, EXCLUDED.miniapp_entered_at),
  st_initialized_at = COALESCE(ua.st_initialized_at, EXCLUDED.st_initialized_at);

INSERT INTO experience.user_chat_stats AS st (user_id, total_round, updated_at)
SELECT u.id, u.total_round, u.updated_at FROM app_core.users u WHERE u.total_round > 0
ON CONFLICT (user_id) DO UPDATE SET total_round = GREATEST(st.total_round, EXCLUDED.total_round);

-- 3. 函数 ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION experience.user_total_round(p_user_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE((SELECT s.total_round FROM experience.user_chat_stats s WHERE s.user_id = p_user_id), 0::bigint)
$$;

CREATE OR REPLACE FUNCTION experience.increment_user_total_round(p_user_id uuid, p_delta integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_delta IS NULL OR p_delta <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO experience.user_chat_stats AS s (user_id, total_round, updated_at)
  VALUES (p_user_id, p_delta, clock_timestamp())
  ON CONFLICT (user_id) DO UPDATE SET total_round = s.total_round + EXCLUDED.total_round, updated_at = EXCLUDED.updated_at;
END;
$$;

-- 发布窗口兼容：旧后端仍调这个名字。权威计数写新表，旧列顺带维护，供旧后端读取。收缩步删除。
CREATE OR REPLACE FUNCTION app_core.increment_user_total_round(p_user_id uuid, p_delta integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_delta IS NULL OR p_delta <= 0 THEN
    RETURN;
  END IF;
  PERFORM experience.increment_user_total_round(p_user_id, p_delta);
  UPDATE app_core.users SET total_round = total_round + p_delta, updated_at = now() WHERE id = p_user_id;
  UPDATE app_core.miniapp_user_settings SET total_round = total_round + p_delta, updated_at = now() WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_core.ensure_user(p_tg_id text)
RETURNS TABLE(user_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_tg_id IS NULL OR p_tg_id !~ '^[0-9]{1,32}$' THEN
    RAISE EXCEPTION 'invalid tg_id' USING ERRCODE = '22023';
  END IF;
  -- 常规登录只读；只有查不到才尝试插入（新用户钱包奖励触发器是 AFTER INSERT，只对真正插入的行生效）。
  SELECT u.id INTO v_id FROM app_core.users u WHERE u.tg_id = p_tg_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;
  INSERT INTO app_core.users (tg_id) VALUES (p_tg_id) ON CONFLICT (tg_id) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, true;
    RETURN;
  END IF;
  SELECT u.id INTO STRICT v_id FROM app_core.users u WHERE u.tg_id = p_tg_id;
  RETURN QUERY SELECT v_id, false;
END;
$$;

-- 建用户 + 写归因：首次建号记来源；首次进入 MiniApp / 首次 bot /start 只补空值；bot 首启时来源为空才补。
-- 没有需要补的值时只读不写。返回值形状与旧的 app_core.users 行一致（含 total_round），后端不必改结构。
CREATE OR REPLACE FUNCTION miniapp_traffic.enter_user(p_tg_id text, p_source_id text DEFAULT NULL, p_entry text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_user_id uuid;
  v_created boolean;
  v_source text := NULLIF(btrim(COALESCE(p_source_id, '')), '');
  v_now timestamptz := clock_timestamp();
  u record;
  a record;
BEGIN
  IF p_entry IS NOT NULL AND p_entry NOT IN ('miniapp', 'bot') THEN
    RAISE EXCEPTION 'invalid entry %', p_entry USING ERRCODE = '22023';
  END IF;
  SELECT e.user_id, e.created INTO v_user_id, v_created FROM app_core.ensure_user(p_tg_id) e;

  SELECT * INTO a FROM miniapp_traffic.user_attributions WHERE user_id = v_user_id;
  IF NOT FOUND THEN
    INSERT INTO miniapp_traffic.user_attributions (user_id, source_id)
    VALUES (v_user_id, CASE WHEN v_created THEN v_source END)
    ON CONFLICT (user_id) DO NOTHING;
    SELECT * INTO STRICT a FROM miniapp_traffic.user_attributions WHERE user_id = v_user_id;
  END IF;
  -- 发布窗口内 users 的同步触发器可能已先建出空归因行；新建号仍要记下来源。
  IF v_created AND a.source_id IS NULL AND v_source IS NOT NULL THEN
    UPDATE miniapp_traffic.user_attributions ua SET source_id = v_source, updated_at = v_now
    WHERE ua.user_id = v_user_id AND ua.source_id IS NULL
    RETURNING ua.* INTO a;
  END IF;

  IF (p_entry = 'miniapp' AND a.miniapp_entered_at IS NULL) OR (p_entry = 'bot' AND a.bot_entered_at IS NULL) THEN
    UPDATE miniapp_traffic.user_attributions ua SET
      miniapp_entered_at = CASE WHEN p_entry = 'miniapp' THEN COALESCE(ua.miniapp_entered_at, v_now) ELSE ua.miniapp_entered_at END,
      bot_entered_at = CASE WHEN p_entry = 'bot' THEN COALESCE(ua.bot_entered_at, v_now) ELSE ua.bot_entered_at END,
      source_id = CASE WHEN p_entry = 'bot' AND ua.bot_entered_at IS NULL THEN COALESCE(ua.source_id, v_source) ELSE ua.source_id END,
      updated_at = v_now
    WHERE ua.user_id = v_user_id
    RETURNING ua.* INTO a;
  END IF;

  SELECT * INTO STRICT u FROM app_core.users WHERE id = v_user_id;
  RETURN jsonb_build_object(
    'id', u.id, 'tg_id', u.tg_id, 'created_at', u.created_at, 'updated_at', u.updated_at,
    'source_id', a.source_id, 'bot_entered_at', a.bot_entered_at, 'miniapp_entered_at', a.miniapp_entered_at,
    'total_round', experience.user_total_round(u.id));
END;
$$;

REVOKE ALL ON FUNCTION experience.user_total_round(uuid), experience.increment_user_total_round(uuid, integer),
  app_core.ensure_user(text), miniapp_traffic.enter_user(text, text, text) FROM PUBLIC;
DO $fn_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION experience.user_total_round(uuid), experience.increment_user_total_round(uuid, integer),
      app_core.ensure_user(text), miniapp_traffic.enter_user(text, text, text) FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION experience.user_total_round(uuid), experience.increment_user_total_round(uuid, integer),
      app_core.ensure_user(text), miniapp_traffic.enter_user(text, text, text) TO service_role;
  END IF;
END
$fn_acl$;

-- 邀请满轮奖励：轮数改读 experience。其余逻辑原样。
CREATE OR REPLACE FUNCTION miniapp_traffic.check_invite_chat_rounds_reward(p_invitee_user_id uuid)
 RETURNS TABLE(status text, credits integer, total_round bigint, threshold_rounds integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_relation miniapp_traffic.invite_relations%ROWTYPE;
  v_cfg JSONB;
  v_rule JSONB;
  v_total_round BIGINT;
  v_threshold INTEGER;
  v_already_granted BOOLEAN;
  v_grant RECORD;
BEGIN
  SELECT r.* INTO v_relation
  FROM miniapp_traffic.invite_relations AS r
  WHERE r.invitee_user_id = p_invitee_user_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_relation'::TEXT, 0, 0::BIGINT, NULL::INTEGER;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_core.users AS u WHERE u.id = p_invitee_user_id) THEN
    RAISE EXCEPTION 'check_invite_chat_rounds_reward: 被邀请用户 % 不存在', p_invitee_user_id
      USING ERRCODE = '22023';
  END IF;
  v_total_round := experience.user_total_round(p_invitee_user_id);

  SELECT EXISTS (
    SELECT 1
    FROM miniapp_traffic.invite_reward_logs AS l
    WHERE l.relation_id = v_relation.id
      -- 108 上线前已经按注册规则发过 200 的历史关系，不能在达标后再补发一次。
      AND l.rule_key IN ('invitee_registered', 'invitee_chat_rounds')
      AND l.event_ref = p_invitee_user_id::text
  ) INTO v_already_granted;

  IF v_already_granted THEN
    RETURN QUERY SELECT 'duplicated'::TEXT, 0, v_total_round, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT rc.value INTO v_cfg
  FROM app_core.runtime_config AS rc
  WHERE rc.key = 'miniapp_invite_reward_rules';

  SELECT r.rule INTO v_rule
  FROM jsonb_array_elements(COALESCE(v_cfg -> 'rules', '[]'::jsonb)) AS r(rule)
  WHERE r.rule ->> 'rule_key' = 'invitee_chat_rounds';

  IF v_rule IS NULL
     OR COALESCE((v_rule ->> 'enabled')::boolean, FALSE) IS NOT TRUE
     OR COALESCE((v_rule ->> 'credits')::integer, 0) <= 0 THEN
    RETURN QUERY SELECT 'skipped'::TEXT, 0, v_total_round, NULL::INTEGER;
    RETURN;
  END IF;

  v_threshold := COALESCE((v_rule ->> 'threshold_rounds')::integer, 3);

  IF v_total_round < v_threshold THEN
    RETURN QUERY SELECT 'below_threshold'::TEXT, 0, v_total_round, v_threshold;
    RETURN;
  END IF;

  SELECT * INTO v_grant
  FROM miniapp_traffic.grant_invite_reward(
    v_relation.id,
    'invitee_chat_rounds',
    p_invitee_user_id::text
  );

  RETURN QUERY SELECT v_grant.status::TEXT, v_grant.credits::INTEGER, v_total_round, v_threshold;
END;
$function$;

-- 幕间入口：建号走 ensure_user，入口时间/来源/历史标记读写归因表，轮数读 experience。判定逻辑原样。
CREATE OR REPLACE FUNCTION miniapp_traffic.record_app_entry(p_tg_id text, p_surface text, p_source text, p_launch timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_user_id uuid;
  a miniapp_traffic.user_attributions%ROWTYPE;
  prior miniapp_traffic.app_entry_facts%ROWTYPE;
  v_new boolean;
  v_eligibility text;
  v_reason text;
  v_history timestamptz;
  v_entered timestamptz;
  v_bot timestamptz;
  v_initialized timestamptz;
  v_rounds bigint;
  v_reordered boolean := false;
  v_prior_entry boolean := false;
  v_basis jsonb;
  v_source text := COALESCE(p_source, '');
  v_changed integer;
  v_converted boolean;
BEGIN
  IF p_tg_id !~ '^[1-9][0-9]*$' OR p_surface NOT IN ('mujian','mijing') OR p_launch IS NULL
    OR p_launch > clock_timestamp() + interval '30 seconds'
    OR p_launch < clock_timestamp() - interval '24 hours'
    OR (v_source <> '' AND v_source !~ '^[A-Za-z0-9_-]{3,64}$') THEN
    RAISE EXCEPTION 'invalid verified entry';
  END IF;
  -- Serialize both apps, including first-account creation. Existing user writers also respect the row lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('app-entry:' || p_tg_id, 0));
  SELECT e.user_id, e.created INTO v_user_id, v_new FROM app_core.ensure_user(p_tg_id) e;
  PERFORM 1 FROM app_core.users WHERE id = v_user_id FOR UPDATE;
  INSERT INTO miniapp_traffic.user_attributions (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO STRICT a FROM miniapp_traffic.user_attributions WHERE user_id = v_user_id FOR UPDATE;

  SELECT * INTO prior FROM miniapp_traffic.app_entry_facts
    WHERE user_id = v_user_id AND surface = 'mujian' ORDER BY received_at LIMIT 1;
  IF FOUND THEN
    v_eligibility := prior.eligibility;
    v_basis := prior.eligibility_basis;
  ELSE
    SELECT min(created_at) INTO v_history FROM experience.chat_history WHERE user_id = v_user_id;
    v_entered := a.miniapp_entered_at; v_bot := a.bot_entered_at; v_rounds := experience.user_total_round(v_user_id);
    v_initialized := a.st_initialized_at;
    -- Reconstruct a delayed Mujian report using the snapshot taken BEFORE the first Mijing entry.
    -- Compare the snapshot's evidence to Mujian's launch, not Mijing's later launch.
    SELECT * INTO prior FROM miniapp_traffic.app_entry_facts
      WHERE user_id = v_user_id AND surface = 'mijing' ORDER BY launched_at, received_at LIMIT 1;
    v_prior_entry := FOUND AND prior.launched_at <= p_launch;
    IF p_surface = 'mujian' AND FOUND AND prior.launched_at > p_launch THEN
      v_entered := (prior.eligibility_basis->>'miniapp_entered_at')::timestamptz;
      v_bot := (prior.eligibility_basis->>'bot_entered_at')::timestamptz;
      v_initialized := (prior.eligibility_basis->>'st_initialized_at')::timestamptz;
      v_history := (prior.eligibility_basis->>'first_chat_at')::timestamptz;
      v_rounds := (prior.eligibility_basis->>'total_round')::bigint;
      v_new := (prior.eligibility_basis->>'created_by_entry')::boolean;
      v_reordered := true;
    END IF;
    IF v_prior_entry OR (v_entered IS NOT NULL AND v_entered < p_launch)
      OR (v_initialized IS NOT NULL AND v_initialized < p_launch)
      OR (v_history IS NOT NULL AND v_history < p_launch) THEN
      v_eligibility := 'existing'; v_reason := 'prior_entry_or_usage';
    ELSIF COALESCE(v_rounds, 0) > 0 OR v_history IS NOT NULL OR v_initialized IS NOT NULL THEN
      v_eligibility := 'unknown'; v_reason := 'usage_order_uncertain';
    ELSIF v_new THEN
      v_eligibility := 'new'; v_reason := 'created_without_mijing_entry';
    ELSIF v_entered IS NULL AND v_bot IS NOT NULL THEN
      v_eligibility := 'new'; v_reason := 'bot_only_no_mijing_entry_or_usage';
    ELSIF v_entered >= p_launch + interval '1 second' THEN
      -- Other authenticated Mijing APIs may already have set the first-entry marker for this launch.
      v_eligibility := 'new'; v_reason := 'first_entry_after_signed_launch';
    ELSE
      v_eligibility := 'unknown'; v_reason := 'history_not_proven';
    END IF;
    v_basis := jsonb_build_object('version',1,'reason',v_reason,'miniapp_entered_at',v_entered,
      'bot_entered_at',v_bot,'st_initialized_at',v_initialized,'total_round',v_rounds,'first_chat_at',v_history,
      'created_by_entry',v_new,'reordered',v_reordered);
  END IF;

  INSERT INTO miniapp_traffic.app_entry_facts(user_id,surface,source_key,launched_at,eligibility,eligibility_basis)
    VALUES(v_user_id,p_surface,v_source,p_launch,v_eligibility,v_basis)
    ON CONFLICT (user_id,surface,source_key) DO UPDATE
      SET launched_at = LEAST(miniapp_traffic.app_entry_facts.launched_at, EXCLUDED.launched_at);

  IF p_surface = 'mijing' THEN
    UPDATE miniapp_traffic.user_attributions SET miniapp_entered_at = COALESCE(miniapp_entered_at,clock_timestamp()), updated_at = clock_timestamp()
      WHERE user_id = v_user_id AND miniapp_entered_at IS NULL;
  END IF;
  IF v_source <> '' AND EXISTS(SELECT 1 FROM miniapp_traffic.botlinks WHERE source_id = v_source) THEN
    UPDATE miniapp_traffic.user_attributions SET source_id = v_source, updated_at = clock_timestamp() WHERE user_id = v_user_id AND source_id IS NULL;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed > 0 THEN PERFORM miniapp_traffic.increment_click(v_source); END IF;
  END IF;

  -- A late report of an actual PRE-Mujian entry is historical evidence, not a subsequent conversion.
  -- Preserve the original decision snapshot; never invalidate because of an entry after first Mujian.
  UPDATE miniapp_traffic.app_entry_facts m
    SET eligibility_basis = m.eligibility_basis || jsonb_build_object(
      'initial_eligibility',m.eligibility,'historical_entry_before_mujian',e.launched_at), eligibility='existing', converted_at=NULL
    FROM (SELECT min(launched_at) AS launched_at FROM miniapp_traffic.app_entry_facts
      WHERE user_id=v_user_id AND surface='mijing') e
    WHERE m.user_id=v_user_id AND m.surface='mujian' AND m.eligibility <> 'existing'
      AND e.launched_at < (SELECT min(launched_at) FROM miniapp_traffic.app_entry_facts WHERE user_id=v_user_id AND surface='mujian');
  SELECT eligibility INTO v_eligibility FROM miniapp_traffic.app_entry_facts
    WHERE user_id=v_user_id AND surface=p_surface AND source_key=v_source;

  -- Reconcile on either arrival. Only the user's first Mijing launch can convert, and it must share source.
  -- Same-second launches count only if Mujian had already persisted before Mijing arrived.
  -- A delayed earlier Mijing launch can invalidate a tentative attribution from a later launch.
  UPDATE miniapp_traffic.app_entry_facts SET converted_at = NULL WHERE user_id=v_user_id AND surface='mujian';
  UPDATE miniapp_traffic.app_entry_facts m SET converted_at = e.launched_at
    FROM miniapp_traffic.app_entry_facts e
    WHERE m.user_id = v_user_id AND m.surface = 'mujian' AND m.eligibility = 'new'
      AND m.source_key <> '' AND m.converted_at IS NULL
      AND e.user_id = m.user_id AND e.surface = 'mijing' AND e.source_key = m.source_key
      AND (e.launched_at > m.launched_at OR (e.launched_at = m.launched_at AND e.received_at > m.received_at))
      AND NOT EXISTS (SELECT 1 FROM miniapp_traffic.app_entry_facts earlier
        WHERE earlier.user_id = v_user_id AND earlier.surface = 'mijing'
          AND (earlier.launched_at,earlier.received_at) < (e.launched_at,e.received_at));
  SELECT EXISTS(SELECT 1 FROM miniapp_traffic.app_entry_facts WHERE user_id=v_user_id AND surface='mujian'
    AND source_key=v_source AND converted_at IS NOT NULL) INTO v_converted;
  RETURN jsonb_build_object('recorded',true,'source_id',NULLIF(v_source,''),'eligibility',v_eligibility,'converted',v_converted);
END;
$function$;

-- 4. 视图 ------------------------------------------------------------------
DROP VIEW IF EXISTS miniapp_analytics.v_user_ecosystem_daily, miniapp_analytics.v_daily_funnel,
  miniapp_analytics.v_miniapp_cohort_ltv, miniapp_analytics.v_miniapp_cohort_retention,
  miniapp_analytics.base_cohort_members, miniapp_analytics.base_users_bj,
  miniapp_analytics.base_first_session, miniapp_analytics.base_chat_bj;

-- 客服视图：输出列与类型不变（客服仓库读它）。
CREATE OR REPLACE VIEW cs_feed.user_profiles WITH (security_barrier = true) AS
 SELECT i.user_id,
    i.tg_id,
    i.display_name,
    i.username,
    a.source_id,
    COALESCE(a.miniapp_entered_at, u.created_at) AS registered_at,
    v.valid_until AS vip_valid_until,
    (COALESCE(w.total_paid_amount, (0)::numeric))::numeric(12,2) AS total_paid_amount,
    (COALESCE(p.paid_count, (0)::bigint))::integer AS paid_count,
    COALESCE(w.first_paid_at, p.first_paid_at) AS first_paid_at,
    COALESCE(w.last_paid_at, p.last_paid_at) AS last_paid_at,
    ((COALESCE(w.main_credits, (0)::numeric) + COALESCE(w.bonus_credits, (0)::numeric)))::numeric(14,2) AS credits_balance,
    COALESCE(st.total_round, (0)::bigint) AS total_rounds,
    cs_last.last_message_at AS last_chat_at
   FROM cs_feed.user_identities i
     JOIN app_core.users u ON u.id = i.user_id
     LEFT JOIN miniapp_traffic.user_attributions a ON a.user_id = i.user_id
     LEFT JOIN experience.user_chat_stats st ON st.user_id = i.user_id
     LEFT JOIN billing.user_wallets w ON w.user_id = i.user_id
     LEFT JOIN billing.vip_memberships v ON v.user_id = i.user_id
     LEFT JOIN LATERAL ( SELECT count(*) AS paid_count,
            min(o.paid_at) AS first_paid_at,
            max(o.paid_at) AS last_paid_at
           FROM billing.payment_orders o
          WHERE o.user_id = i.user_id AND o.status = 'completed'::text) p ON true
     LEFT JOIN LATERAL ( SELECT cs.last_message_at
           FROM experience.chat_sessions cs
          WHERE cs.user_id = i.user_id AND cs.deleted_at IS NULL
          ORDER BY cs.last_message_at DESC NULLS LAST
         LIMIT 1) cs_last ON true;

-- 推广日统计（运营在 Supabase 后台查看）：把 app_core.users 换成"身份+归因+轮数"的同形 CTE，口径不变。
DO $traffic$
DECLARE
  v_def text := pg_get_viewdef('miniapp_traffic.traffic_daily_stats'::regclass);
BEGIN
  IF position('user_facts' IN v_def) > 0 THEN
    RETURN;
  END IF;
  v_def := replace(v_def, '(COALESCE(u_1.miniapp_entered_at, u_1.created_at))::date', 'u_1.entered_date');
  v_def := replace(v_def, 'app_core.users u_1', 'user_facts u_1');
  v_def := regexp_replace(v_def, '^\s*WITH\s+', 'WITH user_facts AS (
         SELECT u.id, a.source_id, (COALESCE(a.miniapp_entered_at, u.created_at))::date AS entered_date,
            COALESCE(st.total_round, (0)::bigint) AS total_round
           FROM app_core.users u
             JOIN miniapp_traffic.user_attributions a ON a.user_id = u.id
             LEFT JOIN experience.user_chat_stats st ON st.user_id = u.id
        ), ');
  IF position('app_core.users u_1' IN v_def) > 0 OR position('miniapp_entered_at, u_1' IN v_def) > 0
     OR position('WITH user_facts' IN v_def) = 0 THEN
    RAISE EXCEPTION 'traffic_daily_stats rewrite did not apply cleanly';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW miniapp_traffic.traffic_daily_stats AS ' || v_def;
END
$traffic$;

-- 5. 发布窗口兼容：旧后端写 users 归因列 → 同步到新表（只补空值）。收缩步删除。
CREATE OR REPLACE FUNCTION app_core.tf_sync_user_attribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO miniapp_traffic.user_attributions AS ua
    (user_id, source_id, bot_entered_at, miniapp_entered_at, st_initialized_at)
  VALUES (NEW.id, NEW.source_id, NEW.bot_entered_at, NEW.miniapp_entered_at,
    (to_jsonb(NEW) ->> 'st_initialized_at')::timestamptz)
  ON CONFLICT (user_id) DO UPDATE SET
    source_id = COALESCE(ua.source_id, EXCLUDED.source_id),
    bot_entered_at = COALESCE(ua.bot_entered_at, EXCLUDED.bot_entered_at),
    miniapp_entered_at = COALESCE(ua.miniapp_entered_at, EXCLUDED.miniapp_entered_at),
    st_initialized_at = COALESCE(ua.st_initialized_at, EXCLUDED.st_initialized_at),
    updated_at = now()
  WHERE (ua.source_id IS NULL AND EXCLUDED.source_id IS NOT NULL)
     OR (ua.bot_entered_at IS NULL AND EXCLUDED.bot_entered_at IS NOT NULL)
     OR (ua.miniapp_entered_at IS NULL AND EXCLUDED.miniapp_entered_at IS NOT NULL)
     OR (ua.st_initialized_at IS NULL AND EXCLUDED.st_initialized_at IS NOT NULL);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_core.tf_sync_user_attribution() FROM PUBLIC;
DROP TRIGGER IF EXISTS users_sync_attribution ON app_core.users;
CREATE TRIGGER users_sync_attribution
  AFTER INSERT OR UPDATE OF source_id, bot_entered_at, miniapp_entered_at ON app_core.users
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_sync_user_attribution();

NOTIFY pgrst, 'reload schema';
COMMIT;
