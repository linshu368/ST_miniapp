-- domain: experience（会话长期记忆：版本与任务状态）+ app_core runtime policy / admin managed config metadata.
--
-- 会话长期记忆（前情档案）与正文字数水位：
--   1) experience.story_memories：每个会话的记忆版本，全部保留（分支要找覆盖范围早于锚点的旧版本）
--   2) experience.story_memory_jobs：每个会话一行压缩任务状态（压缩目标、租约、退避、连续失败数）
--   3) 窗口前移/请求压缩、领取、CAS 提交、收尾四个受限 RPC；写入只走这些 RPC
--
-- "先压缩、后截断"：窗口超过高水位时 Backend 先请求把将要移出的轮次压缩到 target_end，
-- 窗口暂不移动；记忆落地后的下一轮，窗口前移与新记忆同时生效（prompt 前缀只变一次，
-- 也没有空窗期）。超过硬上限时 Backend 才强制前移。
--   4) fork_chat_session 重写：按记忆覆盖范围继承原文并复制记忆，删除"最后 A 轮"旧版本
--   5) 删除按轮数的旧泄洪：开轮函数里的调用原位替换为原样返回起点，DROP 泄洪函数，删两个旧配置
--   6) story_memory_config / story_memory_prompt 两个运营 managed key
--
-- 窗口决策移到 Backend（按正文字数，正文切分只在 TS 里有）。开轮 wrapper 链上的
-- p_max_context_turns / p_retain_context_turns 参数保留但不再使用：它们穿过 3 层 × 2 个
-- 多次原位补丁过的函数，改签名需要整体重写 6 个函数。
--
-- 前置：20261029_conversation_branches.sql、20261102_chat_message_overrides.sql、
--       20261102_creator_review_prompt_config.sql 已执行。
-- 不准备回滚迁移；问题用 forward-fix。不要把 Backend 回退到依赖 SQL 泄洪的旧版本。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. 表 ───────────────────────────────────────────────────────────────────

CREATE TABLE experience.story_memories (
  session_id uuid NOT NULL REFERENCES experience.chat_sessions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  content text NOT NULL CHECK (btrim(content) <> '' AND length(content) <= 20000),
  covered_end_turn integer NOT NULL CHECK (covered_end_turn >= 0),
  prompt_version text CHECK (prompt_version IS NULL OR length(prompt_version) <= 100),
  model text CHECK (model IS NULL OR length(model) <= 200),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, version)
);
ALTER TABLE experience.story_memories OWNER TO postgres;
ALTER TABLE experience.story_memories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.story_memories FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON experience.story_memories TO service_role;
COMMENT ON TABLE experience.story_memories IS
  '会话长期记忆版本。content 带 (T编号) 标注，注入时去掉；同一会话 covered_end_turn 随 version 严格递增。只由 commit_story_memory_version / fork_chat_session 写入。';

CREATE TABLE experience.story_memory_jobs (
  session_id uuid PRIMARY KEY REFERENCES experience.chat_sessions(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'idle', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- 请求压缩到的轮次（含）；可以超前于窗口起点，记忆落地后窗口才追上
  target_end integer NOT NULL DEFAULT 0 CHECK (target_end >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) <= 100),
  lease_until timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 200),
  range_start integer,
  range_end integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX idx_story_memory_jobs_due
  ON experience.story_memory_jobs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_story_memory_jobs_lease
  ON experience.story_memory_jobs (lease_until) WHERE status = 'running';
ALTER TABLE experience.story_memory_jobs OWNER TO postgres;
ALTER TABLE experience.story_memory_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.story_memory_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON experience.story_memory_jobs TO service_role;
COMMENT ON TABLE experience.story_memory_jobs IS
  '每个会话一行压缩任务状态。压缩目标提高时置 pending；失败按 2·2^(n-1) 分钟退避，连续 5 次后 failed，目标再次提高时复活。';

-- ── 2. 窗口前移 / 请求压缩 ───────────────────────────────────────────────────

