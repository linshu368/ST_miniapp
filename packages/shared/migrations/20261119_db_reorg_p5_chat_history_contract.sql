-- Domain: experience（对话轮次 chat_history）——数据库重组阶段 5a 收缩。
-- 计划见 .trellis/tasks/11-19-db-reorg-p5-chat-history/design.md「收缩」。前提：扩展、回填（含 _backfill_fast）与 5a 后端已上线，
--   pg_stat_statements 确认旧写入（jsonb drive_mode、收口写 upstream_status、写 history）停涨，current_chat_history 无人直读。
--
--   0. （单独事务，只有行锁）rich_reply_metadata 里残留的 drive_mode 键补进列并去掉键。
--   1. 主事务（lock_timeout 5s，按读者的加锁顺序先锁视图再锁表）：
--      - 守卫：会话轮次展示投影全覆盖（history 已无写入方，这个集合不会再变）；生成请求表与主表的首字预览一致；
--        近期无 jsonb drive_mode 键；list_chat_message_page 是已知原文；无 cron 读相关对象。
--      - 删 list_chat_message_page（返回 session_chat_display 行类型）与 4 个视图，重建 3 个：
--        chat_history_display / session_chat_display 不再输出 upstream_status、display_fallback，投影不再从 history 现场解析，
--        首字预览改读 chat_generation_requests；session_chat_history 直接建在主表上（不再经 current_chat_history，
--        也不再联两张供应商明细表），不输出 history、upstream_status、first_token_preview。current_chat_history 删除。
--        list_chat_message_page 同签名重建（输出少两列）。
--      - record_chat_delivery_preview 只写生成请求表；begin_chat_generation_observation 的投影写入去掉 projection_version；
--        删 backfill_chat_history_display、投影表 projection_version；删 chat_history.upstream_status、first_token_preview。
--      - 守卫：除改写对象外没有函数再引用这些名字。
--   history 列等 5b 清空后再删；extract_chat_history_display 保留（准入时从入参推导投影）。
-- 可重跑：已完成的步骤跳过。
--
-- Verify: bash scripts/test-db-reorg-p5-migration.sh
-- Release: TEST -> Production。
-- Recovery: 视图与函数可按 20261111_chat_history_display_reads.sql / 073_current_chat_history_view.sql 原文重建；删掉的两列无读者
--   （upstream_status 10-27 后恒空；首字预览在 chat_generation_requests 有完整副本）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
UPDATE experience.chat_history
SET drive_mode = COALESCE(drive_mode, rich_reply_metadata->>'drive_mode'),
    rich_reply_metadata = rich_reply_metadata - 'drive_mode'
WHERE rich_reply_metadata ? 'drive_mode';
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.p5_patch(p_fn regprocedure, p_old text[], p_new text[]) RETURNS boolean
LANGUAGE plpgsql AS $patch$
DECLARE
  v_def text := replace(pg_get_functiondef(p_fn), E'\r\n', E'\n');
  v_hits integer;
  v_applied boolean := true;
BEGIN
  FOR i IN 1 .. cardinality(p_old) LOOP
    v_hits := (length(v_def) - length(replace(v_def, p_old[i], ''))) / length(p_old[i]);
    IF v_hits <> 0 OR position(p_new[i] IN v_def) = 0 THEN v_applied := false; END IF;
  END LOOP;
  IF v_applied THEN RETURN false; END IF;
  FOR i IN 1 .. cardinality(p_old) LOOP
    v_hits := (length(v_def) - length(replace(v_def, p_old[i], ''))) / length(p_old[i]);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'p5 contract: % anchor % matched % times; review the current definition', p_fn, i, v_hits;
    END IF;
    v_def := replace(v_def, p_old[i], p_new[i]);
  END LOOP;
  EXECUTE v_def;
  RETURN true;
END
$patch$;

DO $guard_before_lock$
DECLARE
  v_missing bigint;
  v_list text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass
               AND attname = 'history' AND NOT attisdropped) THEN
    -- No writer has set history since expand, so this set is static; checked before taking exclusive locks.
    SELECT count(*) INTO v_missing FROM experience.chat_history h
    WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL AND h.history IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata m WHERE m.history_id = h.id);
    IF v_missing > 0 THEN
      RAISE EXCEPTION 'p5 contract: % session turns have no display projection; run the backfill first', v_missing;
    END IF;
  END IF;
  SELECT md5(replace(prosrc, E'\r', '')) INTO v_list FROM pg_proc
  WHERE oid = to_regprocedure('experience.list_chat_message_page(uuid,uuid,integer,integer)');
  -- Production body before this contract, or the body this contract creates (rerun).
  IF v_list IS NOT NULL AND v_list NOT IN ('d7a2b88dc6f371828911a610eef78094', '5c3ec32a77eaa83585d0422cad3e070b') THEN
    RAISE EXCEPTION 'p5 contract: list_chat_message_page differs from the reviewed body (md5 without CR %)', v_list;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$SELECT string_agg(jobid::text, ', ') FROM cron.job
      WHERE command ~ '(current_chat_history|session_chat_history|chat_history_display|session_chat_display|upstream_status|first_token_preview|display_fallback)'$q$
      INTO v_list;
    IF v_list IS NOT NULL THEN
      RAISE EXCEPTION 'p5 contract: pg_cron jobs % read an object or column this contract changes', v_list;
    END IF;
  END IF;
