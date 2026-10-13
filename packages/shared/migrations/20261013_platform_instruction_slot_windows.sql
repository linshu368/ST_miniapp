-- 20261013_platform_instruction_slot_windows.sql
-- domain: app_core + experience
-- 前置：20260928_chat_history_postprocess_version.sql；
--       20260930_bind_current_text_postprocess_on_turn_start.sql。
--
-- 真相与归属：用户级开关和每槽位剩余完整规则次数属于 app_core（跨所有会话的长期偏好）；
-- 每个逻辑轮已经裁决出的模式属于 experience.chat_history（该轮 revision 的不可变输入快照）。
-- 权威写入方：app_core.update_instruction_slot_preferences 处理开关切换；
-- experience 的 current-postprocess 开轮 wrapper 在同一事务中领取次数并写入 history 快照。
-- interaction_mode_blocks 保留为旧应用回退数据；本迁移不读取、更新或删除它。
--
-- 锁与容量：偏好写入/新逻辑轮仅锁一条 miniapp_user_settings 行；开轮仍由既有
-- chat_sessions 行锁串行同一会话。新增列均为窄类型；不扫历史、不回填 history。
-- 发布顺序：先执行本文件，再发布消费三个模式的新 Backend；旧 Backend 忽略新列。
-- 失败时当前事务回滚；已提交后仅允许 reviewed forward-fix，不删除已写 history 快照。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_signature text;
  v_owner name;
  v_definer boolean;
  v_config text[];
BEGIN
  IF to_regclass('app_core.miniapp_user_settings') IS NULL
     OR to_regclass('experience.chat_sessions') IS NULL
     OR to_regclass('experience.chat_history') IS NULL
     OR to_regclass('experience.current_chat_history') IS NULL THEN
    RAISE EXCEPTION '20261013 platform instruction slots preflight: required relations missing';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
    'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION '20261013 platform instruction slots preflight: required function missing: %', v_signature;
    END IF;
    SELECT pg_catalog.pg_get_userbyid(proc.proowner), proc.prosecdef, proc.proconfig
      INTO v_owner, v_definer, v_config
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = to_regprocedure(v_signature);
    IF v_owner IS DISTINCT FROM 'postgres'
       OR v_definer IS DISTINCT FROM true
       OR NOT COALESCE(v_config, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION '20261013 platform instruction slots preflight: unsafe current-postprocess wrapper: %', v_signature;
    END IF;
  END LOOP;
END
$preflight$;

ALTER TABLE app_core.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS pref_show_status boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pref_show_memory boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS choice_full_rules_remaining smallint NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS status_full_rules_remaining smallint NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS memory_full_rules_remaining smallint NOT NULL DEFAULT 2;

-- 保留 pref_show_options 的原值；历史关闭的槽位没有待消费的完整规则。
UPDATE app_core.miniapp_user_settings
SET choice_full_rules_remaining = CASE WHEN pref_show_options THEN 2 ELSE 0 END,
    status_full_rules_remaining = CASE WHEN pref_show_status THEN 2 ELSE 0 END,
    memory_full_rules_remaining = CASE WHEN pref_show_memory THEN 2 ELSE 0 END
WHERE choice_full_rules_remaining IS DISTINCT FROM CASE WHEN pref_show_options THEN 2 ELSE 0 END
   OR status_full_rules_remaining IS DISTINCT FROM CASE WHEN pref_show_status THEN 2 ELSE 0 END
   OR memory_full_rules_remaining IS DISTINCT FROM CASE WHEN pref_show_memory THEN 2 ELSE 0 END;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
      AND conname = 'miniapp_user_settings_choice_full_rules_remaining_check'
  ) THEN
    ALTER TABLE app_core.miniapp_user_settings
      ADD CONSTRAINT miniapp_user_settings_choice_full_rules_remaining_check
      CHECK (choice_full_rules_remaining BETWEEN 0 AND 2) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
      AND conname = 'miniapp_user_settings_status_full_rules_remaining_check'
  ) THEN
    ALTER TABLE app_core.miniapp_user_settings
      ADD CONSTRAINT miniapp_user_settings_status_full_rules_remaining_check
      CHECK (status_full_rules_remaining BETWEEN 0 AND 2) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
      AND conname = 'miniapp_user_settings_memory_full_rules_remaining_check'
  ) THEN
    ALTER TABLE app_core.miniapp_user_settings
      ADD CONSTRAINT miniapp_user_settings_memory_full_rules_remaining_check
      CHECK (memory_full_rules_remaining BETWEEN 0 AND 2) NOT VALID;
  END IF;
