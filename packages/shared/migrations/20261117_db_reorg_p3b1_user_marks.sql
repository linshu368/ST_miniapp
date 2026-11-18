-- Domain: miniapp_features（用户标记）+ app_core（用户偏好）+ billing（只加索引）。
-- 数据库重组阶段 3b-1（扩展步），规则见 docs/db/CONTRACT.md §2 第 6 条，计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3b-1。
--
-- 终态：一次性/水位类 UI 标记统一进 miniapp_features.user_marks（每用户每标记一行，mark_key 区分，不加列）。
--   growth_prompt.<community|vip> ← miniapp_features.growth_prompt_states（整表并入）
--   vip_entry.seen                ← app_core.miniapp_user_settings.vip_entry_seen_at（first_at）
--   characters_latest.seen        ← app_core.miniapp_user_settings.characters_last_seen_at（last_at）
-- 本文件（扩展）：
--   1. 建 user_marks 并回填；
--   2. 新函数 miniapp_features.touch_user_mark；record_growth_prompt_event 改写 user_marks（签名与判定不变）；
--   3. growth_prompt_states 原表删除，留同名只读兼容视图给旧后端（列名照旧）；
--   4. 发布窗口双向同步：旧后端写 settings 两列 → 同步进 user_marks；新后端写 user_marks → 回写 settings；
--   5. 删除 10-13 起只为回滚保留的 *_full_rules_remaining 三列、claim_instruction_slot_modes 与配套函数、触发器
--      （会话级 full/concise 由 chat_history.turn_index 决定，后端不读，claim 函数 0 次调用）；
--   6. billing.image_plaza_share_rewards 加 user_id 索引（"已完成首发分享"改由返利记录推导）。
-- 收缩步（后端发布后）：20261117_db_reorg_p3b1_user_marks_contract.sql 删同步触发器、兼容视图、settings 三列，
--   share_image_plaza_artifact 去掉 settings upsert。
--
-- Verify: bash scripts/test-db-reorg-p3b1-migration.sh
-- Release: TEST -> Production -> 后端发布 -> 收缩步。
-- Recovery: 标记列仍在 settings 且双向同步；回退后端即可。删掉的三列计数器无读者，不恢复。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. 新表 -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS miniapp_features.user_marks (
  user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  mark_key text NOT NULL CHECK (mark_key ~ '^[a-z][a-z0-9_]{0,31}\.[a-z][a-z0-9_]{0,31}$'),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  first_at timestamptz,
  last_at timestamptz,
  last_action text CHECK (last_action IS NULL OR last_action ~ '^[a-z][a-z_]{0,31}$'),
  last_action_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mark_key)
);
COMMENT ON TABLE miniapp_features.user_marks IS
  '用户一次性/水位类 UI 标记（看过、做过、弹过几次）。mark_key = <功能>.<事件>，新标记不改表。写只经 touch_user_mark / record_growth_prompt_event；随用户删除级联。';
COMMENT ON COLUMN miniapp_features.user_marks.first_at IS '第一次发生的时间，写入后不变。';
COMMENT ON COLUMN miniapp_features.user_marks.last_at IS '最近一次发生的时间（水位）。';

ALTER TABLE miniapp_features.user_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.user_marks FROM PUBLIC;
DO $acl$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE ALL ON miniapp_features.user_marks FROM %I', v_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON miniapp_features.user_marks TO service_role;
  END IF;
END
$acl$;

-- 2. 回填（可重跑：次数取大、first_at 取早、last_at 取晚）---------------------------
DO $backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'miniapp_features' AND c.relname = 'growth_prompt_states' AND c.relkind = 'r') THEN
    INSERT INTO miniapp_features.user_marks AS m
      (user_id, mark_key, count, first_at, last_at, last_action, last_action_at, created_at, updated_at)
    SELECT g.user_id, 'growth_prompt.' || g.prompt, g.shown_count, g.first_shown_at, g.last_shown_at,
      g.last_action, g.last_action_at, g.created_at, g.updated_at
    FROM miniapp_features.growth_prompt_states g
    ON CONFLICT (user_id, mark_key) DO UPDATE SET
      count = GREATEST(m.count, EXCLUDED.count),
      first_at = LEAST(m.first_at, EXCLUDED.first_at),
      last_at = GREATEST(m.last_at, EXCLUDED.last_at),
      last_action = CASE WHEN EXCLUDED.last_action_at > m.last_action_at OR m.last_action_at IS NULL
                         THEN EXCLUDED.last_action ELSE m.last_action END,
      last_action_at = GREATEST(m.last_action_at, EXCLUDED.last_action_at);
  END IF;