CREATE FUNCTION experience.advance_story_memory_window(
  p_session_id uuid, p_from_start integer, p_to_start integer, p_target_end integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '2s' SET statement_timeout = '5s'
AS $fn$
DECLARE
  v_updated integer;
BEGIN
  IF p_session_id IS NULL OR p_from_start IS NULL OR p_to_start IS NULL OR p_target_end IS NULL
     OR p_from_start < 1 OR p_to_start < p_from_start OR p_target_end < 0 THEN
    RAISE EXCEPTION 'invalid story memory window advance' USING ERRCODE = '22023';
  END IF;

  -- p_to_start = p_from_start only requests compression; the window stays put.
  IF p_to_start > p_from_start THEN
    -- CAS on the observed start: the window only moves forward, and a lost race
    -- simply means another request already advanced it.
    UPDATE experience.chat_sessions
    SET context_window_start_turn = p_to_start
    WHERE id = p_session_id AND deleted_at IS NULL AND context_window_start_turn = p_from_start;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN RETURN false; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM experience.chat_sessions WHERE id = p_session_id AND deleted_at IS NULL) THEN
    RETURN false;
  END IF;

  -- Only a higher target re-arms the job. Re-sending the same target while waiting
  -- must not reset the failure backoff, and a running job picks up a raised target
  -- when it finishes.
  INSERT INTO experience.story_memory_jobs (session_id, status, attempts, target_end, next_attempt_at)
  VALUES (p_session_id, 'pending', 0, p_target_end, now())
  ON CONFLICT (session_id) DO UPDATE SET
    status = CASE
      WHEN story_memory_jobs.status = 'running' THEN 'running'
      WHEN EXCLUDED.target_end > story_memory_jobs.target_end THEN 'pending'
      ELSE story_memory_jobs.status END,
    attempts = CASE
      WHEN story_memory_jobs.status <> 'running' AND EXCLUDED.target_end > story_memory_jobs.target_end
      THEN 0 ELSE story_memory_jobs.attempts END,
    next_attempt_at = CASE
      WHEN story_memory_jobs.status <> 'running' AND EXCLUDED.target_end > story_memory_jobs.target_end
      THEN now() ELSE story_memory_jobs.next_attempt_at END,
    target_end = GREATEST(story_memory_jobs.target_end, EXCLUDED.target_end),
    updated_at = now();
  RETURN true;
END;
$fn$;

-- ── 3. 领取 ─────────────────────────────────────────────────────────────────

CREATE FUNCTION experience.claim_story_memory_jobs(
  p_worker text, p_limit integer, p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '2s' SET statement_timeout = '5s'
AS $fn$
DECLARE
  v_ids uuid[];
  v_result jsonb := '[]'::jsonb;
  r record;
BEGIN
  IF p_worker IS NULL OR btrim(p_worker) = '' OR length(p_worker) > 100
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'invalid story memory claim' USING ERRCODE = '22023';
  END IF;

  -- Expired running leases are reclaimable: a crashed worker never strands a session.
  WITH due AS (
    SELECT j.session_id FROM experience.story_memory_jobs j
    WHERE (j.status = 'pending' AND j.next_attempt_at <= now())
       OR (j.status = 'running' AND j.lease_until < now())
    ORDER BY j.next_attempt_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE experience.story_memory_jobs j
    SET status = 'running', lease_owner = p_worker,
        lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    FROM due WHERE j.session_id = due.session_id
    RETURNING j.session_id
  )
  SELECT array_agg(session_id) INTO v_ids FROM claimed;

  IF v_ids IS NULL THEN RETURN v_result; END IF;

  FOR r IN
    SELECT j.session_id, j.attempts, j.target_end, s.user_id, s.character_id, s.context_window_start_turn,
           s.deleted_at, m.version AS memory_version, m.covered_end_turn, m.content
    FROM experience.story_memory_jobs j
    JOIN experience.chat_sessions s ON s.id = j.session_id
    LEFT JOIN LATERAL (
      SELECT version, covered_end_turn, content FROM experience.story_memories
      WHERE session_id = j.session_id ORDER BY version DESC LIMIT 1
    ) m ON true
    WHERE j.session_id = ANY (v_ids)
  LOOP
    IF r.deleted_at IS NOT NULL THEN
      UPDATE experience.story_memory_jobs
      SET status = 'idle', lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE session_id = r.session_id;
      CONTINUE;
    END IF;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'session_id', r.session_id,
      'user_id', r.user_id,
      'character_id', r.character_id,
      'window_start', r.context_window_start_turn,
      'target_end', r.target_end,
      'attempts', r.attempts,
      'memory_version', r.memory_version,
      'covered_end_turn', COALESCE(r.covered_end_turn, 0),
      'memory_content', r.content
    ));
  END LOOP;
  RETURN v_result;