END
$constraints$;

ALTER TABLE app_core.miniapp_user_settings
  VALIDATE CONSTRAINT miniapp_user_settings_choice_full_rules_remaining_check;
ALTER TABLE app_core.miniapp_user_settings
  VALIDATE CONSTRAINT miniapp_user_settings_status_full_rules_remaining_check;
ALTER TABLE app_core.miniapp_user_settings
  VALIDATE CONSTRAINT miniapp_user_settings_memory_full_rules_remaining_check;

COMMENT ON COLUMN app_core.miniapp_user_settings.pref_show_status IS
  '用户级状态栏开关；默认开启。';
COMMENT ON COLUMN app_core.miniapp_user_settings.pref_show_memory IS
  '用户级记忆栏开关；默认开启。';
COMMENT ON COLUMN app_core.miniapp_user_settings.choice_full_rules_remaining IS
  '选项槽位尚可分配的完整规则逻辑轮数，范围 0..2。';
COMMENT ON COLUMN app_core.miniapp_user_settings.status_full_rules_remaining IS
  '状态栏槽位尚可分配的完整规则逻辑轮数，范围 0..2。';
COMMENT ON COLUMN app_core.miniapp_user_settings.memory_full_rules_remaining IS
  '记忆栏槽位尚可分配的完整规则逻辑轮数，范围 0..2。';

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE experience.chat_history
  ADD COLUMN IF NOT EXISTS choice_rules_mode text,
  ADD COLUMN IF NOT EXISTS status_rules_mode text,
  ADD COLUMN IF NOT EXISTS memory_rules_mode text;

DO $mode_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'experience.chat_history'::regclass
      AND conname = 'chat_history_choice_rules_mode_check'
  ) THEN
    ALTER TABLE experience.chat_history
      ADD CONSTRAINT chat_history_choice_rules_mode_check
      CHECK (choice_rules_mode IS NULL OR choice_rules_mode IN ('full', 'concise', 'off')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'experience.chat_history'::regclass
      AND conname = 'chat_history_status_rules_mode_check'
  ) THEN
    ALTER TABLE experience.chat_history
      ADD CONSTRAINT chat_history_status_rules_mode_check
      CHECK (status_rules_mode IS NULL OR status_rules_mode IN ('full', 'concise', 'off')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'experience.chat_history'::regclass
      AND conname = 'chat_history_memory_rules_mode_check'
  ) THEN
    ALTER TABLE experience.chat_history
      ADD CONSTRAINT chat_history_memory_rules_mode_check
      CHECK (memory_rules_mode IS NULL OR memory_rules_mode IN ('full', 'concise', 'off')) NOT VALID;
  END IF;
END
$mode_constraints$;

ALTER TABLE experience.chat_history
  VALIDATE CONSTRAINT chat_history_choice_rules_mode_check;
ALTER TABLE experience.chat_history
  VALIDATE CONSTRAINT chat_history_status_rules_mode_check;
ALTER TABLE experience.chat_history
  VALIDATE CONSTRAINT chat_history_memory_rules_mode_check;

COMMENT ON COLUMN experience.chat_history.choice_rules_mode IS
  '开轮时裁决的选项规则模式；同一逻辑轮的所有 revision 必须相同。NULL 为本迁移前历史。';
COMMENT ON COLUMN experience.chat_history.status_rules_mode IS
  '开轮时裁决的状态栏规则模式；同一逻辑轮的所有 revision 必须相同。NULL 为本迁移前历史。';
COMMENT ON COLUMN experience.chat_history.memory_rules_mode IS
  '开轮时裁决的记忆栏规则模式；同一逻辑轮的所有 revision 必须相同。NULL 为本迁移前历史。';