END
$backfill$;

INSERT INTO miniapp_features.user_marks AS m (user_id, mark_key, count, first_at, last_at, created_at, updated_at)
SELECT s.user_id, 'vip_entry.seen', 1, v.at, v.at, v.at, v.at
FROM app_core.miniapp_user_settings s
CROSS JOIN LATERAL (SELECT (to_jsonb(s) ->> 'vip_entry_seen_at')::timestamptz AS at) v
WHERE v.at IS NOT NULL
ON CONFLICT (user_id, mark_key) DO UPDATE SET
  count = GREATEST(m.count, 1),
  first_at = LEAST(m.first_at, EXCLUDED.first_at),
  last_at = GREATEST(m.last_at, EXCLUDED.last_at);

INSERT INTO miniapp_features.user_marks AS m (user_id, mark_key, count, first_at, last_at, created_at, updated_at)
SELECT s.user_id, 'characters_latest.seen', 1, v.at, v.at, v.at, v.at
FROM app_core.miniapp_user_settings s
CROSS JOIN LATERAL (SELECT (to_jsonb(s) ->> 'characters_last_seen_at')::timestamptz AS at) v
WHERE v.at IS NOT NULL
ON CONFLICT (user_id, mark_key) DO UPDATE SET
  count = GREATEST(m.count, 1),
  first_at = LEAST(m.first_at, EXCLUDED.first_at),
  last_at = GREATEST(m.last_at, EXCLUDED.last_at);

