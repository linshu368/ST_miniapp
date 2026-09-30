-- 20260928_chat_history_postprocess_version.sql
-- domain: experience（消息引用）
-- 依赖：20260928_text_postprocess_versions.sql 已在同一环境提交。
--
-- 归属：
--   experience.chat_history.postprocess_version
--     真相：这一条 revision 开轮时绑定的已发布规则版本。NULL 表示沿用原 Markdown。
--     不变量：可空；非空则必须指向 app_core.text_postprocess_versions。旧行不回填。
--     权威写入方：本文件的两个 wrapper。它们调用既有
--     experience.start_chat_history_turn / start_chat_history_regeneration，
--     不复制会话锁、陈旧流或水位线。旧 RPC 保持原签名和原正文。
--     生命周期：随消息保留。快照被引用时 ON DELETE RESTRICT，不能删掉仍被历史指向的版本。
--     消费者：Backend 开轮与历史读取。current_chat_history 追加这一列，供当前 revision 读到。
--
-- 跨 schema：experience.chat_history.postprocess_version
--   → app_core.text_postprocess_versions(version) ON DELETE RESTRICT。
--   这是已批准的历史引用，不是把规则 JSON 复制进大表。
--
-- 容量：可空列不加默认回填，避免重写 chat_history。
--   ADD COLUMN 与 NOT VALID 约束使用 lock_timeout 5s。
--   VALIDATE 单独成事务，statement_timeout 15min；它拿 SHARE UPDATE EXCLUSIVE，不挡普通读写。
--   不为该 FK 建反向索引：版本行禁止删除，热路径也不按版本扫消息。
--   视图按当时的列清单追加 postprocess_version，不用 SELECT *，
--   因此不会把视图创建之后才加到基表、但尚未进入视图的列一起带出来。
--
-- 失败：停在当前事务。列已加上而 VALIDATE 未完成时，可以重跑本文件；不要先执行下游发布。
-- 回滚：有新消费者或已写入的非空引用时不 DROP。物理回退需单独审查。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('app_core.text_postprocess_versions') IS NULL THEN
    RAISE EXCEPTION '20260928_chat_history_postprocess_version preflight: versions table missing';
  END IF;
  IF to_regclass('experience.chat_history') IS NULL
     OR to_regclass('experience.current_chat_history') IS NULL THEN
    RAISE EXCEPTION '20260928_chat_history_postprocess_version preflight: chat history objects missing';
  END IF;
  IF to_regprocedure('experience.start_chat_history_turn(uuid,text,text,integer,integer,integer)') IS NULL
     OR to_regprocedure('experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer)') IS NULL THEN
    RAISE EXCEPTION '20260928_chat_history_postprocess_version preflight: start RPC signature mismatch';
  END IF;
END
$preflight$;

ALTER TABLE experience.chat_history
  ADD COLUMN IF NOT EXISTS postprocess_version integer;

COMMENT ON COLUMN experience.chat_history.postprocess_version IS
  '开轮时绑定的 text_postprocess_versions.version。NULL 表示该 revision 不套用后处理。';

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'experience.chat_history'::regclass
      AND conname = 'chat_history_postprocess_version_check'
  ) THEN
    ALTER TABLE experience.chat_history
      ADD CONSTRAINT chat_history_postprocess_version_check
      CHECK (postprocess_version IS NULL OR postprocess_version > 0)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'experience.chat_history'::regclass
      AND conname = 'chat_history_postprocess_version_fkey'
  ) THEN
    ALTER TABLE experience.chat_history
      ADD CONSTRAINT chat_history_postprocess_version_fkey
      FOREIGN KEY (postprocess_version)
      REFERENCES app_core.text_postprocess_versions (version)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$constraints$;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '900s';

ALTER TABLE experience.chat_history
  VALIDATE CONSTRAINT chat_history_postprocess_version_check;
ALTER TABLE experience.chat_history
  VALIDATE CONSTRAINT chat_history_postprocess_version_fkey;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $view$
DECLARE
  v_cols text;
  v_has boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'experience.current_chat_history'::regclass
      AND attname = 'postprocess_version'
      AND attnum > 0
      AND NOT attisdropped
  ) INTO v_has;
  IF v_has THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'experience.current_chat_history'::regclass
      AND attname = 'session_id' AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'experience.current_chat_history'::regclass
      AND attname = 'turn_index' AND attnum > 0 AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'experience.current_chat_history'::regclass
      AND attname = 'revision' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'current_chat_history is missing session_id, turn_index, or revision';
  END IF;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'experience.current_chat_history'::regclass
    AND attnum > 0
    AND NOT attisdropped;

  EXECUTE format(
    $sql$
      CREATE OR REPLACE VIEW experience.current_chat_history
      WITH (security_invoker = true) AS
      SELECT DISTINCT ON (session_id, turn_index)
        %s,
        postprocess_version
      FROM experience.chat_history
      WHERE session_id IS NOT NULL
        AND turn_index IS NOT NULL
        AND revision IS NOT NULL
      ORDER BY session_id, turn_index, revision DESC
    $sql$,
    v_cols
  );