END
$guard_before_lock$;

-- Readers lock a view before its base tables; take the same order to avoid deadlocks.
DO $lock$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['experience.session_chat_display', 'experience.chat_history_display',
    'experience.session_chat_history', 'experience.current_chat_history', 'experience.chat_history',
    'experience.chat_history_display_metadata', 'experience.chat_generation_requests'] LOOP
    IF to_regclass(r) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', r);
    END IF;
  END LOOP;
END
$lock$;

DO $guard_locked$
DECLARE
  v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_history'::regclass
               AND attname = 'first_token_preview' AND NOT attisdropped) THEN
    EXECUTE 'SELECT count(*) FROM experience.chat_history h
             LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
             WHERE h.first_token_preview IS NOT NULL AND r.first_token_preview IS DISTINCT FROM h.first_token_preview'
      INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'p5 contract: % first-token previews are not in chat_generation_requests', v_n;
    END IF;
  END IF;
  SELECT count(*) INTO v_n FROM experience.chat_history
  WHERE created_at >= now() - interval '7 days' AND rich_reply_metadata ? 'drive_mode';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'p5 contract: % recent turns still carry drive_mode in rich_reply_metadata (old backend still running?)', v_n;
  END IF;
END
$guard_locked$;

DROP FUNCTION IF EXISTS experience.list_chat_message_page(uuid, uuid, integer, integer);
DROP VIEW IF EXISTS experience.session_chat_display;
DROP VIEW IF EXISTS experience.chat_history_display;
DROP VIEW IF EXISTS experience.session_chat_history;
DROP VIEW IF EXISTS experience.current_chat_history;

-- Display projection is authoritative (written at admission, backfilled for older turns); preview is delivery state.
CREATE VIEW experience.chat_history_display WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.character_id, h.status, h.deduction_rate,
    h.created_at, h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index, h.revision,
    h.postprocess_version, h.rich_reply_metadata, r.first_token_preview,
    m.request_id AS display_request_id, m.opening_message AS display_opening_message
   FROM experience.chat_history h
     LEFT JOIN experience.chat_history_display_metadata m ON m.history_id = h.id
     LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id;

