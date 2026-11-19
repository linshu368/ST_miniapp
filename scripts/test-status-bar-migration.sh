#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_status_bar_v2.sql：当前路径上最近一条记录、重新生成后旧版本失效、
# 同一锚点替换与撤销恢复、分支继承父会话记录（不可撤销）、越权写入拒绝、玩家覆盖版大小限制，以及权限。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-status-bar-${RANDOM}-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

# 前置对象：只建本迁移用到的列；两个视图照抄线上定义的形状。
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE SCHEMA experience;
CREATE TABLE app_core.users(id uuid PRIMARY KEY);
CREATE TABLE app_core.characters(
  id uuid PRIMARY KEY, name text DEFAULT '', description text DEFAULT '', first_mes text DEFAULT '',
  system_prompt text DEFAULT '', tags jsonb DEFAULT '[]', character_persona_and_style text,
  updated_at timestamptz DEFAULT now());
CREATE TABLE app_core.character_creations(character_id uuid PRIMARY KEY, owner_user_id uuid, draft jsonb, draft_runtime jsonb, submission jsonb);
-- 四个创作者函数的替身：只保留本迁移要替换的那一段原文，其余逻辑省略。
CREATE FUNCTION app_core.mutate_creator_character(p_user_id uuid, p_character_id uuid, p_action text, p_expected_revision integer, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r app_core.character_creations;
BEGIN
 SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id;
 UPDATE app_core.characters SET name=r.draft_runtime->>'name',description=r.draft_runtime->>'description',
   first_mes=r.draft_runtime->>'first_mes',system_prompt=r.draft_runtime->>'system_prompt',tags=r.draft->'tags',
   updated_at=now() WHERE id=p_character_id;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION app_core.review_creator_character(p_admin_user_id uuid, p_character_id uuid, p_submitted_revision integer, p_decision text, p_reason text, p_environment text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r app_core.character_creations; runtime jsonb;
BEGIN
 SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id;
 runtime:=r.submission->'runtime';
 UPDATE app_core.characters SET name=runtime->>'name',description=runtime->>'description',first_mes=runtime->>'first_mes',
   system_prompt=runtime->>'system_prompt',tags=r.submission->'draft'->'tags',updated_at=now()
 WHERE id=p_character_id;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION app_core.read_character_runtime(p_character_id uuid, p_user_id uuid, p_opening_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c app_core.characters; cr app_core.character_creations; result jsonb;
BEGIN
 SELECT * INTO c FROM app_core.characters WHERE id=p_character_id;
 SELECT * INTO cr FROM app_core.character_creations WHERE character_id=p_character_id;
 result:=jsonb_build_object('id',c.id,'name',c.name,'description',c.description,'system_prompt',c.system_prompt,
   'character_persona_and_style',c.character_persona_and_style);
 IF cr.owner_user_id=p_user_id THEN result:=result||cr.draft_runtime; END IF;
 RETURN result;
END $$;
CREATE TABLE app_core.user_character_preferences(
  user_id uuid NOT NULL, character_id uuid NOT NULL, PRIMARY KEY(user_id, character_id));
CREATE TABLE experience.chat_sessions(
  id uuid PRIMARY KEY, user_id uuid NOT NULL, character_id uuid NOT NULL,
  branch_source_session_id uuid REFERENCES experience.chat_sessions(id));
CREATE TABLE experience.chat_history(
  id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid NOT NULL, character_id uuid NOT NULL,
  turn_index integer NOT NULL, revision integer NOT NULL DEFAULT 1,
  model text, user_input text, assistant_reply text, history jsonb, status text DEFAULT 'success',
  upstream_status text, deduction_rate numeric, created_at timestamptz DEFAULT now(),
  llm_finish_reason text, llm_charge_id uuid, postprocess_version integer, rich_reply_metadata jsonb,
  first_token_preview jsonb);
CREATE VIEW experience.current_chat_history AS
  SELECT DISTINCT ON (session_id, turn_index) * FROM experience.chat_history
  ORDER BY session_id, turn_index, revision DESC;
CREATE TABLE experience.chat_branch_turns(
  session_id uuid NOT NULL REFERENCES experience.chat_sessions(id), turn_index integer NOT NULL,
  source_history_id uuid NOT NULL REFERENCES experience.chat_history(id), PRIMARY KEY(session_id, turn_index));
CREATE VIEW experience.session_chat_history WITH (security_invoker = true) AS
SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.history,
       h.character_id, h.status, h.upstream_status, h.deduction_rate, h.created_at,
       h.llm_finish_reason, h.llm_charge_id, h.session_id, h.turn_index, h.revision,
       h.postprocess_version, h.rich_reply_metadata, h.first_token_preview, false AS is_inherited
FROM experience.current_chat_history AS h
UNION ALL
SELECT h.id, s.user_id, h.model, h.user_input, h.assistant_reply, h.history,
       s.character_id, h.status, h.upstream_status, NULL::numeric, h.created_at,
       h.llm_finish_reason, NULL::uuid, inherited.session_id,
       inherited.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata,
       NULL::jsonb, true AS is_inherited
FROM experience.chat_branch_turns AS inherited
JOIN experience.chat_sessions AS s ON s.id = inherited.session_id
JOIN experience.chat_history AS h ON h.id = inherited.source_history_id
  AND h.user_id = s.user_id AND h.character_id = s.character_id
WHERE NOT EXISTS (SELECT 1 FROM experience.chat_history AS own
  WHERE own.session_id = inherited.session_id AND own.turn_index = inherited.turn_index);
CREATE FUNCTION experience.bind_creator_character_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c app_core.characters; runtime jsonb;
BEGIN
 SELECT * INTO c FROM app_core.characters LIMIT 1;
 runtime:=jsonb_build_object('id',c.id,'name',c.name,'system_prompt',c.system_prompt,
   'character_persona_and_style',c.character_persona_and_style);
 RETURN NEW;
END $$;
GRANT USAGE ON SCHEMA app_core, experience TO service_role, anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA experience TO service_role;
GRANT SELECT, INSERT, UPDATE ON app_core.user_character_preferences TO service_role;

INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
INSERT INTO app_core.characters VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO experience.chat_sessions(id, user_id, character_id) VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
INSERT INTO experience.chat_history(id, user_id, session_id, character_id, turn_index)
SELECT ('30000000-0000-4000-8000-00000000000' || t)::uuid, '00000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', t
FROM generate_series(1, 6) AS t;
SQL

"${task_psql[@]}" < "$task_root/packages/shared/migrations/20261119_status_bar_v2.sql" >/dev/null

"${task_psql[@]}" <<'SQL'
DO $t$
DECLARE
  u1 constant uuid := '00000000-0000-4000-8000-000000000001';
  u2 constant uuid := '00000000-0000-4000-8000-000000000002';
  c1 constant uuid := '10000000-0000-4000-8000-000000000001';
  s1 constant uuid := '20000000-0000-4000-8000-000000000001';
  s2 constant uuid := '20000000-0000-4000-8000-000000000002';
  h5 constant uuid := '30000000-0000-4000-8000-000000000005';
  h6 constant uuid := '30000000-0000-4000-8000-000000000006';
  h6b constant uuid := '30000000-0000-4000-8000-00000000006b';
  h7s2 constant uuid := '30000000-0000-4000-8000-0000000000a7';
  r record; v_id uuid; v_first uuid; v_failed boolean; v_count int;
BEGIN
  -- 从没记录过：空
  SELECT * INTO r FROM experience.get_chat_status(s1);
  IF r.snapshot_id IS NOT NULL THEN RAISE EXCEPTION 'expected no status yet'; END IF;

  -- 第 5 轮自动、第 6 轮手动：取最新那条
  PERFORM experience.record_chat_status(s1, u1, h5, 5, '好感：30/100', 'card', 'auto');
  PERFORM experience.record_chat_status(s1, u1, h6, 6, '好感：38/100（+8）', 'card', 'manual');
  SELECT * INTO r FROM experience.get_chat_status(s1);
  IF r.anchor_turn_index <> 6 OR r.trigger <> 'manual' OR NOT r.can_undo THEN RAISE EXCEPTION 'latest expected: %', r; END IF;

  -- 重新生成第 6 轮：旧版本上的记录失效，退回第 5 轮的
  INSERT INTO experience.chat_history(id, user_id, session_id, character_id, turn_index, revision)
  VALUES (h6b, u1, s1, c1, 6, 2);
  SELECT * INTO r FROM experience.get_chat_status(s1);
  IF r.anchor_turn_index <> 5 THEN RAISE EXCEPTION 'regenerated turn must hide old record: %', r; END IF;

  -- 同一锚点更新两次：只留一条，撤销恢复前一条，再撤销回到第 5 轮
  v_first := experience.record_chat_status(s1, u1, h6b, 6, '好感：36/100（+6）', 'card', 'manual');
  v_id := experience.record_chat_status(s1, u1, h6b, 6, '好感：37/100（+7）', 'card', 'manual');
  SELECT count(*) INTO v_count FROM experience.chat_status_snapshots WHERE anchor_history_id = h6b AND discarded_at IS NULL;
  IF v_count <> 1 THEN RAISE EXCEPTION 'one active record per anchor expected, got %', v_count; END IF;
  IF (SELECT replaces_id FROM experience.chat_status_snapshots WHERE id = v_id) <> v_first THEN RAISE EXCEPTION 'replaces_id not recorded'; END IF;
  IF NOT experience.undo_chat_status(s1, u1) THEN RAISE EXCEPTION 'undo should succeed'; END IF;
  SELECT * INTO r FROM experience.get_chat_status(s1);
  IF r.snapshot_id <> v_first THEN RAISE EXCEPTION 'undo must restore replaced record: %', r; END IF;
  PERFORM experience.undo_chat_status(s1, u1);
  SELECT * INTO r FROM experience.get_chat_status(s1);
  IF r.anchor_turn_index <> 5 THEN RAISE EXCEPTION 'second undo must fall back to turn 5: %', r; END IF;

  -- 分支：从第 5 轮分出 s2，看得到父会话第 5 轮的记录，但不能撤销它
  INSERT INTO experience.chat_sessions(id, user_id, character_id, branch_source_session_id) VALUES (s2, u1, c1, s1);
  INSERT INTO experience.chat_branch_turns(session_id, turn_index, source_history_id)
  SELECT s2, t, ('30000000-0000-4000-8000-00000000000' || t)::uuid FROM generate_series(1, 5) AS t;
  SELECT * INTO r FROM experience.get_chat_status(s2);
  IF r.anchor_turn_index <> 5 OR r.can_undo THEN RAISE EXCEPTION 'branch must inherit parent record read-only: %', r; END IF;
  IF experience.undo_chat_status(s2, u1) THEN RAISE EXCEPTION 'branch must not undo parent record'; END IF;
  INSERT INTO experience.chat_history(id, user_id, session_id, character_id, turn_index) VALUES (h7s2, u1, s2, c1, 6);
  PERFORM experience.record_chat_status(s2, u1, h7s2, 6, '好感：50/100', 'card', 'auto');
  SELECT * INTO r FROM experience.get_chat_status(s2);
  IF r.anchor_turn_index <> 6 OR NOT r.can_undo THEN RAISE EXCEPTION 'branch own record expected: %', r; END IF;
  -- 父会话不受分支影响
  SELECT * INTO r FROM experience.get_chat_status(s1);
  IF r.anchor_turn_index <> 5 THEN RAISE EXCEPTION 'parent must not see branch record: %', r; END IF;

  -- 别人的会话：写入、撤销都拒绝
  v_failed := false;
  BEGIN PERFORM experience.record_chat_status(s1, u2, h5, 5, 'x', 'card', 'auto');
  EXCEPTION WHEN no_data_found THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'cross-user record must fail'; END IF;
  v_failed := false;
  BEGIN PERFORM experience.undo_chat_status(s1, u2);
  EXCEPTION WHEN no_data_found THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'cross-user undo must fail'; END IF;

  -- 约束：触发方式、来源、空文本
  v_failed := false;
  BEGIN PERFORM experience.record_chat_status(s1, u1, h5, 5, 'x', 'card', 'cron');
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'trigger check missing'; END IF;
  v_failed := false;
  BEGIN PERFORM experience.record_chat_status(s1, u1, h5, 5, '', 'card', 'auto');
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'empty text must be rejected'; END IF;

  -- 玩家覆盖版：只收对象、不超 16KB
  INSERT INTO app_core.user_character_preferences(user_id, character_id, status_bar_detail) VALUES (u1, c1, '{"version":1}');
  v_failed := false;
  BEGIN UPDATE app_core.user_character_preferences SET status_bar_detail = '[1]' WHERE user_id = u1;
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'non-object detail must be rejected'; END IF;
  v_failed := false;
  BEGIN UPDATE app_core.user_character_preferences SET status_bar_detail = jsonb_build_object('note', repeat('啊', 6000)) WHERE user_id = u1;
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'oversized detail must be rejected'; END IF;

  -- 级联：删掉锚定轮次，记录跟着删
  DELETE FROM experience.chat_status_snapshots WHERE session_id = s2;
  DELETE FROM experience.chat_history WHERE id = h7s2;
  -- 作者的状态栏：私密发布写到卡上，读卡带出来；作者试玩用草稿覆盖
  INSERT INTO app_core.character_creations(character_id, owner_user_id, draft, draft_runtime, submission) VALUES
    (c1, u2, '{"tags":[]}', '{"name":"林晚","system_prompt":"p","status_bar":{"version":1,"note":"","sections":[]}}',
     '{"runtime":{"name":"林晚","system_prompt":"p","status_bar":{"version":1,"note":"审核版","sections":[]}},"draft":{"tags":[]}}');
  PERFORM app_core.mutate_creator_character(u2, c1, 'publish', 1, '{}');
  IF (SELECT status_bar_detail->>'version' FROM app_core.characters WHERE id = c1) <> '1' THEN RAISE EXCEPTION 'publish must copy status bar'; END IF;
  PERFORM app_core.review_creator_character(u2, c1, 1, 'approve', '', 'test');
  IF (SELECT status_bar_detail->>'note' FROM app_core.characters WHERE id = c1) <> '审核版' THEN RAISE EXCEPTION 'approval must copy status bar'; END IF;
  IF app_core.read_character_runtime(c1, u1)->'status_bar'->>'note' <> '审核版' THEN RAISE EXCEPTION 'runtime must expose published status bar'; END IF;
  IF app_core.read_character_runtime(c1, u2)->'status_bar'->>'note' <> '' THEN RAISE EXCEPTION 'owner must see draft status bar'; END IF;
  IF position('status_bar' IN (SELECT prosrc FROM pg_proc WHERE oid = 'experience.bind_creator_character_version()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'version binding must include status bar';
  END IF;
  -- 运营写回：卡上写入；草稿里没有状态栏的创作卡一并补进草稿；草稿已有的不动；返回旧值
  INSERT INTO app_core.characters(id) VALUES ('10000000-0000-4000-8000-000000000009');
  IF (app_core.set_character_status_bar('10000000-0000-4000-8000-000000000009', '{"version":1,"note":"运营版"}')->>'draft_patched')::boolean THEN
    RAISE EXCEPTION 'official card has no draft to patch';
  END IF;
  IF (SELECT status_bar_detail->>'note' FROM app_core.characters WHERE id = '10000000-0000-4000-8000-000000000009') <> '运营版' THEN
    RAISE EXCEPTION 'ops write must land on the card';
  END IF;
  IF app_core.set_character_status_bar(c1, '{"version":1,"note":"运营版"}')->'previous'->>'note' <> '审核版' THEN
    RAISE EXCEPTION 'ops write must return the previous status bar';
  END IF;
  IF (SELECT draft->'statusBar'->>'note' FROM app_core.character_creations WHERE character_id = c1) <> '运营版'
     OR (SELECT draft_runtime->'status_bar'->>'note' FROM app_core.character_creations WHERE character_id = c1) <> '运营版' THEN
    RAISE EXCEPTION 'creator draft without status bar must be patched';
  END IF;
  IF (app_core.set_character_status_bar(c1, '{"version":1,"note":"第二次"}')->>'draft_patched')::boolean
     OR (SELECT draft->'statusBar'->>'note' FROM app_core.character_creations WHERE character_id = c1) <> '运营版' THEN
    RAISE EXCEPTION 'creator draft that already has a status bar must be kept';
  END IF;
  BEGIN PERFORM app_core.set_character_status_bar('10000000-0000-4000-8000-0000000000ff', '{}');
    RAISE EXCEPTION 'missing card must fail';
  EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
  BEGIN PERFORM app_core.set_character_status_bar(c1, '[1]');
    RAISE EXCEPTION 'non-object must fail';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  RAISE NOTICE 'behaviour ok';
END
$t$;

-- 权限：anon / authenticated 读不到表、调不了函数；service_role 可以
DO $p$
BEGIN
  IF has_table_privilege('anon', 'experience.chat_status_snapshots', 'SELECT')
     OR has_table_privilege('authenticated', 'experience.chat_status_snapshots', 'SELECT')
     OR has_table_privilege('service_role', 'experience.chat_status_snapshots', 'INSERT') THEN
    RAISE EXCEPTION 'table privileges too broad';
  END IF;
  IF NOT has_table_privilege('service_role', 'experience.chat_status_snapshots', 'SELECT') THEN
    RAISE EXCEPTION 'service_role must read snapshots';
  END IF;
  IF has_function_privilege('anon', 'experience.record_chat_status(uuid,uuid,uuid,integer,text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'experience.get_chat_status(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'experience.undo_chat_status(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_core.set_character_status_bar(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'app_core.set_character_status_bar(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'function privileges too broad';
  END IF;
  IF NOT has_function_privilege('service_role', 'experience.record_chat_status(uuid,uuid,uuid,integer,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'experience.get_chat_status(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'experience.undo_chat_status(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'app_core.set_character_status_bar(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role must execute functions';
  END IF;
  RAISE NOTICE 'privileges ok';
END
$p$;

-- service_role 身份实际调用一次读函数（视图是 security_invoker，要能穿透）
SET ROLE service_role;
SELECT count(*) AS readable FROM experience.get_chat_status('20000000-0000-4000-8000-000000000001');
RESET ROLE;
SQL
# 函数改写可重跑：已改过的跳过、不报错
sed -n '/^DO \$creator\$/,/^\$creator\$;/p' "$task_root/packages/shared/migrations/20261119_status_bar_v2.sql" | "${task_psql[@]}" >/dev/null
echo "status bar v2 migration: all checks passed"
