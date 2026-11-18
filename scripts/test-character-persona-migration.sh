#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261118_character_persona.sql: 上限 10 个、第一个自动默认、默认唯一、只能选自己的人设、
# 删除人设后回到跟随默认、生成链路读取函数的优先级（指定 > 不使用 > 默认），以及权限。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-character-persona-${RANDOM}-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE TABLE app_core.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE app_core.characters(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
INSERT INTO app_core.users(id) VALUES
  ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
INSERT INTO app_core.characters(id) VALUES ('10000000-0000-4000-8000-000000000001');
GRANT USAGE ON SCHEMA app_core TO service_role, anon, authenticated;
SQL

"${task_psql[@]}" < "$task_root/packages/shared/migrations/20261118_character_persona.sql" >/dev/null

"${task_psql[@]}" <<'SQL'
\set u1 '00000000-0000-4000-8000-000000000001'
\set u2 '00000000-0000-4000-8000-000000000002'
\set c1 '10000000-0000-4000-8000-000000000001'

DO $t$
DECLARE
  v_a app_core.user_personas; v_b app_core.user_personas; v_c app_core.user_personas;
  v_u2 app_core.user_personas; r record; v_count int; v_failed boolean;
BEGIN
  -- 第一个自动成为默认
  v_a := app_core.save_user_persona('00000000-0000-4000-8000-000000000001', NULL, ' 书生 ', ' 落魄书生 ', false);
  IF NOT v_a.is_default OR v_a.name <> '书生' OR v_a.description <> '落魄书生' THEN
    RAISE EXCEPTION 'first persona must be default and trimmed: %', v_a;
  END IF;
  -- 设新默认会取消旧默认，始终只有一个
  v_b := app_core.save_user_persona('00000000-0000-4000-8000-000000000001', NULL, '穿越者', '现代人', true);
  SELECT count(*) INTO v_count FROM app_core.user_personas
   WHERE user_id = '00000000-0000-4000-8000-000000000001' AND is_default;
  IF v_count <> 1 OR NOT (SELECT is_default FROM app_core.user_personas WHERE id = v_b.id) THEN
    RAISE EXCEPTION 'exactly one default expected';
  END IF;
  -- 上限 10 个
  FOR i IN 3..10 LOOP
    PERFORM app_core.save_user_persona('00000000-0000-4000-8000-000000000001', NULL, 'p' || i, 'd', false);
  END LOOP;
  v_failed := false;
  BEGIN
    PERFORM app_core.save_user_persona('00000000-0000-4000-8000-000000000001', NULL, 'p11', 'd', false);
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'persona limit not enforced'; END IF;
  -- 改别人的人设：不存在
  v_u2 := app_core.save_user_persona('00000000-0000-4000-8000-000000000002', NULL, 'u2', 'd', false);
  v_failed := false;
  BEGIN
    PERFORM app_core.save_user_persona('00000000-0000-4000-8000-000000000002', v_a.id, 'x', 'd', false);
  EXCEPTION WHEN no_data_found THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'cross-user update must fail'; END IF;
  -- 越权选用别人的人设：复合外键拒绝
  v_failed := false;
  BEGIN
    INSERT INTO app_core.user_character_preferences(user_id, character_id, persona_id)
    VALUES ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', v_u2.id);
  EXCEPTION WHEN foreign_key_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'foreign persona must be rejected'; END IF;
  -- persona_disabled 与 persona_id 互斥
  v_failed := false;
  BEGIN
    INSERT INTO app_core.user_character_preferences(user_id, character_id, persona_id, persona_disabled)
    VALUES ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', v_a.id, true);
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'disabled + persona must be rejected'; END IF;
  -- 补充设定超长
  v_failed := false;
  BEGIN
    INSERT INTO app_core.user_character_preferences(user_id, character_id, character_notes)
    VALUES ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', repeat('x', 1001));
  EXCEPTION WHEN check_violation THEN v_failed := true; END;
  IF NOT v_failed THEN RAISE EXCEPTION 'notes limit not enforced'; END IF;

  -- 读取优先级：无行 → 默认人设（穿越者），补充设定空串
  SELECT * INTO r FROM app_core.get_character_prompt_settings('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
  IF r.character_notes <> '' OR r.persona_description <> '现代人' THEN RAISE EXCEPTION 'default read wrong: %', r; END IF;
  -- 只写补充设定，不动人设选择
  INSERT INTO app_core.user_character_preferences(user_id, character_id, character_notes)
  VALUES ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '小红：侍女');
  -- 指定某个人设 > 默认
  UPDATE app_core.user_character_preferences SET persona_id = v_a.id
   WHERE user_id = '00000000-0000-4000-8000-000000000001' AND character_id = '10000000-0000-4000-8000-000000000001';
  SELECT * INTO r FROM app_core.get_character_prompt_settings('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
  IF r.character_notes <> '小红：侍女' OR r.persona_description <> '落魄书生' THEN RAISE EXCEPTION 'chosen read wrong: %', r; END IF;
  -- 不使用 → 人设为空
  UPDATE app_core.user_character_preferences SET persona_id = NULL, persona_disabled = true
   WHERE user_id = '00000000-0000-4000-8000-000000000001' AND character_id = '10000000-0000-4000-8000-000000000001';
  SELECT * INTO r FROM app_core.get_character_prompt_settings('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
  IF r.persona_description <> '' THEN RAISE EXCEPTION 'disabled read wrong: %', r; END IF;
  -- 再选回某个人设后删除它：persona_id 置空、回到跟随默认；补充设定保留
  UPDATE app_core.user_character_preferences SET persona_id = v_a.id, persona_disabled = false
   WHERE user_id = '00000000-0000-4000-8000-000000000001' AND character_id = '10000000-0000-4000-8000-000000000001';
  IF NOT app_core.delete_user_persona('00000000-0000-4000-8000-000000000001', v_a.id) THEN
    RAISE EXCEPTION 'delete must report true';
  END IF;
  SELECT * INTO r FROM app_core.get_character_prompt_settings('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
  IF r.character_notes <> '小红：侍女' OR r.persona_description <> '现代人' THEN
    RAISE EXCEPTION 'after delete must follow default and keep notes: %', r;
  END IF;
  -- 别的用户删不掉
  IF app_core.delete_user_persona('00000000-0000-4000-8000-000000000002', v_b.id) THEN
    RAISE EXCEPTION 'cross-user delete must be false';
  END IF;
  -- 没有任何行的用户也始终返回一行
  SELECT count(*) INTO v_count FROM app_core.get_character_prompt_settings('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001');
  IF v_count <> 1 THEN RAISE EXCEPTION 'read must always return one row'; END IF;
END
$t$;

-- 权限：anon / authenticated 不能碰表和函数，service_role 能读表、执行函数
DO $acl$
BEGIN
  IF has_table_privilege('anon', 'app_core.user_personas', 'SELECT')
     OR has_table_privilege('authenticated', 'app_core.user_character_preferences', 'SELECT')
     OR has_function_privilege('authenticated', 'app_core.save_user_persona(uuid,uuid,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'app_core.get_character_prompt_settings(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'browser roles must have no access';
  END IF;
  IF NOT has_table_privilege('service_role', 'app_core.user_personas', 'SELECT')
     OR has_table_privilege('service_role', 'app_core.user_personas', 'INSERT')
     OR NOT has_table_privilege('service_role', 'app_core.user_character_preferences', 'INSERT')
     OR NOT has_function_privilege('service_role', 'app_core.get_character_prompt_settings(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role grants unexpected';
  END IF;
END
$acl$;
SQL

echo "character persona migration: OK"
