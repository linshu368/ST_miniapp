-- 20260930_bind_current_text_postprocess_on_turn_start.sql
-- domain: experience（开轮时绑定展示版本）
-- 前置：
--   20260928_text_postprocess_versions.sql
--   20260928_chat_history_postprocess_version.sql
--   20260929_grant_text_postprocess_snapshot_read.sql
--   20260929_fix_text_postprocess_snapshot_fk_lock.sql
--
-- 业务不变量：新发送和重生成 revision 必须绑定
-- app_core.runtime_config.miniapp_text_postprocess_config 当前明确指向的合法、不可变快照。
-- 不使用 MAX(version)，不改变旧显式 wrapper 的 NULL=不绑定语义，不回填旧消息。
--
-- 权威写入方仍是既有 experience 开轮函数；本文件只新增两个 SECURITY DEFINER
-- 入口，在同一事务内解析 app_core 指针并委托旧显式版本 wrapper。
-- 无表重写、无业务行写入、无 backfill。应用发布顺序：本文件先于新 Backend。
-- 回退应用时可继续调用旧 wrapper；新函数保留。提交后的数据库修正使用 forward migration。

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
  IF to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('app_core.text_postprocess_versions') IS NULL
     OR to_regclass('experience.chat_history') IS NULL THEN
    RAISE EXCEPTION '20260930 current postprocess bind preflight: required relations missing';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'experience.start_chat_history_turn_with_postprocess(uuid,text,text,integer,integer,integer,integer)',
    'experience.start_chat_history_regeneration_with_postprocess(uuid,integer,text,integer,integer,integer,integer)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION '20260930 current postprocess bind preflight: required function missing: %',
        v_signature;
    END IF;
    SELECT pg_catalog.pg_get_userbyid(proc.proowner), proc.prosecdef, proc.proconfig
      INTO v_owner, v_definer, v_config
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = to_regprocedure(v_signature);
    IF v_owner IS DISTINCT FROM 'postgres'
       OR v_definer IS DISTINCT FROM true
       OR NOT COALESCE(v_config, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION '20260930 current postprocess bind preflight: unsafe function shape: %',
        v_signature;
    END IF;
    IF NOT pg_catalog.has_function_privilege('postgres', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION '20260930 current postprocess bind preflight: postgres cannot execute %',
        v_signature;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege('postgres', 'app_core.runtime_config', 'SELECT')
     OR NOT pg_catalog.has_table_privilege(
       'postgres', 'app_core.text_postprocess_versions', 'SELECT'
     ) THEN
    RAISE EXCEPTION '20260930 current postprocess bind preflight: postgres read grants missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  p_session_id uuid,
  p_user_content text,
  p_model text,
  p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_version integer;
BEGIN
  SELECT runtime.version
    INTO v_version
  FROM app_core.runtime_config AS runtime
  JOIN app_core.text_postprocess_versions AS snapshot
    ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config'
    AND runtime.version > 0
    AND pg_catalog.jsonb_typeof(runtime.value) = 'object'
    AND runtime.value -> 'version' = pg_catalog.to_jsonb(runtime.version)
    AND runtime.value -> 'schema_version' = '1'::jsonb
    AND runtime.value -> 'policy_version' = '1'::jsonb
    AND snapshot.schema_version = 1
    AND snapshot.policy_version = 1
    AND pg_catalog.jsonb_typeof(snapshot.artifact) = 'object'
    AND snapshot.artifact -> 'schema_version' = '1'::jsonb
    AND snapshot.artifact -> 'policy_version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(snapshot.artifact -> 'rules') = 'array';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'current text postprocess version is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN experience.start_chat_history_turn_with_postprocess(
    p_session_id,
    p_user_content,
    p_model,
    v_version,
    p_stale_after_seconds,
    p_max_context_turns,
    p_retain_context_turns
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  p_session_id uuid,
  p_turn_index integer,
  p_model text,
  p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_version integer;
BEGIN
  SELECT runtime.version
    INTO v_version
  FROM app_core.runtime_config AS runtime
  JOIN app_core.text_postprocess_versions AS snapshot
    ON snapshot.version = runtime.version
  WHERE runtime.key = 'miniapp_text_postprocess_config'
    AND runtime.version > 0
    AND pg_catalog.jsonb_typeof(runtime.value) = 'object'
    AND runtime.value -> 'version' = pg_catalog.to_jsonb(runtime.version)
    AND runtime.value -> 'schema_version' = '1'::jsonb
    AND runtime.value -> 'policy_version' = '1'::jsonb
    AND snapshot.schema_version = 1
    AND snapshot.policy_version = 1
    AND pg_catalog.jsonb_typeof(snapshot.artifact) = 'object'
    AND snapshot.artifact -> 'schema_version' = '1'::jsonb
    AND snapshot.artifact -> 'policy_version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(snapshot.artifact -> 'rules') = 'array';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'current text postprocess version is unavailable'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN experience.start_chat_history_regeneration_with_postprocess(
    p_session_id,
    p_turn_index,
    p_model,
    v_version,
    p_stale_after_seconds,
    p_max_context_turns,
    p_retain_context_turns
  );
END;
$fn$;

ALTER FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  uuid, text, text, integer, integer, integer
) OWNER TO postgres;
ALTER FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  uuid, integer, text, integer, integer, integer
) OWNER TO postgres;

REVOKE ALL ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  uuid, text, text, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  uuid, integer, text, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  uuid, text, text, integer, integer, integer
) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  uuid, integer, text, integer, integer, integer
) TO service_role, postgres;

COMMENT ON FUNCTION experience.start_chat_history_turn_with_current_postprocess(
  uuid, text, text, integer, integer, integer
) IS '事务内读取当前正式富文本版本并委托既有开轮 wrapper；成功必返回非空 postprocess_version。';
COMMENT ON FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(
  uuid, integer, text, integer, integer, integer
) IS '事务内读取当前正式富文本版本并委托既有重生成 wrapper；成功必返回非空 postprocess_version。';

DO $selfcheck$
DECLARE
  v_signature text;
  v_old_call text;
  v_owner name;
  v_definer boolean;
  v_config text[];
  v_source text;
BEGIN
  FOR v_signature, v_old_call IN
    SELECT * FROM (VALUES
      (
        'experience.start_chat_history_turn_with_current_postprocess(uuid,text,text,integer,integer,integer)',
        'experience.start_chat_history_turn_with_postprocess('
      ),
      (
        'experience.start_chat_history_regeneration_with_current_postprocess(uuid,integer,text,integer,integer,integer)',
        'experience.start_chat_history_regeneration_with_postprocess('
      )
    ) AS expected(signature, old_call)
  LOOP
    SELECT pg_catalog.pg_get_userbyid(proc.proowner), proc.prosecdef, proc.proconfig, proc.prosrc
      INTO v_owner, v_definer, v_config, v_source
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = to_regprocedure(v_signature);
    IF v_owner IS DISTINCT FROM 'postgres'
       OR v_definer IS DISTINCT FROM true
       OR NOT COALESCE(v_config, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog']
       OR pg_catalog.strpos(v_source, 'miniapp_text_postprocess_config') = 0
       OR pg_catalog.strpos(v_source, v_old_call) = 0
       OR pg_catalog.strpos(pg_catalog.lower(v_source), 'max(') > 0 THEN
      RAISE EXCEPTION '20260930 current postprocess bind self-check: unsafe function: %',
        v_signature;
    END IF;
    IF NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('postgres', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION '20260930 current postprocess bind self-check: unsafe ACL: %',
        v_signature;
    END IF;
  END LOOP;
END
$selfcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
