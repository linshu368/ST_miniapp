-- Domain: miniapp_features（用户标记）+ app_core（用户偏好）+ billing（首发分享）——阶段 3b-1 收缩步。
-- 计划见 .trellis/tasks/11-17-db-reorg-p3-user-state/design.md 3b-1。
--
-- 前置：20261117_db_reorg_p3b1_user_marks.sql 已执行；生产后端已改读写 miniapp_features.user_marks、
--   首发分享改读 billing.image_plaza_share_rewards，并核对旧写法停涨（见 design.md 核对步骤）。
-- 步骤：
--   1. 删两个发布窗口同步触发器；
--   2. 锁 settings，按回填规则再补一次（吸收窗口内只落在 settings 的写入），补齐后仍有缺口则拒绝；
--   3. 删兼容视图 miniapp_features.growth_prompt_states；
--   4. billing.share_image_plaza_artifact 去掉写 settings 首发分享时间的那段 upsert
--      （按原文定位，删掉的文本必须与预期语句完全一致，否则拒绝，避免覆盖别人对该函数的改动）；
--   5. 删 settings 的 vip_entry_seen_at / characters_last_seen_at / image_plaza_first_share_completed_at。
--
-- Verify: bash scripts/test-db-reorg-p3b1-migration.sh（末段）。
-- Release: TEST -> Production。
-- Recovery: 不可逆；标记已在 user_marks，首发分享可由返利记录推导，必要时可加回列并回填。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP TRIGGER IF EXISTS settings_sync_marks ON app_core.miniapp_user_settings;
DROP TRIGGER IF EXISTS user_marks_sync_settings ON miniapp_features.user_marks;
DROP FUNCTION IF EXISTS app_core.tf_sync_settings_marks();
DROP FUNCTION IF EXISTS miniapp_features.tf_sync_marks_settings();

DO $reconcile$
BEGIN
  IF to_regclass('miniapp_features.user_marks') IS NULL THEN
    RAISE EXCEPTION 'apply 20261117_db_reorg_p3b1_user_marks.sql first';
  END IF;
  -- 只有 settings 还有这些列时才需要补齐与核对（可重跑）。
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'app_core' AND table_name = 'miniapp_user_settings'
               AND column_name = 'vip_entry_seen_at') THEN
    -- 后面 DROP COLUMN 本来就要 ACCESS EXCLUSIVE，提前拿锁，补齐与删列之间不会再有写入。
    LOCK TABLE app_core.miniapp_user_settings IN ACCESS EXCLUSIVE MODE;

    INSERT INTO miniapp_features.user_marks AS m (user_id, mark_key, count, first_at, last_at, created_at, updated_at)
    SELECT s.user_id, 'vip_entry.seen', 1, s.vip_entry_seen_at, s.vip_entry_seen_at, now(), now()
    FROM app_core.miniapp_user_settings s WHERE s.vip_entry_seen_at IS NOT NULL
    ON CONFLICT (user_id, mark_key) DO UPDATE SET
      count = GREATEST(m.count, 1),
      first_at = LEAST(m.first_at, EXCLUDED.first_at),
      last_at = GREATEST(m.last_at, EXCLUDED.last_at),
      updated_at = now()
    WHERE m.first_at IS NULL OR m.first_at > EXCLUDED.first_at OR m.last_at IS NULL OR m.last_at < EXCLUDED.last_at;

    INSERT INTO miniapp_features.user_marks AS m (user_id, mark_key, count, first_at, last_at, created_at, updated_at)
    SELECT s.user_id, 'characters_latest.seen', 1, s.characters_last_seen_at, s.characters_last_seen_at, now(), now()
    FROM app_core.miniapp_user_settings s WHERE s.characters_last_seen_at IS NOT NULL
    ON CONFLICT (user_id, mark_key) DO UPDATE SET
      count = GREATEST(m.count, 1),
      first_at = LEAST(m.first_at, EXCLUDED.first_at),
      last_at = GREATEST(m.last_at, EXCLUDED.last_at),
      updated_at = now()
    WHERE m.first_at IS NULL OR m.last_at IS NULL OR m.last_at < EXCLUDED.last_at;

    IF EXISTS (SELECT 1 FROM app_core.miniapp_user_settings s
               LEFT JOIN miniapp_features.user_marks v ON v.user_id = s.user_id AND v.mark_key = 'vip_entry.seen'
               LEFT JOIN miniapp_features.user_marks c ON c.user_id = s.user_id AND c.mark_key = 'characters_latest.seen'
               WHERE (s.vip_entry_seen_at IS NOT NULL AND (v.first_at IS NULL OR v.first_at > s.vip_entry_seen_at))
                  OR (s.characters_last_seen_at IS NOT NULL AND (c.last_at IS NULL OR c.last_at < s.characters_last_seen_at))) THEN
      RAISE EXCEPTION 'user_marks is missing values still present on miniapp_user_settings';
    END IF;
    IF EXISTS (SELECT 1 FROM app_core.miniapp_user_settings s
               WHERE s.image_plaza_first_share_completed_at IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM billing.image_plaza_share_rewards r WHERE r.user_id = s.user_id)) THEN
      RAISE EXCEPTION 'first share completed without a share reward record; derivation would differ';
    END IF;
  END IF;