CREATE VIEW experience.session_chat_display WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.model,
    CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
    CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    h.character_id, h.status, h.deduction_rate, h.created_at, h.llm_finish_reason, h.llm_charge_id,
    h.session_id, h.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata, h.first_token_preview,
    false AS is_inherited,
    (EXISTS (SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = h.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version,
    h.display_request_id, h.display_opening_message
   FROM experience.chat_history_display h
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = h.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = h.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
    AND NOT (EXISTS (SELECT 1 FROM experience.chat_history newer
                     WHERE newer.session_id = h.session_id AND newer.turn_index = h.turn_index AND newer.revision > h.revision))
UNION ALL
 SELECT h.id, s.user_id, h.model,
    CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
    CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    s.character_id, h.status, NULL::numeric AS deduction_rate, h.created_at, h.llm_finish_reason, NULL::uuid AS llm_charge_id,
    b.session_id, b.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata, NULL::jsonb AS first_token_preview,
    true AS is_inherited,
    (EXISTS (SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = b.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version,
    NULL::text AS display_request_id, h.display_opening_message
   FROM experience.chat_branch_turns b
     JOIN experience.chat_sessions s ON s.id = b.session_id
     JOIN experience.chat_history_display h ON h.id = b.source_history_id AND h.user_id = s.user_id AND h.character_id = s.character_id
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = b.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = b.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
  WHERE NOT (EXISTS (SELECT 1 FROM experience.chat_history own WHERE own.session_id = b.session_id AND own.turn_index = b.turn_index));

-- Current revision per turn straight from the base table (no history column, no provider detail tables).
CREATE VIEW experience.session_chat_history WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.model,
    CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
    CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    h.character_id, h.status, h.deduction_rate, h.created_at, h.llm_finish_reason, h.llm_charge_id,
    h.session_id, h.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
    false AS is_inherited,
    (EXISTS (SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = h.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version
   FROM (SELECT DISTINCT ON (c.session_id, c.turn_index) c.id, c.user_id, c.model, c.user_input, c.assistant_reply,
           c.character_id, c.status, c.deduction_rate, c.created_at, c.llm_finish_reason, c.llm_charge_id,
           c.session_id, c.turn_index, c.revision, c.postprocess_version, c.rich_reply_metadata
         FROM experience.chat_history c
         WHERE c.session_id IS NOT NULL AND c.turn_index IS NOT NULL AND c.revision IS NOT NULL
         ORDER BY c.session_id, c.turn_index, c.revision DESC) h
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = h.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = h.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
UNION ALL
 SELECT h.id, s.user_id, h.model,
    CASE WHEN u.deleted THEN ''::text ELSE COALESCE(u.content, h.user_input) END AS user_input,
    CASE WHEN a.deleted THEN NULL::text ELSE COALESCE(a.content, h.assistant_reply) END AS assistant_reply,
    s.character_id, h.status, NULL::numeric AS deduction_rate, h.created_at, h.llm_finish_reason, NULL::uuid AS llm_charge_id,
    inherited.session_id, inherited.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
    true AS is_inherited,
    (EXISTS (SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id = inherited.session_id AND l.message_id = h.id)) AS liked,
    COALESCE(u.deleted, false) AS user_deleted, COALESCE(a.deleted, false) AS assistant_deleted,
    COALESCE(u.version, 0) AS user_edit_version, COALESCE(a.version, 0) AS assistant_edit_version
   FROM experience.chat_branch_turns inherited
     JOIN experience.chat_sessions s ON s.id = inherited.session_id
     JOIN experience.chat_history h ON h.id = inherited.source_history_id AND h.user_id = s.user_id AND h.character_id = s.character_id
     LEFT JOIN experience.chat_message_overrides u ON u.session_id = inherited.session_id AND u.message_id = h.id AND u.role = 'user'::text
     LEFT JOIN experience.chat_message_overrides a ON a.session_id = inherited.session_id AND a.message_id = h.id AND a.role = 'assistant'::text
  WHERE NOT (EXISTS (SELECT 1 FROM experience.chat_history own
                     WHERE own.session_id = inherited.session_id AND own.turn_index = inherited.turn_index));

REVOKE ALL ON experience.chat_history_display, experience.session_chat_display, experience.session_chat_history
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON experience.chat_history_display, experience.session_chat_display, experience.session_chat_history TO service_role;

CREATE FUNCTION experience.list_chat_message_page(p_user_id uuid, p_session_id uuid,
  p_before_turn_index integer DEFAULT NULL::integer, p_turn_limit integer DEFAULT 25)
RETURNS SETOF experience.session_chat_display
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE owner_id uuid; character uuid;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_turn_limit IS NULL OR p_turn_limit<1 OR p_turn_limit>100
   OR (p_before_turn_index IS NOT NULL AND p_before_turn_index<0) THEN
   RAISE EXCEPTION 'invalid chat page arguments' USING ERRCODE='22023';
 END IF;
 SELECT user_id,character_id INTO owner_id,character FROM experience.chat_sessions
 WHERE id=p_session_id AND user_id=p_user_id AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'chat session not found' USING ERRCODE='P0002'; END IF;

 RETURN QUERY
 WITH own_turns AS MATERIALIZED (
   SELECT ch.turn_index FROM experience.chat_history ch
   WHERE ch.session_id=p_session_id AND ch.turn_index IS NOT NULL AND ch.revision IS NOT NULL
     AND ch.turn_index<=COALESCE(p_before_turn_index-1,2147483647)
   GROUP BY ch.turn_index ORDER BY ch.turn_index DESC LIMIT p_turn_limit+1
 ), own_keys AS (
   SELECT latest.id,t.turn_index,false AS inherited FROM own_turns t
   CROSS JOIN LATERAL (SELECT ch.id FROM experience.chat_history ch
     WHERE ch.session_id=p_session_id AND ch.turn_index=t.turn_index AND ch.revision IS NOT NULL
     ORDER BY ch.revision DESC LIMIT 1) latest
 ), branch_keys AS (
   SELECT b.source_history_id AS id,b.turn_index,true AS inherited FROM experience.chat_branch_turns b
   JOIN experience.chat_history source ON source.id=b.source_history_id
     AND source.user_id=owner_id AND source.character_id=character
   WHERE b.session_id=p_session_id AND b.turn_index<=COALESCE(p_before_turn_index-1,2147483647)
     AND NOT EXISTS(SELECT 1 FROM experience.chat_history own
       WHERE own.session_id=p_session_id AND own.turn_index=b.turn_index)
   ORDER BY b.turn_index DESC LIMIT p_turn_limit+1
 ), page_keys AS MATERIALIZED (
   SELECT * FROM (SELECT * FROM own_keys UNION ALL SELECT * FROM branch_keys) candidates
   ORDER BY turn_index DESC LIMIT p_turn_limit+1
 )
 SELECT h.id,CASE WHEN k.inherited THEN owner_id ELSE h.user_id END,h.model,
   CASE WHEN u.deleted THEN '' ELSE COALESCE(u.content,h.user_input) END,
   CASE WHEN a.deleted THEN NULL ELSE COALESCE(a.content,h.assistant_reply) END,
   CASE WHEN k.inherited THEN character ELSE h.character_id END,h.status,
   CASE WHEN k.inherited THEN NULL::numeric ELSE h.deduction_rate END,h.created_at,h.llm_finish_reason,
   CASE WHEN k.inherited THEN NULL::uuid ELSE h.llm_charge_id END,p_session_id,k.turn_index,h.revision,
   h.postprocess_version,h.rich_reply_metadata,CASE WHEN k.inherited THEN NULL::jsonb ELSE h.first_token_preview END,
   k.inherited,EXISTS(SELECT 1 FROM experience.chat_message_likes l WHERE l.session_id=p_session_id AND l.message_id=h.id),
   COALESCE(u.deleted,false),COALESCE(a.deleted,false),COALESCE(u.version,0),COALESCE(a.version,0),
   CASE WHEN k.inherited THEN NULL::text ELSE h.display_request_id END,h.display_opening_message
 FROM page_keys k JOIN experience.chat_history_display h ON h.id=k.id
 LEFT JOIN experience.chat_message_overrides u ON u.session_id=p_session_id AND u.message_id=h.id AND u.role='user'
 LEFT JOIN experience.chat_message_overrides a ON a.session_id=p_session_id AND a.message_id=h.id AND a.role='assistant'
 ORDER BY k.turn_index DESC;
END;
$fn$;
REVOKE ALL ON FUNCTION experience.list_chat_message_page(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.list_chat_message_page(uuid, uuid, integer, integer) TO service_role;

-- Preview lives only in the delivery-state table from here on.
SELECT pg_temp.p5_patch(
  'experience.record_chat_delivery_preview(uuid,integer,numeric,text,text)'::regprocedure,
  ARRAY[$o1$ UPDATE experience.chat_history SET first_token_preview=COALESCE(first_token_preview,jsonb_build_object('kind',p_kind,'text',p_text)) WHERE id=h.id;
$o1$,
        $o2$   first_token_preview=COALESCE(first_token_preview,h.first_token_preview,jsonb_build_object('kind',p_kind,'text',p_text))$o2$],
  ARRAY[$n1$ -- p5: the first-token preview is delivery state (chat_generation_requests only).
$n1$,
        $n2$   first_token_preview=COALESCE(first_token_preview,jsonb_build_object('kind',p_kind,'text',p_text))$n2$]);

-- The projection has no versions any more: every write is authoritative.
SELECT pg_temp.p5_patch(
  'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure,
  ARRAY[$o1$      INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message,projection_version)
      SELECT p_history_id,d.request_id,d.opening_message,1 FROM experience.extract_chat_history_display(v_history) d$o1$,
        $o2$        opening_message=excluded.opening_message,projection_version=1;$o2$],
  ARRAY[$n1$      INSERT INTO experience.chat_history_display_metadata(history_id,request_id,opening_message)
      SELECT p_history_id,d.request_id,d.opening_message FROM experience.extract_chat_history_display(v_history) d$n1$,
        $n2$        opening_message=excluded.opening_message;$n2$]);

DROP FUNCTION IF EXISTS experience.backfill_chat_history_display(uuid[]);
ALTER TABLE experience.chat_history_display_metadata
  DROP CONSTRAINT IF EXISTS chat_history_display_metadata_version_check,
  DROP COLUMN IF EXISTS projection_version;
COMMENT ON TABLE experience.chat_history_display_metadata IS
  '每轮的 request_id 与首轮开场白（E）。准入时由 begin_chat_generation_observation 从入参推导写入；history 迁出后是唯一来源。';
COMMENT ON FUNCTION experience.extract_chat_history_display(jsonb) IS
  '从准入入参的 messages 推导 request_id 与开场白（只用于写展示投影，不再读存量 history）。';

ALTER TABLE experience.chat_history DROP COLUMN IF EXISTS upstream_status, DROP COLUMN IF EXISTS first_token_preview;

DO $guard_after$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_temp') AND n.nspname !~ '^pg_temp'
    AND (p.prosrc ~ '\m(upstream_status|display_fallback|backfill_chat_history_display|projection_version|current_chat_history)\M'
      OR (p.prosrc ~ '\mfirst_token_preview\M'
          AND p.oid NOT IN ('experience.record_chat_delivery_preview(uuid,integer,numeric,text,text)'::regprocedure,
                            'experience.list_chat_message_page(uuid,uuid,integer,integer)'::regprocedure)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p5 contract: functions still reference removed chat_history objects: %', v_bad;
  END IF;
END
$guard_after$;

NOTIFY pgrst, 'reload schema';
COMMIT;