-- current_chat_history 显式列出新增快照，避免下游按 current revision 读取时丢列。
DO $view$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(pg_catalog.quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_cols
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'experience.current_chat_history'::regclass
    AND attnum > 0 AND NOT attisdropped
    AND attname NOT IN ('choice_rules_mode', 'status_rules_mode', 'memory_rules_mode');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION '20261013 platform instruction slots: current_chat_history has no columns';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE VIEW experience.current_chat_history WITH (security_invoker = true) AS
     SELECT DISTINCT ON (session_id, turn_index) %s, choice_rules_mode, status_rules_mode, memory_rules_mode
     FROM experience.chat_history
     WHERE session_id IS NOT NULL AND turn_index IS NOT NULL AND revision IS NOT NULL
     ORDER BY session_id, turn_index, revision DESC',
    v_cols
  );
END
$view$;
REVOKE ALL ON experience.current_chat_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.current_chat_history TO service_role, postgres;

CREATE OR REPLACE FUNCTION app_core.apply_instruction_slot_preference_window()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.choice_full_rules_remaining := CASE WHEN NEW.pref_show_options THEN 2 ELSE 0 END;
    NEW.status_full_rules_remaining := CASE WHEN NEW.pref_show_status THEN 2 ELSE 0 END;
    NEW.memory_full_rules_remaining := CASE WHEN NEW.pref_show_memory THEN 2 ELSE 0 END;
    RETURN NEW;
  END IF;

  IF NEW.pref_show_options IS DISTINCT FROM OLD.pref_show_options THEN
    NEW.choice_full_rules_remaining := CASE WHEN NEW.pref_show_options THEN 2 ELSE 0 END;
  ELSIF NEW.choice_full_rules_remaining IS DISTINCT FROM OLD.choice_full_rules_remaining THEN
    IF NOT app_core.instruction_slot_claim_ok() THEN
      RAISE EXCEPTION 'choice_full_rules_remaining is only changed while claiming a turn or switching its preference'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.pref_show_status IS DISTINCT FROM OLD.pref_show_status THEN
    NEW.status_full_rules_remaining := CASE WHEN NEW.pref_show_status THEN 2 ELSE 0 END;
  ELSIF NEW.status_full_rules_remaining IS DISTINCT FROM OLD.status_full_rules_remaining THEN
    IF NOT app_core.instruction_slot_claim_ok() THEN
      RAISE EXCEPTION 'status_full_rules_remaining is only changed while claiming a turn or switching its preference'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.pref_show_memory IS DISTINCT FROM OLD.pref_show_memory THEN
    NEW.memory_full_rules_remaining := CASE WHEN NEW.pref_show_memory THEN 2 ELSE 0 END;
  ELSIF NEW.memory_full_rules_remaining IS DISTINCT FROM OLD.memory_full_rules_remaining THEN
    IF NOT app_core.instruction_slot_claim_ok() THEN
      RAISE EXCEPTION 'memory_full_rules_remaining is only changed while claiming a turn or switching its preference'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_core.instruction_slot_claim_enter()
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS instruction_slot_claim_guard (id integer PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO pg_temp.instruction_slot_claim_guard (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_core.instruction_slot_claim_ok()
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fn$
DECLARE v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(proc.proowner) INTO v_owner
  FROM pg_catalog.pg_proc AS proc
  WHERE proc.oid = 'app_core.instruction_slot_claim_enter()'::regprocedure;
  RETURN current_user IS NOT DISTINCT FROM v_owner
    AND to_regclass('pg_temp.instruction_slot_claim_guard') IS NOT NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_apply_instruction_slot_preference_window ON app_core.miniapp_user_settings;
CREATE TRIGGER trg_apply_instruction_slot_preference_window
  BEFORE INSERT OR UPDATE OF pref_show_options, pref_show_status, pref_show_memory,
    choice_full_rules_remaining, status_full_rules_remaining, memory_full_rules_remaining
  ON app_core.miniapp_user_settings
  FOR EACH ROW EXECUTE FUNCTION app_core.apply_instruction_slot_preference_window();

CREATE OR REPLACE FUNCTION app_core.update_instruction_slot_preferences(
  p_user_id uuid,
  p_pref_show_options boolean DEFAULT NULL,
  p_pref_show_status boolean DEFAULT NULL,
  p_pref_show_memory boolean DEFAULT NULL
) RETURNS TABLE (
  pref_show_options boolean,
  pref_show_status boolean,
  pref_show_memory boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  UPDATE app_core.miniapp_user_settings AS settings
  SET pref_show_options = COALESCE(p_pref_show_options, settings.pref_show_options),
      pref_show_status = COALESCE(p_pref_show_status, settings.pref_show_status),
      pref_show_memory = COALESCE(p_pref_show_memory, settings.pref_show_memory),
      updated_at = pg_catalog.now()
  WHERE settings.user_id = p_user_id
  RETURNING settings.pref_show_options, settings.pref_show_status, settings.pref_show_memory
    INTO pref_show_options, pref_show_status, pref_show_memory;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'miniapp user settings not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN NEXT;
END;
$fn$;

-- 内部领取函数持有用户设置行锁。只有新逻辑轮调用它；重生成绝不调用。
CREATE OR REPLACE FUNCTION app_core.claim_instruction_slot_modes(
  p_user_id uuid
) RETURNS TABLE (
  choice_rules_mode text,
  status_rules_mode text,
  memory_rules_mode text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_settings app_core.miniapp_user_settings%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_settings
  FROM app_core.miniapp_user_settings
  WHERE user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'miniapp user settings not found' USING ERRCODE = 'P0002';
  END IF;

  choice_rules_mode := CASE
    WHEN NOT v_settings.pref_show_options THEN 'off'
    WHEN v_settings.choice_full_rules_remaining > 0 THEN 'full'
    ELSE 'concise' END;
  status_rules_mode := CASE
    WHEN NOT v_settings.pref_show_status THEN 'off'
    WHEN v_settings.status_full_rules_remaining > 0 THEN 'full'
    ELSE 'concise' END;
  memory_rules_mode := CASE
    WHEN NOT v_settings.pref_show_memory THEN 'off'
    WHEN v_settings.memory_full_rules_remaining > 0 THEN 'full'
    ELSE 'concise' END;

  PERFORM app_core.instruction_slot_claim_enter();
  UPDATE app_core.miniapp_user_settings
  SET choice_full_rules_remaining = CASE WHEN choice_rules_mode = 'full' THEN choice_full_rules_remaining - 1 ELSE choice_full_rules_remaining END,
      status_full_rules_remaining = CASE WHEN status_rules_mode = 'full' THEN status_full_rules_remaining - 1 ELSE status_full_rules_remaining END,
      memory_full_rules_remaining = CASE WHEN memory_rules_mode = 'full' THEN memory_full_rules_remaining - 1 ELSE memory_full_rules_remaining END,
      updated_at = pg_catalog.now()
  WHERE user_id = p_user_id;
  RETURN NEXT;
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.instruction_slot_mode_bind_enter()
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS instruction_slot_mode_bind_guard (id integer PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO pg_temp.instruction_slot_mode_bind_guard (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.instruction_slot_mode_bind_ok()
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $fn$
DECLARE v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(proc.proowner) INTO v_owner
  FROM pg_catalog.pg_proc AS proc
  WHERE proc.oid = 'experience.instruction_slot_mode_bind_enter()'::regprocedure;
  RETURN current_user IS NOT DISTINCT FROM v_owner
    AND to_regclass('pg_temp.instruction_slot_mode_bind_guard') IS NOT NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.guard_chat_history_instruction_slot_modes()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW.choice_rules_mode IS NULL
     AND NEW.status_rules_mode IS NULL
     AND NEW.memory_rules_mode IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.choice_rules_mode IS NOT DISTINCT FROM OLD.choice_rules_mode
     AND NEW.status_rules_mode IS NOT DISTINCT FROM OLD.status_rules_mode
     AND NEW.memory_rules_mode IS NOT DISTINCT FROM OLD.memory_rules_mode THEN
    RETURN NEW;
  END IF;
  IF NOT experience.instruction_slot_mode_bind_ok() THEN
    RAISE EXCEPTION 'forbidden: instruction slot modes are only written by the current-postprocess start wrappers'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_chat_history_instruction_slot_modes ON experience.chat_history;
CREATE TRIGGER trg_guard_chat_history_instruction_slot_modes
  BEFORE INSERT OR UPDATE OF choice_rules_mode, status_rules_mode, memory_rules_mode
  ON experience.chat_history
  FOR EACH ROW EXECUTE FUNCTION experience.guard_chat_history_instruction_slot_modes();

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  p_session_id uuid, p_user_content text, p_model text,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_version integer; v_user_id uuid; v_started jsonb; v_modes record; v_history_id uuid;
BEGIN
  SELECT runtime.version INTO v_version
  FROM app_core.runtime_config AS runtime JOIN app_core.text_postprocess_versions AS snapshot
    ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config' AND runtime.version > 0
    AND pg_catalog.jsonb_typeof(runtime.value) = 'object'
    AND runtime.value -> 'version' = pg_catalog.to_jsonb(runtime.version)
    AND runtime.value -> 'schema_version' = '1'::jsonb AND runtime.value -> 'policy_version' = '1'::jsonb
    AND snapshot.schema_version = 1 AND snapshot.policy_version = 1
    AND pg_catalog.jsonb_typeof(snapshot.artifact) = 'object'
    AND snapshot.artifact -> 'schema_version' = '1'::jsonb AND snapshot.artifact -> 'policy_version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(snapshot.artifact -> 'rules') = 'array';
  IF NOT FOUND THEN RAISE EXCEPTION 'current text postprocess version is unavailable' USING ERRCODE = 'P0001'; END IF;
  SELECT user_id INTO v_user_id FROM experience.chat_sessions WHERE id = p_session_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found: %', p_session_id USING ERRCODE = 'P0002'; END IF;
  INSERT INTO app_core.miniapp_user_settings (user_id) VALUES (v_user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_modes FROM app_core.claim_instruction_slot_modes(v_user_id);
  v_started := experience.start_chat_history_turn_with_postprocess(p_session_id, p_user_content, p_model, v_version, p_stale_after_seconds, p_max_context_turns, p_retain_context_turns);
  v_history_id := (v_started ->> 'history_id')::uuid;
  IF v_history_id IS NULL THEN RAISE EXCEPTION 'started history row is missing history_id' USING ERRCODE = '55000'; END IF;
  PERFORM experience.instruction_slot_mode_bind_enter();
  UPDATE experience.chat_history SET choice_rules_mode = v_modes.choice_rules_mode, status_rules_mode = v_modes.status_rules_mode, memory_rules_mode = v_modes.memory_rules_mode WHERE id = v_history_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000'; END IF;
  RETURN v_started || pg_catalog.jsonb_build_object('choice_rules_mode', v_modes.choice_rules_mode, 'status_rules_mode', v_modes.status_rules_mode, 'memory_rules_mode', v_modes.memory_rules_mode);
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  p_session_id uuid, p_turn_index integer, p_model text,
  p_stale_after_seconds integer DEFAULT 120, p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE v_version integer; v_started jsonb; v_history_id uuid; v_modes record;
BEGIN
  SELECT runtime.version INTO v_version
  FROM app_core.runtime_config AS runtime JOIN app_core.text_postprocess_versions AS snapshot
    ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config' AND runtime.version > 0
    AND pg_catalog.jsonb_typeof(runtime.value) = 'object'
    AND runtime.value -> 'version' = pg_catalog.to_jsonb(runtime.version)
    AND runtime.value -> 'schema_version' = '1'::jsonb AND runtime.value -> 'policy_version' = '1'::jsonb
    AND snapshot.schema_version = 1 AND snapshot.policy_version = 1
    AND pg_catalog.jsonb_typeof(snapshot.artifact) = 'object'
    AND snapshot.artifact -> 'schema_version' = '1'::jsonb AND snapshot.artifact -> 'policy_version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(snapshot.artifact -> 'rules') = 'array';
  IF NOT FOUND THEN RAISE EXCEPTION 'current text postprocess version is unavailable' USING ERRCODE = 'P0001'; END IF;
  v_started := experience.start_chat_history_regeneration_with_postprocess(p_session_id, p_turn_index, p_model, v_version, p_stale_after_seconds, p_max_context_turns, p_retain_context_turns);
  v_history_id := (v_started ->> 'history_id')::uuid;
  IF v_history_id IS NULL THEN RAISE EXCEPTION 'started history row is missing history_id' USING ERRCODE = '55000'; END IF;
  SELECT choice_rules_mode, status_rules_mode, memory_rules_mode INTO v_modes
  FROM experience.chat_history
  WHERE session_id = p_session_id AND turn_index = (v_started ->> 'turn_index')::integer AND id <> v_history_id
  ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND OR v_modes.choice_rules_mode IS NULL OR v_modes.status_rules_mode IS NULL OR v_modes.memory_rules_mode IS NULL THEN
    RAISE EXCEPTION 'instruction slot modes are unavailable for this historical turn' USING ERRCODE = 'P0001';
  END IF;
  PERFORM experience.instruction_slot_mode_bind_enter();
  UPDATE experience.chat_history SET choice_rules_mode = v_modes.choice_rules_mode, status_rules_mode = v_modes.status_rules_mode, memory_rules_mode = v_modes.memory_rules_mode WHERE id = v_history_id;
  RETURN v_started || pg_catalog.jsonb_build_object('choice_rules_mode', v_modes.choice_rules_mode, 'status_rules_mode', v_modes.status_rules_mode, 'memory_rules_mode', v_modes.memory_rules_mode);
END;
$fn$;

ALTER FUNCTION app_core.update_instruction_slot_preferences(uuid, boolean, boolean, boolean) OWNER TO postgres;
ALTER FUNCTION app_core.claim_instruction_slot_modes(uuid) OWNER TO postgres;
ALTER FUNCTION app_core.instruction_slot_claim_enter() OWNER TO postgres;
ALTER FUNCTION app_core.instruction_slot_claim_ok() OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION app_core.update_instruction_slot_preferences(uuid, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_core.claim_instruction_slot_modes(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_core.instruction_slot_claim_enter() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_core.instruction_slot_claim_ok() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION experience.instruction_slot_mode_bind_enter() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION experience.instruction_slot_mode_bind_ok() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION experience.guard_chat_history_instruction_slot_modes() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_core.update_instruction_slot_preferences(uuid, boolean, boolean, boolean) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION app_core.claim_instruction_slot_modes(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(uuid, text, text, integer, integer, integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(uuid, integer, text, integer, integer, integer) TO service_role, postgres;

DO $selfcheck$
DECLARE v_signature text; v_owner name; v_definer boolean; v_config text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'app_core.miniapp_user_settings'::regclass
      AND conname IN ('miniapp_user_settings_choice_full_rules_remaining_check','miniapp_user_settings_status_full_rules_remaining_check','miniapp_user_settings_memory_full_rules_remaining_check')
      AND NOT convalidated
  ) THEN RAISE EXCEPTION '20261013 platform instruction slots self-check: settings check is not validated'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'experience.chat_history'::regclass
      AND conname IN ('chat_history_choice_rules_mode_check','chat_history_status_rules_mode_check','chat_history_memory_rules_mode_check')
      AND NOT convalidated
  ) THEN RAISE EXCEPTION '20261013 platform instruction slots self-check: history check is not validated'; END IF;
  FOREACH v_signature IN ARRAY ARRAY[
    'app_core.update_instruction_slot_preferences(uuid,boolean,boolean,boolean)',
    'app_core.claim_instruction_slot_modes(uuid)',
    'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
    'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)'
  ] LOOP
    SELECT pg_catalog.pg_get_userbyid(proc.proowner), proc.prosecdef, proc.proconfig INTO v_owner, v_definer, v_config FROM pg_catalog.pg_proc AS proc WHERE proc.oid = to_regprocedure(v_signature);
    IF v_owner IS DISTINCT FROM 'postgres' OR v_definer IS DISTINCT FROM true OR NOT COALESCE(v_config, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION '20261013 platform instruction slots self-check: unsafe function shape: %', v_signature;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege('service_role', 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '20261013 platform instruction slots self-check: unsafe turn RPC ACL';
  END IF;
END
$selfcheck$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- TEST preflight (read-only before apply):
--   verify both current-postprocess wrapper signatures/owners/search_path, settings/history columns,
--   current_chat_history, RLS and grants; execute this file once through Database Migration workflow.
-- TEST postflight: create an isolated test user/session and verify false→true => full/full/concise,
-- repeated true and another slot preserve its remaining count, regeneration copies modes, and two sessions
-- for one user allocate no more than two full modes. Re-check pg_proc owner/search_path/ACL and RLS/grants.
-- Production: repeat the same preflight/postflight only after separate release approval. Do not drop columns,
-- constraints, functions, or snapshots for rollback; deploy an older Backend as the application rollback and
-- use a reviewed forward-fix for a database defect.