END
$reconcile$;

DROP VIEW IF EXISTS miniapp_features.growth_prompt_states;

DO $share$
DECLARE
  v_def text;
  v_start integer;
  v_len integer;
  v_removed text;
  c_head constant text := 'INSERT INTO app_core.miniapp_user_settings(user_id, image_plaza_first_share_completed_at)';
  c_tail constant text := 'updated_at = now();';
BEGIN
  v_def := replace(pg_get_functiondef(
    'billing.share_image_plaza_artifact(uuid,uuid,text,text,text[],numeric)'::regprocedure), E'\r', '');
  IF position('miniapp_user_settings' IN v_def) = 0 THEN
    RETURN;  -- 已去掉（重跑）
  END IF;
  v_start := position(c_head IN v_def);
  IF v_start = 0 THEN
    RAISE EXCEPTION 'share_image_plaza_artifact references miniapp_user_settings in an unexpected way';
  END IF;
  v_len := position(c_tail IN substr(v_def, v_start)) + length(c_tail) - 1;
  v_removed := substr(v_def, v_start, v_len);
  IF v_removed !~ ('^INSERT INTO app_core\.miniapp_user_settings\(user_id, image_plaza_first_share_completed_at\)\s+'
                   'VALUES \(p_user_id, now\(\)\)\s+ON CONFLICT \(user_id\) DO UPDATE\s+'
                   'SET image_plaza_first_share_completed_at = COALESCE\(\s+'
                   'app_core\.miniapp_user_settings\.image_plaza_first_share_completed_at,\s+'
                   'EXCLUDED\.image_plaza_first_share_completed_at\s+\),\s+updated_at = now\(\);$') THEN
    RAISE EXCEPTION 'share_image_plaza_artifact settings upsert changed; refusing to rewrite: %', v_removed;
  END IF;
  v_def := substr(v_def, 1, v_start - 1) || '-- 首发分享由 billing.image_plaza_share_rewards 是否有记录推导（3b-1）。'
           || substr(v_def, v_start + v_len);
  IF position('miniapp_user_settings' IN v_def) > 0 THEN
    RAISE EXCEPTION 'share_image_plaza_artifact still references miniapp_user_settings after rewrite';
  END IF;
  EXECUTE v_def;
END
$share$;

DO $guard$
DECLARE
  v_ref text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_ref
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosrc ~ '\m(vip_entry_seen_at|characters_last_seen_at|image_plaza_first_share_completed_at)\M'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema');
  IF v_ref IS NOT NULL THEN RAISE EXCEPTION 'functions still read moved settings columns: %', v_ref; END IF;
END
$guard$;

ALTER TABLE app_core.miniapp_user_settings
  DROP COLUMN IF EXISTS vip_entry_seen_at,
  DROP COLUMN IF EXISTS characters_last_seen_at,
  DROP COLUMN IF EXISTS image_plaza_first_share_completed_at;

NOTIFY pgrst, 'reload schema';
COMMIT;