END;
$fn$;

-- ── 4. 提交一个版本 ──────────────────────────────────────────────────────────

CREATE FUNCTION experience.commit_story_memory_version(
  p_session_id uuid, p_worker text, p_expected_covered_end integer, p_covered_end integer,
  p_content text, p_prompt_version text, p_model text,
  p_input_tokens integer, p_output_tokens integer, p_lease_seconds integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '2s' SET statement_timeout = '5s'
AS $fn$
DECLARE
  v_job experience.story_memory_jobs%ROWTYPE;
  v_version integer;
  v_covered integer;
BEGIN
  IF p_session_id IS NULL OR p_worker IS NULL OR p_expected_covered_end IS NULL
     OR p_covered_end IS NULL OR p_content IS NULL
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
    RAISE EXCEPTION 'invalid story memory commit' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM experience.story_memory_jobs WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'running' OR v_job.lease_owner IS DISTINCT FROM p_worker THEN
    RAISE EXCEPTION 'story memory lease lost' USING ERRCODE = 'P0409';
  END IF;

  SELECT version, covered_end_turn INTO v_version, v_covered
  FROM experience.story_memories WHERE session_id = p_session_id
  ORDER BY version DESC LIMIT 1;

  -- Coverage only grows and never passes the requested target, which Backend keeps
  -- outside the protected recent turns (so edited turns are never compressed).
  IF COALESCE(v_covered, 0) <> p_expected_covered_end THEN
    RAISE EXCEPTION 'story memory moved' USING ERRCODE = 'P0409';
  END IF;
  IF p_covered_end <= p_expected_covered_end OR p_covered_end > v_job.target_end THEN
    RAISE EXCEPTION 'story memory coverage out of range' USING ERRCODE = '22023';
  END IF;

  INSERT INTO experience.story_memories (
    session_id, version, content, covered_end_turn, prompt_version, model,
    input_tokens, output_tokens
  ) VALUES (
    p_session_id, COALESCE(v_version, 0) + 1, p_content, p_covered_end, p_prompt_version, p_model,
    p_input_tokens, p_output_tokens
  );

  UPDATE experience.story_memory_jobs
  SET lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  WHERE session_id = p_session_id;
  RETURN COALESCE(v_version, 0) + 1;
END;
$fn$;

-- ── 5. 收尾 ─────────────────────────────────────────────────────────────────

CREATE FUNCTION experience.finish_story_memory_job(
  p_session_id uuid, p_worker text, p_error_code text,
  p_range_start integer DEFAULT NULL, p_range_end integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '2s' SET statement_timeout = '5s'
AS $fn$
DECLARE
  v_job experience.story_memory_jobs%ROWTYPE;
  v_deleted boolean;
  v_covered integer;
  v_status text;
  v_attempts integer;
BEGIN
  IF p_session_id IS NULL OR p_worker IS NULL THEN
    RAISE EXCEPTION 'invalid story memory finish' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM experience.story_memory_jobs WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'running' OR v_job.lease_owner IS DISTINCT FROM p_worker THEN
    RETURN jsonb_build_object('status', 'lease_lost', 'attempts', COALESCE(v_job.attempts, 0));
  END IF;

  SELECT deleted_at IS NOT NULL INTO v_deleted
  FROM experience.chat_sessions WHERE id = p_session_id;
  SELECT covered_end_turn INTO v_covered FROM experience.story_memories
  WHERE session_id = p_session_id ORDER BY version DESC LIMIT 1;

  IF p_error_code IS NULL THEN
    v_attempts := 0;
    -- The target may have been raised while this job ran; keep going without waiting.
    v_status := CASE WHEN NOT v_deleted AND COALESCE(v_covered, 0) < v_job.target_end
      THEN 'pending' ELSE 'idle' END;
    UPDATE experience.story_memory_jobs
    SET status = v_status, attempts = 0, next_attempt_at = now(), last_error = NULL,
        lease_owner = NULL, lease_until = NULL,
        range_start = COALESCE(p_range_start, range_start), range_end = COALESCE(p_range_end, range_end),
        updated_at = now()
    WHERE session_id = p_session_id;
  ELSE
    v_attempts := v_job.attempts + 1;
    v_status := CASE WHEN v_deleted THEN 'idle' WHEN v_attempts >= 5 THEN 'failed' ELSE 'pending' END;
    UPDATE experience.story_memory_jobs
    SET status = v_status, attempts = v_attempts,
        next_attempt_at = now() + make_interval(mins => 2 * power(2, v_attempts - 1)::integer),
        last_error = left(p_error_code, 200), lease_owner = NULL, lease_until = NULL,
        range_start = COALESCE(p_range_start, range_start), range_end = COALESCE(p_range_end, range_end),
        updated_at = now()
    WHERE session_id = p_session_id;
  END IF;
  RETURN jsonb_build_object('status', v_status, 'attempts', v_attempts);
END;
$fn$;

DO $grants$
DECLARE v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'experience.advance_story_memory_window(uuid,integer,integer,integer)',
    'experience.claim_story_memory_jobs(text,integer,integer)',
    'experience.commit_story_memory_version(uuid,text,integer,integer,text,text,text,integer,integer,integer)',
    'experience.finish_story_memory_job(uuid,text,text,integer,integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres', v_sig);
  END LOOP;
END
$grants$;

-- ── 6. 分支重写 ──────────────────────────────────────────────────────────────

DROP FUNCTION experience.fork_chat_session(uuid, uuid, uuid, uuid, integer);

CREATE FUNCTION experience.fork_chat_session(
  p_user_id uuid, p_source_session_id uuid, p_message_id uuid, p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET statement_timeout = '5s'
AS $fn$
DECLARE
  v_source experience.chat_sessions%ROWTYPE;
  v_existing experience.chat_sessions%ROWTYPE;
  v_branch experience.chat_sessions%ROWTYPE;
  v_anchor record;
  v_memory record;
  v_from integer;
  v_count integer;
  v_memory_content text;
BEGIN
  IF p_user_id IS NULL OR p_source_session_id IS NULL OR p_message_id IS NULL
     OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid branch input' USING ERRCODE = '22023';
  END IF;

  -- Namespace-scoped user lock serializes creation rate/replay without reading
  -- another business domain. Source ownership below also rejects missing users.
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation-branch:' || p_user_id::text, 0));

  SELECT * INTO v_existing FROM experience.chat_sessions
  WHERE user_id = p_user_id AND branch_request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.branch_source_session_id IS DISTINCT FROM p_source_session_id
       OR v_existing.branch_source_message_id IS DISTINCT FROM p_message_id THEN
      RAISE EXCEPTION 'branch request identity conflict' USING ERRCODE = 'P0409';
    END IF;
    IF v_existing.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'branch no longer available' USING ERRCODE = 'P0422';
    END IF;
    RETURN to_jsonb(v_existing);
  END IF;

  SELECT * INTO v_source FROM experience.chat_sessions
  WHERE id = p_source_session_id AND user_id = p_user_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found' USING ERRCODE = 'P0002'; END IF;

  SELECT turn_index, assistant_reply INTO v_anchor FROM experience.session_chat_history
  WHERE session_id = p_source_session_id AND id = p_message_id
    AND status = 'success' AND btrim(COALESCE(assistant_reply, '')) <> '';
  IF NOT FOUND THEN RAISE EXCEPTION 'branch message is not a completed current reply' USING ERRCODE = 'P0422'; END IF;

  IF (SELECT count(*) FROM experience.chat_sessions
      WHERE user_id = p_user_id AND branch_request_id IS NOT NULL
        AND created_at >= now() - interval '1 minute') >= 10 THEN
    RAISE EXCEPTION 'branch creation rate exceeded' USING ERRCODE = 'P0429';
  END IF;

  INSERT INTO experience.chat_sessions (
    user_id, character_id, title, branch_source_session_id, branch_source_turn_index,
    branch_source_message_id, branch_inherited_turns, branch_request_id,
    message_count, last_message_at, last_message_preview
  ) VALUES (
    p_user_id, v_source.character_id,
    '分支 · ' || left(regexp_replace(COALESCE(NULLIF(btrim(v_source.title), ''), '新的对话'), '^分支 · ', ''), 55),
    p_source_session_id, v_anchor.turn_index, p_message_id, 1, p_request_id,
    0, now(), left(btrim(regexp_replace(v_anchor.assistant_reply, '\s+', ' ', 'g')), 120)
  ) RETURNING * INTO v_branch;

  -- Branches may anchor anywhere. Only a memory version that ends before the anchor
  -- is safe to inherit; everything after it up to the anchor is inherited as text.
  SELECT version, covered_end_turn, content, prompt_version, model INTO v_memory
  FROM experience.story_memories
  WHERE session_id = p_source_session_id AND covered_end_turn < v_anchor.turn_index
  ORDER BY version DESC LIMIT 1;
  v_from := CASE WHEN FOUND THEN v_memory.covered_end_turn + 1 ELSE 1 END;

  INSERT INTO experience.chat_branch_turns(session_id, turn_index, source_history_id)
  SELECT v_branch.id, row_number() OVER (ORDER BY picked.turn_index)::integer, picked.id
  FROM (
    SELECT id, turn_index FROM experience.session_chat_history
    WHERE session_id = p_source_session_id
      AND turn_index BETWEEN v_from AND v_anchor.turn_index
    ORDER BY turn_index DESC LIMIT 500
  ) AS picked;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count < 1 THEN RAISE EXCEPTION 'branch has no context' USING ERRCODE = 'P0422'; END IF;

  -- Freeze message overrides with the inherited history references.
  INSERT INTO experience.chat_message_overrides(session_id,message_id,role,content,deleted,version,updated_at)
  SELECT v_branch.id,o.message_id,o.role,o.content,o.deleted,o.version,o.updated_at
  FROM experience.chat_message_overrides o
  JOIN experience.chat_branch_turns b ON b.session_id=v_branch.id AND b.source_history_id=o.message_id
  WHERE o.session_id=p_source_session_id;

  -- Turn numbers restart at 1 in the branch, so source (T…) labels would be wrong.
  IF v_memory.version IS NOT NULL THEN
    v_memory_content := btrim(regexp_replace(
      v_memory.content, '[ \t]*[(（]T[0-9]+([ \t]*[-~–—,，、][ \t]*T?[0-9]+)*[)）]', '', 'g'));
    IF v_memory_content <> '' THEN
      INSERT INTO experience.story_memories (
        session_id, version, content, covered_end_turn, prompt_version, model
      ) VALUES (v_branch.id, 1, v_memory_content, 0, v_memory.prompt_version, v_memory.model);
    END IF;
  END IF;

  UPDATE experience.chat_sessions SET branch_inherited_turns = v_count,
    message_count = (SELECT sum((NOT user_deleted)::integer+(NOT assistant_deleted)::integer)
                     FROM experience.session_chat_history WHERE session_id=v_branch.id)
  WHERE id = v_branch.id RETURNING * INTO v_branch;
  RETURN to_jsonb(v_branch);
END;
$fn$;
ALTER FUNCTION experience.fork_chat_session(uuid,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION experience.fork_chat_session(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.fork_chat_session(uuid,uuid,uuid,uuid) TO service_role, postgres;

-- ── 7. 删除按轮数的旧泄洪 ─────────────────────────────────────────────────────

-- In-place patch keeps OID/owner/ACL and every upstream addition to these bodies.
-- Fail closed if the call cannot be located exactly once.
DO $drop_flood$
DECLARE
  v_sig text;
  v_src text;
  v_new text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'experience.start_chat_history_turn(uuid,text,text,integer,integer,integer)',
    'experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer)'
  ] LOOP
    SELECT pg_get_functiondef(v_sig::regprocedure) INTO v_src;
    IF (length(v_src) - length(replace(v_src, 'experience.apply_context_window_flood(', '')))
       / length('experience.apply_context_window_flood(') <> 1 THEN
      RAISE EXCEPTION 'story memory: unexpected flood call shape in %', v_sig;
    END IF;
    v_new := regexp_replace(
      v_src,
      'experience\.apply_context_window_flood\([^;]*\);',
      'GREATEST(COALESCE(v_session.context_window_start_turn, 1), 1);'
    );
    IF position('apply_context_window_flood' IN v_new) > 0 THEN
      RAISE EXCEPTION 'story memory: flood call not replaced in %', v_sig;
    END IF;
    EXECUTE v_new;
  END LOOP;
END
$drop_flood$;

DROP FUNCTION experience.apply_context_window_flood(uuid, integer, integer, integer, integer);

DELETE FROM app_core.runtime_config WHERE key IN ('max_context_turns', 'retain_context_turns');

COMMENT ON COLUMN experience.chat_sessions.context_window_start_turn IS
  '入模历史下界（含）。由 Backend 按正文字数双水位计算，经 advance_story_memory_window 只增不减地前移；通常在记忆已覆盖被移出轮次后才前移。';

-- ── 8. 运营 managed key ──────────────────────────────────────────────────────

DO $extend_functions$
DECLARE
  v_signature text;
  v_predecessor text;
  v_original_acl aclitem[];
  v_acl record;
  v_role text;
  v_new_functions text[] := ARRAY[]::text[];
BEGIN
  IF to_regprocedure('admin.is_managed_config_key_before_story_memory(text)') IS NULL THEN
    ALTER FUNCTION admin.is_managed_config_key(text) RENAME TO is_managed_config_key_before_story_memory;
    EXECUTE $ddl$CREATE FUNCTION admin.is_managed_config_key(p_config_key text)
    RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $body$
      SELECT p_config_key IN ('story_memory_config', 'story_memory_prompt')
        OR admin.is_managed_config_key_before_story_memory(p_config_key)
    $body$$ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.is_managed_config_key(text)');
  END IF;
  IF to_regprocedure('admin.validate_managed_config_value_before_story_memory(text,jsonb,text)') IS NULL THEN
    ALTER FUNCTION admin.validate_managed_config_value(text,jsonb,text)
      RENAME TO validate_managed_config_value_before_story_memory;
    EXECUTE $ddl$CREATE FUNCTION admin.validate_managed_config_value(
      p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL
    ) RETURNS void LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $body$
    DECLARE v_text text; v_length bigint;
    BEGIN
      -- Detailed field rules live in the shared zod schema; the database only
      -- guarantees the storage shape so a malformed release cannot be stored.
      IF p_config_key = 'story_memory_config' THEN
        IF p_text_value IS NOT NULL OR p_value IS NULL OR jsonb_typeof(p_value) <> 'object' THEN
          RAISE EXCEPTION 'story memory config requires a JSON object' USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      IF p_config_key = 'story_memory_prompt' THEN
        v_text := btrim(p_text_value, U&'\0009\000A\000B\000C\000D\0020\00A0\3000\FEFF');
        SELECT coalesce(sum(CASE WHEN ascii(glyph) > 65535 THEN 2 ELSE 1 END), 0)
          INTO v_length FROM regexp_split_to_table(v_text, '') AS glyph WHERE glyph <> '';
        IF p_value IS NOT NULL OR p_text_value IS NULL OR v_length = 0 OR v_length > 20000 THEN
          RAISE EXCEPTION 'story memory prompt requires text only, between 1 and 20000 characters'
            USING ERRCODE = '22023';
        END IF;
        RETURN;
      END IF;
      PERFORM admin.validate_managed_config_value_before_story_memory(p_config_key, p_value, p_text_value);
    END $body$$ddl$;
    v_new_functions := array_append(v_new_functions, 'admin.validate_managed_config_value(text,jsonb,text)');
  END IF;
  -- Copy effective EXECUTE privileges (custom roles and grant options included)
  -- from the renamed predecessors instead of inventing new ones.
  FOREACH v_signature IN ARRAY v_new_functions LOOP
    v_predecessor := CASE v_signature
      WHEN 'admin.is_managed_config_key(text)'
        THEN 'admin.is_managed_config_key_before_story_memory(text)'
      ELSE 'admin.validate_managed_config_value_before_story_memory(text,jsonb,text)'
    END;
    SELECT coalesce(p.proacl, acldefault('f', p.proowner)) INTO v_original_acl
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_predecessor);
    FOR v_acl IN
      SELECT DISTINCT acl.grantee
      FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE p.oid = to_regprocedure(v_signature)
    LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', v_signature, v_role);
    END LOOP;
    FOR v_acl IN SELECT * FROM aclexplode(v_original_acl) LOOP
      v_role := CASE WHEN v_acl.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(v_acl.grantee)) END;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', v_signature, v_role,
        CASE WHEN v_acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END
$extend_functions$;

DO $widen_checks$
DECLARE
  v_table regclass;
  v_name text;
  v_expression text;
  v_validated boolean;
  v_allowed boolean;
  v_key text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'admin.config_drafts'::regclass, 'admin.config_releases'::regclass
  ] LOOP
    v_name := CASE v_table
      WHEN 'admin.config_drafts'::regclass THEN 'config_drafts_config_key_check'
      ELSE 'config_releases_config_key_check'
    END;
    SELECT pg_get_expr(c.conbin, c.conrelid), c.convalidated
      INTO v_expression, v_validated
    FROM pg_constraint c
    WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
    IF v_expression IS NULL THEN
      RAISE EXCEPTION 'story memory: missing constraint %.%', v_table, v_name;
    END IF;
    FOREACH v_key IN ARRAY ARRAY['story_memory_config', 'story_memory_prompt'] LOOP
      EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
        INTO v_allowed USING v_key;
      IF v_allowed IS DISTINCT FROM true THEN
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_table, v_name);
        EXECUTE format(
          'ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR admin.is_managed_config_key(config_key))%s',
          v_table, v_name, v_expression,
          CASE WHEN v_validated THEN '' ELSE ' NOT VALID' END
        );
        SELECT pg_get_expr(c.conbin, c.conrelid) INTO v_expression
        FROM pg_constraint c
        WHERE c.conrelid = v_table AND c.conname = v_name AND c.contype = 'c';
      END IF;
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY['story_memory_config', 'story_memory_prompt'] LOOP
      EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
        INTO v_allowed USING v_key;
      IF v_allowed IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'story memory: key % rejected by %', v_key, v_table;
      END IF;
    END LOOP;
    EXECUTE format('SELECT (%s) FROM (SELECT $1::text AS config_key) AS candidate', v_expression)
      INTO v_allowed USING '__unknown_config_key__';
    IF v_allowed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'story memory: unknown key accepted by %', v_table;
    END IF;
  END LOOP;
END
$widen_checks$;

COMMIT;
NOTIFY pgrst, 'reload schema';
