-- Domain: experience（对话轮次 chat_history）+ ops（prompt 观测）——数据库重组阶段 5a 扩展。
-- 计划见 .trellis/tasks/11-19-db-reorg-p5-chat-history/design.md。
--
-- 本文件只改目录与函数，不扫描、不改写存量行（回填在 20261119_db_reorg_p5_chat_history_backfill.sql）：
--   1. 新表 ops.chat_prompt_observations（O）：每轮 prompt 定稿时发给模型的 messages；history_id 软引用主表。
--   2. begin_chat_generation_observation：定稿 prompt 写 ops 表，不再写 chat_history.history；
--      "已存 request_id 不同"的比对改读展示投影（与原先 history 首条标记同值，同一函数写入）。
--   3. 两个开轮函数的 INSERT 去掉 history；history 去掉 NOT NULL；删除只为 history 写入服务的投影失效触发器
--      （之后没有写入方；留着会让 5b 的清空把投影标成失效）。
--   4. chat_generation_requests.first_token_preview（交付状态）；record_chat_delivery_preview 两边都写
--      （发布窗口里旧后端仍直接读主表列；收缩时只写新列、读路径切过去）。
--   5. chat_history.drive_mode 真列（原在 rich_reply_metadata，与三个指令槽档位列并列）。
--   6. 删两个没人用的索引：idx_chat_history_user（0 次扫描，与 idx_miniapp_cohort_chat_user_created 同列）、
--      idx_chat_history_model（1 次扫描）。
-- 改函数按原文定位替换，每处必须恰好命中一次，否则整体回滚；已改过的跳过，可重跑。
--
-- Verify: bash scripts/test-db-reorg-p5-migration.sh
-- Release: TEST -> Production -> 回填迁移 -> 后端发布 -> 收缩。
-- Recovery: 旧后端不依赖本文件的新对象；回退把三个函数按原文改回即可（history 列与存量数据都还在）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Patch helper (session-local): replace each anchor exactly once in the current definition and re-create it in place
-- (keeps OID, owner, ACL, SECURITY and search_path). Already patched (no old anchor, every new text present) => skip.
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
      RAISE EXCEPTION 'p5 expand: % anchor % matched % times; review the current definition', p_fn, i, v_hits;
    END IF;
    v_def := replace(v_def, p_old[i], p_new[i]);
  END LOOP;
  EXECUTE v_def;
  RETURN true;
END
$patch$;

-- 1. Prompt observations (O): written once per turn when the prompt is frozen; never read by product request paths.
CREATE TABLE IF NOT EXISTS ops.chat_prompt_observations (
  history_id uuid NOT NULL,
  messages_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_prompt_observations_pkey PRIMARY KEY (history_id),
  CONSTRAINT chat_prompt_observations_messages_snapshot_check CHECK (jsonb_typeof(messages_snapshot) = 'array')
);
CREATE INDEX IF NOT EXISTS chat_prompt_observations_created_at_idx ON ops.chat_prompt_observations (created_at);
ALTER TABLE ops.chat_prompt_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.chat_prompt_observations FROM PUBLIC, anon, authenticated, service_role;
-- begin_chat_generation_observation is SECURITY INVOKER and runs as service_role (upsert needs SELECT + UPDATE).
GRANT SELECT, INSERT, UPDATE ON ops.chat_prompt_observations TO service_role;
COMMENT ON TABLE ops.chat_prompt_observations IS
  '每个对话轮次 prompt 定稿时发给模型的 messages（O，写一次）。写入方 experience.begin_chat_generation_observation；产品请求路径不读；pg_cron 按保留期清理。';
COMMENT ON COLUMN ops.chat_prompt_observations.history_id IS 'soft ref → experience.chat_history.id（ops 不建 FK，按保留期删除）';
COMMENT ON COLUMN ops.chat_prompt_observations.messages_snapshot IS '发给模型的 messages 原样（首条带 request_id）';