-- 3. 函数 ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION miniapp_features.touch_user_mark(
  p_user_id uuid, p_mark_key text, p_at timestamptz DEFAULT NULL
) RETURNS TABLE(count integer, first_at timestamptz, last_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_at timestamptz := COALESCE(p_at, clock_timestamp());
BEGIN
  IF p_user_id IS NULL OR p_mark_key IS NULL THEN
    RAISE EXCEPTION 'user id and mark key are required' USING ERRCODE = '22023';
  END IF;
  -- 一条 upsert 完成计数与水位，多端同时触发不会丢次数；first_at 只在首次写入。
  RETURN QUERY
  INSERT INTO miniapp_features.user_marks AS m (user_id, mark_key, count, first_at, last_at, created_at, updated_at)
  VALUES (p_user_id, p_mark_key, 1, v_at, v_at, clock_timestamp(), clock_timestamp())
  ON CONFLICT (user_id, mark_key) DO UPDATE SET
    count = m.count + 1,
    first_at = COALESCE(m.first_at, EXCLUDED.first_at),
    last_at = GREATEST(m.last_at, EXCLUDED.last_at),
    updated_at = clock_timestamp()
  RETURNING m.count, m.first_at, m.last_at;
END;
$fn$;
COMMENT ON FUNCTION miniapp_features.touch_user_mark(uuid, text, timestamptz) IS
  '记一次用户标记：count+1，first_at 只写一次，last_at 取最新。p_at 缺省为数据库时间。';

CREATE OR REPLACE FUNCTION miniapp_features.record_growth_prompt_event(
  p_user_id uuid, p_prompt text, p_event text, p_max_shows integer, p_min_interval_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '3s'
AS $fn$
DECLARE
  v_count integer;
  v_key text;
BEGIN
  IF p_user_id IS NULL OR p_prompt NOT IN ('community', 'vip')
    OR p_event NOT IN ('shown', 'accepted', 'dismissed') THEN
    RAISE EXCEPTION 'invalid growth prompt event';
  END IF;
  v_key := 'growth_prompt.' || p_prompt;

  IF p_event = 'shown' THEN
    -- 条件 upsert：未达上限且距上次展示已过间隔才计数；两台设备同时弹也只会有一次成功。
    INSERT INTO miniapp_features.user_marks AS m
      (user_id, mark_key, count, first_at, last_at, updated_at)
    VALUES (p_user_id, v_key, 1, clock_timestamp(), clock_timestamp(), clock_timestamp())
    ON CONFLICT (user_id, mark_key) DO UPDATE
      SET count = m.count + 1,
          first_at = COALESCE(m.first_at, EXCLUDED.first_at),
          last_at = EXCLUDED.last_at,
          updated_at = EXCLUDED.updated_at
      WHERE m.count < GREATEST(COALESCE(p_max_shows, 0), 0)
        AND (m.last_at IS NULL
          OR m.last_at <= clock_timestamp() - make_interval(secs => GREATEST(COALESCE(p_min_interval_seconds, 0), 0)))
    RETURNING m.count INTO v_count;
    IF v_count IS NULL THEN
      SELECT m.count INTO v_count FROM miniapp_features.user_marks m
        WHERE m.user_id = p_user_id AND m.mark_key = v_key;
      RETURN jsonb_build_object('recorded', false, 'shown_count', COALESCE(v_count, 0));
    END IF;
    RETURN jsonb_build_object('recorded', true, 'shown_count', v_count);
  END IF;

  UPDATE miniapp_features.user_marks m
    SET last_action = p_event, last_action_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE m.user_id = p_user_id AND m.mark_key = v_key
    RETURNING m.count INTO v_count;
  RETURN jsonb_build_object('recorded', v_count IS NOT NULL, 'shown_count', COALESCE(v_count, 0));
END;
$fn$;

DO $fn_acl$
BEGIN
  REVOKE ALL ON FUNCTION miniapp_features.touch_user_mark(uuid, text, timestamptz) FROM PUBLIC;
  REVOKE ALL ON FUNCTION miniapp_features.record_growth_prompt_event(uuid, text, text, integer, integer) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION miniapp_features.touch_user_mark(uuid, text, timestamptz) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION miniapp_features.touch_user_mark(uuid, text, timestamptz) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION miniapp_features.touch_user_mark(uuid, text, timestamptz) TO service_role;
    GRANT EXECUTE ON FUNCTION miniapp_features.record_growth_prompt_event(uuid, text, text, integer, integer) TO service_role;
  END IF;
END
$fn_acl$;

-- 4. growth_prompt_states → 只读兼容视图（旧后端 readStates 用，收缩步删除）--------------
DO $compat$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'miniapp_features' AND c.relname = 'growth_prompt_states' AND c.relkind = 'r') THEN
    DROP TABLE miniapp_features.growth_prompt_states;
  END IF;
END
$compat$;
CREATE OR REPLACE VIEW miniapp_features.growth_prompt_states WITH (security_invoker = true) AS
  SELECT m.user_id, substr(m.mark_key, 15) AS prompt, m.count AS shown_count,
    m.first_at AS first_shown_at, m.last_at AS last_shown_at, m.last_action, m.last_action_at,
    m.created_at, m.updated_at
  FROM miniapp_features.user_marks m
  WHERE m.mark_key LIKE 'growth_prompt.%';
COMMENT ON VIEW miniapp_features.growth_prompt_states IS
  '发布窗口兼容视图（3b-1）：旧后端仍按原列名读增长弹窗状态。收缩步删除。';
REVOKE ALL ON miniapp_features.growth_prompt_states FROM PUBLIC;
DO $view_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON miniapp_features.growth_prompt_states TO service_role;
  END IF;
END
$view_acl$;

-- 5. 发布窗口双向同步（收缩步删除）---------------------------------------------
-- 只在值变化时写；pg_trigger_depth 防止两个触发器互相回写。
CREATE OR REPLACE FUNCTION app_core.tf_sync_settings_marks()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF NEW.vip_entry_seen_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.vip_entry_seen_at IS DISTINCT FROM OLD.vip_entry_seen_at) THEN
    INSERT INTO miniapp_features.user_marks AS m (user_id, mark_key, count, first_at, last_at)
    VALUES (NEW.user_id, 'vip_entry.seen', 1, NEW.vip_entry_seen_at, NEW.vip_entry_seen_at)
    ON CONFLICT (user_id, mark_key) DO UPDATE SET
      first_at = COALESCE(m.first_at, EXCLUDED.first_at),
      last_at = GREATEST(m.last_at, EXCLUDED.last_at),
      updated_at = clock_timestamp()
    WHERE m.first_at IS NULL OR m.last_at IS NULL OR m.last_at < EXCLUDED.last_at;
  END IF;
  IF NEW.characters_last_seen_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.characters_last_seen_at IS DISTINCT FROM OLD.characters_last_seen_at) THEN
    INSERT INTO miniapp_features.user_marks AS m (user_id, mark_key, count, first_at, last_at)
    VALUES (NEW.user_id, 'characters_latest.seen', 1, NEW.characters_last_seen_at, NEW.characters_last_seen_at)
    ON CONFLICT (user_id, mark_key) DO UPDATE SET
      first_at = COALESCE(m.first_at, EXCLUDED.first_at),
      last_at = GREATEST(m.last_at, EXCLUDED.last_at),
      updated_at = clock_timestamp()
    WHERE m.first_at IS NULL OR m.last_at IS NULL OR m.last_at < EXCLUDED.last_at;
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS settings_sync_marks ON app_core.miniapp_user_settings;
CREATE TRIGGER settings_sync_marks
  AFTER INSERT OR UPDATE OF vip_entry_seen_at, characters_last_seen_at ON app_core.miniapp_user_settings
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_sync_settings_marks();

