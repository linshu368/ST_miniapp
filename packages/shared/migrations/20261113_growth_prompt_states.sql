-- domain: miniapp_features. 增长弹窗（进群、VIP）每个用户的展示与处理记录。
-- 归属：随「增长弹窗」功能上线/下线，产品运行时读取它决定是否再弹，属功能状态投影；
-- 不记钱（星尘仍走 billing），也不是多领域共享的根数据，所以不进 billing / app_core / analytics。
-- Prerequisite: app_core.users 存在。
-- Verify: 本地 PG17 连续执行两次应无报错（scripts/test-growth-prompt-states-migration.sh）；
--         TEST 经 db-migrate workflow 执行后核对 shape、ACL 与函数返回。
-- Release: TEST -> production migration -> Backend -> Frontend。旧 Backend 不读新表，迁移先行安全。
-- Recovery: 回退应用即可，表与函数保留；数据库缺陷走 forward-fix。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.users') IS NULL THEN
    RAISE EXCEPTION 'app_core.users missing';
  END IF;
  IF to_regnamespace('miniapp_features') IS NULL THEN
    RAISE EXCEPTION 'schema miniapp_features missing';
  END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS miniapp_features.growth_prompt_states (
  user_id uuid NOT NULL CONSTRAINT growth_prompt_states_user_fkey REFERENCES app_core.users(id) ON DELETE CASCADE,
  prompt text NOT NULL CONSTRAINT growth_prompt_states_prompt_check CHECK (prompt IN ('community', 'vip')),
  shown_count integer NOT NULL DEFAULT 0 CONSTRAINT growth_prompt_states_shown_count_check CHECK (shown_count >= 0),
  first_shown_at timestamptz,
  last_shown_at timestamptz,
  last_action text CONSTRAINT growth_prompt_states_last_action_check CHECK (last_action IN ('accepted', 'dismissed')),
  last_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT growth_prompt_states_pkey PRIMARY KEY (user_id, prompt)
);
ALTER TABLE miniapp_features.growth_prompt_states OWNER TO postgres;
ALTER TABLE miniapp_features.growth_prompt_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.growth_prompt_states FROM PUBLIC, anon, authenticated, service_role;
-- 读状态直接查表；写只经下方函数，保证次数与间隔上限在一条语句内原子判定。
GRANT SELECT ON miniapp_features.growth_prompt_states TO service_role;
COMMENT ON TABLE miniapp_features.growth_prompt_states IS
  '增长弹窗（community 进群 / vip 月卡）每用户的展示次数、最近展示与最近处理。上限由 Backend 规则传入函数判定；随用户删除级联。';
COMMENT ON COLUMN miniapp_features.growth_prompt_states.shown_count IS '已展示次数（同一设备或跨设备累计）。';
COMMENT ON COLUMN miniapp_features.growth_prompt_states.last_action IS '最近一次处理：accepted 点了主按钮，dismissed 点了以后再说。';

CREATE OR REPLACE FUNCTION miniapp_features.record_growth_prompt_event(
  p_user_id uuid,
  p_prompt text,
  p_event text,
  p_max_shows integer,
  p_min_interval_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '3s'
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_prompt NOT IN ('community', 'vip')
    OR p_event NOT IN ('shown', 'accepted', 'dismissed') THEN
    RAISE EXCEPTION 'invalid growth prompt event';
  END IF;

  IF p_event = 'shown' THEN
    -- 条件 upsert：未达上限且距上次展示已过间隔才计数；两台设备同时弹也只会有一次成功。
    INSERT INTO miniapp_features.growth_prompt_states AS s
      (user_id, prompt, shown_count, first_shown_at, last_shown_at, updated_at)
    VALUES (p_user_id, p_prompt, 1, clock_timestamp(), clock_timestamp(), clock_timestamp())
    ON CONFLICT (user_id, prompt) DO UPDATE
      SET shown_count = s.shown_count + 1,
          first_shown_at = COALESCE(s.first_shown_at, EXCLUDED.first_shown_at),
          last_shown_at = EXCLUDED.last_shown_at,
          updated_at = EXCLUDED.updated_at
      WHERE s.shown_count < GREATEST(COALESCE(p_max_shows, 0), 0)
        AND (s.last_shown_at IS NULL
          OR s.last_shown_at <= clock_timestamp() - make_interval(secs => GREATEST(COALESCE(p_min_interval_seconds, 0), 0)))
    RETURNING s.shown_count INTO v_count;
    IF v_count IS NULL THEN
      SELECT shown_count INTO v_count FROM miniapp_features.growth_prompt_states
        WHERE user_id = p_user_id AND prompt = p_prompt;
      RETURN jsonb_build_object('recorded', false, 'shown_count', COALESCE(v_count, 0));
    END IF;
    RETURN jsonb_build_object('recorded', true, 'shown_count', v_count);
  END IF;

  UPDATE miniapp_features.growth_prompt_states
    SET last_action = p_event, last_action_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE user_id = p_user_id AND prompt = p_prompt
    RETURNING shown_count INTO v_count;
  RETURN jsonb_build_object('recorded', v_count IS NOT NULL, 'shown_count', COALESCE(v_count, 0));
END;
$fn$;

ALTER FUNCTION miniapp_features.record_growth_prompt_event(uuid, text, text, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION miniapp_features.record_growth_prompt_event(uuid, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_features.record_growth_prompt_event(uuid, text, text, integer, integer)
  TO service_role;
COMMENT ON FUNCTION miniapp_features.record_growth_prompt_event(uuid, text, text, integer, integer) IS
  '记录增长弹窗事件：shown 在上限与间隔内原子 +1（返回 recorded=false 表示已超额），accepted/dismissed 更新最近处理。';

DO $verify$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'miniapp_features.growth_prompt_states'::regclass)
    OR has_table_privilege('anon', 'miniapp_features.growth_prompt_states', 'SELECT')
    OR has_table_privilege('authenticated', 'miniapp_features.growth_prompt_states', 'SELECT')
    OR NOT has_table_privilege('service_role', 'miniapp_features.growth_prompt_states', 'SELECT')
    OR has_table_privilege('service_role', 'miniapp_features.growth_prompt_states', 'INSERT')
    OR has_table_privilege('service_role', 'miniapp_features.growth_prompt_states', 'UPDATE')
    OR has_function_privilege('anon', 'miniapp_features.record_growth_prompt_event(uuid,text,text,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'miniapp_features.record_growth_prompt_event(uuid,text,text,integer,integer)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'miniapp_features.record_growth_prompt_event(uuid,text,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'growth prompt permission verification failed';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';
COMMIT;