-- 2. Frozen prompt goes to ops; the stored request marker is read from the display projection written by this function.
SELECT pg_temp.p5_patch(
  'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure,
  ARRAY[
$o1$  IF p_input ? 'history' AND h.history#>>'{0,request_id}' IS NOT NULL
     AND (h.history#>>'{0,request_id}')::uuid IS DISTINCT FROM v_request_id THEN$o1$,
$o2$      UPDATE experience.chat_history SET history=v_history,
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
$o2$],
  ARRAY[
$n1$  IF p_input ? 'history' AND EXISTS (
       SELECT 1 FROM experience.chat_history_display_metadata m
       WHERE m.history_id=p_history_id AND m.request_id IS NOT NULL
         AND m.request_id::uuid IS DISTINCT FROM v_request_id) THEN$n1$,
$n2$      UPDATE experience.chat_history SET
        llm_charge_id=COALESCE(v_charge_id,llm_charge_id),
        llm_billing_snapshot=CASE WHEN p_input ? 'snapshot' THEN p_input->'snapshot' ELSE llm_billing_snapshot END
      WHERE id=p_history_id;
      -- chat_prompt_observation_v1: the frozen prompt is an ops observation, never product state.
      IF p_input ? 'snapshot' THEN
        INSERT INTO ops.chat_prompt_observations(history_id,messages_snapshot) VALUES(p_history_id,v_history)
        ON CONFLICT(history_id) DO UPDATE SET messages_snapshot=excluded.messages_snapshot;
      END IF;
$n2$]);

-- 3. New turns no longer carry a history value.
ALTER TABLE experience.chat_history ALTER COLUMN history DROP NOT NULL;
COMMENT ON COLUMN experience.chat_history.history IS
  '阶段 5 起不再写入（prompt 定稿进 ops.chat_prompt_observations）；5b 按批清空后收缩删除。';
SELECT pg_temp.p5_patch(
  'experience.start_chat_history_turn(uuid,text,text,integer,integer,integer)'::regprocedure,
  ARRAY['    user_id, model, user_input, assistant_reply, history, character_id,',
        $o$    v_session.user_id, p_model, p_user_content, NULL, '[]'::jsonb, v_session.character_id,$o$],
  ARRAY['    user_id, model, user_input, assistant_reply, character_id,',
        '    v_session.user_id, p_model, p_user_content, NULL, v_session.character_id,']);
SELECT pg_temp.p5_patch(
  'experience.start_chat_history_regeneration(uuid,integer,text,integer,integer,integer)'::regprocedure,
  ARRAY['    user_id, model, user_input, assistant_reply, history, character_id,',
        $o$    v_session.user_id, p_model, v_user_content, NULL, '[]'::jsonb, v_session.character_id,$o$],
  ARRAY['    user_id, model, user_input, assistant_reply, character_id,',
        '    v_session.user_id, p_model, v_user_content, NULL, v_session.character_id,']);
DROP TRIGGER IF EXISTS trg_invalidate_chat_history_display ON experience.chat_history;
DROP FUNCTION IF EXISTS experience.invalidate_chat_history_display();

-- 4. First-token preview is delivery state; write both locations until contract.
ALTER TABLE experience.chat_generation_requests ADD COLUMN IF NOT EXISTS first_token_preview jsonb;
DO $preview_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'experience.chat_generation_requests'::regclass
                   AND conname = 'chat_generation_requests_first_token_preview_check') THEN
    -- Validated after the backfill (SHARE UPDATE EXCLUSIVE; does not block writes).
    ALTER TABLE experience.chat_generation_requests ADD CONSTRAINT chat_generation_requests_first_token_preview_check
      CHECK (first_token_preview IS NULL OR (jsonb_typeof(first_token_preview) = 'object'
        AND first_token_preview->>'kind' IN ('delta', 'reasoning')
        AND jsonb_typeof(first_token_preview->'text') = 'string')) NOT VALID;
  END IF;
END
$preview_check$;
COMMENT ON COLUMN experience.chat_generation_requests.first_token_preview IS
  '交付恢复用的首字预览 {kind: delta|reasoning, text}；首个检查点写入后不再改。消息映射在回复为空时显示它。';
-- h is the row read before chat_history is updated, so a row whose old column was set before this migration keeps
-- the same first preview in both places.
SELECT pg_temp.p5_patch(
  'experience.record_chat_delivery_preview(uuid,integer,numeric,text,text)'::regprocedure,
  ARRAY[' UPDATE experience.chat_generation_requests SET server_first_token_ready_ms=COALESCE(server_first_token_ready_ms,p_ready_ms) WHERE chat_history_id=h.id;'],
  ARRAY[$n$ UPDATE experience.chat_generation_requests SET server_first_token_ready_ms=COALESCE(server_first_token_ready_ms,p_ready_ms),
   first_token_preview=COALESCE(first_token_preview,h.first_token_preview,jsonb_build_object('kind',p_kind,'text',p_text))
 WHERE chat_history_id=h.id;$n$]);

-- 5. drive_mode as a real column (same domain as app_core.user_preferences.pref_drive_mode).
ALTER TABLE experience.chat_history ADD COLUMN IF NOT EXISTS drive_mode text;
DO $drive_check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'experience.chat_history'::regclass
                   AND conname = 'chat_history_drive_mode_check') THEN
    ALTER TABLE experience.chat_history ADD CONSTRAINT chat_history_drive_mode_check
      CHECK (drive_mode IS NULL OR drive_mode ~ '^[a-z][a-z0-9-]{0,31}$') NOT VALID;
  END IF;
END
$drive_check$;
COMMENT ON COLUMN experience.chat_history.drive_mode IS
  '这一轮组 prompt 时用的剧情推进档位 id（drive_mode_options 的档位；NULL = 未注入）。写入方 ConversationHistoryRepository.saveRichReplyMetadata。';

-- 6. Unused indexes (pg_stat_user_indexes 2026-11-19: 0 and 1 scans since the statistics reset).
DROP INDEX IF EXISTS experience.idx_chat_history_user;
DROP INDEX IF EXISTS experience.idx_chat_history_model;

NOTIFY pgrst, 'reload schema';
COMMIT;