CREATE OR REPLACE FUNCTION miniapp_features.tf_sync_marks_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF NEW.mark_key = 'vip_entry.seen' AND NEW.first_at IS NOT NULL THEN
    -- 旧后端语义：只写首次查看时间，已有值不覆盖。
    INSERT INTO app_core.miniapp_user_settings AS s (user_id, vip_entry_seen_at)
    VALUES (NEW.user_id, NEW.first_at)
    ON CONFLICT (user_id) DO UPDATE SET vip_entry_seen_at = EXCLUDED.vip_entry_seen_at
    WHERE s.vip_entry_seen_at IS NULL;
  ELSIF NEW.mark_key = 'characters_latest.seen' AND NEW.last_at IS NOT NULL THEN
    INSERT INTO app_core.miniapp_user_settings AS s (user_id, characters_last_seen_at)
    VALUES (NEW.user_id, NEW.last_at)
    ON CONFLICT (user_id) DO UPDATE SET characters_last_seen_at = EXCLUDED.characters_last_seen_at
    WHERE s.characters_last_seen_at IS NULL OR s.characters_last_seen_at < EXCLUDED.characters_last_seen_at;
  END IF;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS user_marks_sync_settings ON miniapp_features.user_marks;
CREATE TRIGGER user_marks_sync_settings
  AFTER INSERT OR UPDATE ON miniapp_features.user_marks
  FOR EACH ROW EXECUTE FUNCTION miniapp_features.tf_sync_marks_settings();
REVOKE ALL ON FUNCTION app_core.tf_sync_settings_marks() FROM PUBLIC;
REVOKE ALL ON FUNCTION miniapp_features.tf_sync_marks_settings() FROM PUBLIC;

-- 6. 删除只为回滚保留的指令槽计数器 ---------------------------------------------
DO $legacy$
DECLARE
  v_ref text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosrc ~ '(choice|status|memory)_full_rules_remaining|instruction_slot_claim_|claim_instruction_slot_modes'
    AND NOT (n.nspname = 'app_core' AND p.proname IN (
      'apply_instruction_slot_preference_window', 'claim_instruction_slot_modes',
      'instruction_slot_claim_enter', 'instruction_slot_claim_ok'));
  IF v_ref IS NOT NULL THEN
    RAISE EXCEPTION 'legacy instruction slot counters still referenced by: %', v_ref;
  END IF;
END
$legacy$;
DROP TRIGGER IF EXISTS trg_apply_instruction_slot_preference_window ON app_core.miniapp_user_settings;
DROP FUNCTION IF EXISTS app_core.apply_instruction_slot_preference_window();
DROP FUNCTION IF EXISTS app_core.claim_instruction_slot_modes(uuid);
DROP FUNCTION IF EXISTS app_core.instruction_slot_claim_ok();
DROP FUNCTION IF EXISTS app_core.instruction_slot_claim_enter();
ALTER TABLE app_core.miniapp_user_settings
  DROP COLUMN IF EXISTS choice_full_rules_remaining,
  DROP COLUMN IF EXISTS status_full_rules_remaining,
  DROP COLUMN IF EXISTS memory_full_rules_remaining;

-- 7. 首发分享推导用索引 -----------------------------------------------------------
CREATE INDEX IF NOT EXISTS image_plaza_share_rewards_user_idx
  ON billing.image_plaza_share_rewards (user_id);

NOTIFY pgrst, 'reload schema';
COMMIT;