END
$view$;

REVOKE ALL ON experience.current_chat_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.current_chat_history TO service_role, postgres;

COMMENT ON VIEW experience.current_chat_history IS
  '自研会话每个 turn 的当前版本（max revision）。postprocess_version 只在该视图创建后追加，不重扩历史 SELECT *。';

CREATE OR REPLACE FUNCTION experience.text_postprocess_bind_enter()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS text_postprocess_bind_guard (
    id integer PRIMARY KEY
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.text_postprocess_bind_guard (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.text_postprocess_bind_ok()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner)
    INTO v_owner
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'experience.text_postprocess_bind_enter()'::regprocedure;
  RETURN current_user IS NOT DISTINCT FROM v_owner
    AND to_regclass('pg_temp.text_postprocess_bind_guard') IS NOT NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.guard_chat_history_postprocess_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.postprocess_version IS NOT DISTINCT FROM OLD.postprocess_version THEN
    RETURN NEW;
  END IF;
  -- 旧 RPC 仍要能插入 NULL；但已经绑定的版本不能被普通 UPDATE 清空。
  IF TG_OP = 'INSERT' AND NEW.postprocess_version IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT experience.text_postprocess_bind_ok() THEN
    RAISE EXCEPTION 'forbidden: postprocess_version is only written by the start wrapper'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_guard_chat_history_postprocess_version ON experience.chat_history;
CREATE TRIGGER trg_guard_chat_history_postprocess_version
  BEFORE INSERT OR UPDATE OF postprocess_version ON experience.chat_history
  FOR EACH ROW
  EXECUTE FUNCTION experience.guard_chat_history_postprocess_version();

CREATE OR REPLACE FUNCTION experience.start_chat_history_turn_with_postprocess(
  p_session_id uuid,
  p_user_content text,
  p_model text,
  p_postprocess_version integer,
  p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_started jsonb;
  v_history_id uuid;
BEGIN
  -- 先拒绝不存在的版本，避免占用会话锁后再回滚。
  -- 真正的防半写仍是本函数与内层开轮函数处于同一事务。
  IF p_postprocess_version IS NOT NULL AND (
    p_postprocess_version <= 0
    OR NOT EXISTS (
      SELECT 1
      FROM app_core.text_postprocess_versions AS snapshot
      WHERE snapshot.version = p_postprocess_version
    )
  ) THEN
    RAISE EXCEPTION 'postprocess version % is not published', p_postprocess_version
      USING ERRCODE = 'P0002';
  END IF;

  v_started := experience.start_chat_history_turn(
    p_session_id,
    p_user_content,
    p_model,
    p_stale_after_seconds,
    p_max_context_turns,
    p_retain_context_turns
  );
  v_history_id := (v_started ->> 'history_id')::uuid;
  IF v_history_id IS NULL THEN
    RAISE EXCEPTION 'started history row is missing history_id' USING ERRCODE = '55000';
  END IF;

  PERFORM experience.text_postprocess_bind_enter();
  UPDATE experience.chat_history
  SET postprocess_version = p_postprocess_version
  WHERE id = v_history_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000';
  END IF;

  RETURN v_started || jsonb_build_object('postprocess_version', p_postprocess_version);
END;
$fn$;

CREATE OR REPLACE FUNCTION experience.start_chat_history_regeneration_with_postprocess(
  p_session_id uuid,
  p_turn_index integer,
  p_model text,
  p_postprocess_version integer,
  p_stale_after_seconds integer DEFAULT 120,
  p_max_context_turns integer DEFAULT 75,
  p_retain_context_turns integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_started jsonb;
  v_history_id uuid;
BEGIN
  IF p_postprocess_version IS NOT NULL AND (
    p_postprocess_version <= 0
    OR NOT EXISTS (
      SELECT 1
      FROM app_core.text_postprocess_versions AS snapshot
      WHERE snapshot.version = p_postprocess_version
    )
  ) THEN
    RAISE EXCEPTION 'postprocess version % is not published', p_postprocess_version
      USING ERRCODE = 'P0002';
  END IF;

  v_started := experience.start_chat_history_regeneration(
    p_session_id,
    p_turn_index,
    p_model,
    p_stale_after_seconds,
    p_max_context_turns,
    p_retain_context_turns
  );
  v_history_id := (v_started ->> 'history_id')::uuid;
  IF v_history_id IS NULL THEN
    RAISE EXCEPTION 'started history row is missing history_id' USING ERRCODE = '55000';
  END IF;

  PERFORM experience.text_postprocess_bind_enter();
  UPDATE experience.chat_history
  SET postprocess_version = p_postprocess_version
  WHERE id = v_history_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000';
  END IF;

  RETURN v_started || jsonb_build_object('postprocess_version', p_postprocess_version);
END;
$fn$;

REVOKE ALL ON FUNCTION experience.text_postprocess_bind_enter() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION experience.text_postprocess_bind_ok() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION experience.text_postprocess_bind_ok() TO anon, authenticated, service_role, postgres;
REVOKE ALL ON FUNCTION experience.guard_chat_history_postprocess_version() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION experience.start_chat_history_turn_with_postprocess(uuid, text, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION experience.start_chat_history_regeneration_with_postprocess(uuid, integer, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_turn_with_postprocess(uuid, text, text, integer, integer, integer, integer) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION experience.start_chat_history_regeneration_with_postprocess(uuid, integer, text, integer, integer, integer, integer) TO service_role, postgres;

COMMENT ON FUNCTION experience.start_chat_history_turn_with_postprocess(uuid, text, text, integer, integer, integer, integer) IS
  '调用既有 start_chat_history_turn 后，给同一行写入 postprocess_version。NULL 保持原展示。';
COMMENT ON FUNCTION experience.start_chat_history_regeneration_with_postprocess(uuid, integer, text, integer, integer, integer, integer) IS
  '调用既有 start_chat_history_regeneration 后，给新 revision 写入当次 postprocess_version。';

DO $selfcheck$
DECLARE
  v_src text;
  v_validated boolean;
  v_sig text;
BEGIN
  SELECT c.convalidated
    INTO v_validated
  FROM pg_constraint AS c
  WHERE c.conrelid = 'experience.chat_history'::regclass
    AND c.conname = 'chat_history_postprocess_version_fkey';
  IF v_validated IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'self-check failed: postprocess_version foreign key is not validated';
  END IF;

  IF to_regclass('experience.idx_chat_history_postprocess_version') IS NOT NULL THEN
    RAISE EXCEPTION 'self-check failed: unexpected postprocess_version reverse index';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'experience.current_chat_history'::regclass
      AND attname = 'postprocess_version'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'self-check failed: current_chat_history lacks postprocess_version';
  END IF;

  SELECT p.prosrc INTO v_src
  FROM pg_proc AS p
  WHERE p.oid = 'experience.start_chat_history_turn(uuid,text,text,integer,integer,integer)'::regprocedure;
  IF position('postprocess_version' IN v_src) > 0 THEN
    RAISE EXCEPTION 'self-check failed: start_chat_history_turn was rewritten';
  END IF;

  SELECT p.prosrc INTO v_src
  FROM pg_proc AS p
  WHERE p.oid = 'experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer)'::regprocedure;
  IF position('postprocess_version' IN v_src) > 0 THEN
    RAISE EXCEPTION 'self-check failed: start_chat_history_regeneration was rewritten';
  END IF;

  SELECT p.prosrc INTO v_src
  FROM pg_proc AS p
  WHERE p.oid = 'experience.start_chat_history_turn_with_postprocess(uuid,text,text,integer,integer,integer,integer)'::regprocedure;
  IF position('experience.start_chat_history_turn(' IN v_src) = 0 THEN
    RAISE EXCEPTION 'self-check failed: turn wrapper does not delegate';
  END IF;

  SELECT p.prosrc INTO v_src
  FROM pg_proc AS p
  WHERE p.oid = 'experience.start_chat_history_regeneration_with_postprocess(uuid,integer,text,integer,integer,integer,integer)'::regprocedure;
  IF position('experience.start_chat_history_regeneration(' IN v_src) = 0 THEN
    RAISE EXCEPTION 'self-check failed: regeneration wrapper does not delegate';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY[
    'experience.start_chat_history_turn_with_postprocess(uuid,text,text,integer,integer,integer,integer)',
    'experience.start_chat_history_regeneration_with_postprocess(uuid,integer,text,integer,integer,integer,integer)'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check failed: anon can execute %', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       AND has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check failed: authenticated can execute %', v_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND NOT has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check failed: service_role cannot execute %', v_sig;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND has_function_privilege(
       'service_role',
       'experience.text_postprocess_bind_enter()'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'self-check failed: service_role can enter the bind guard directly';
  END IF;
END
$selfcheck$;

COMMIT;

NOTIFY pgrst, 'reload schema';
