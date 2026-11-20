#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261119_status_bar_legacy_cleanup.sql：开始轮次的两个函数不再写/返回 status_rules_mode、
# 守卫不再看这一列、列与 CHECK 已删、模板校验不再要求 {{STATUS_RULES}}、status_rules 退役并清掉草稿与运行值、
# 其他槽位照旧，以及重跑不报错。替身函数只保留线上定义里要替换的那几行原文（2026-11-19 只读核对）。
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-status-legacy-${RANDOM}-$$"
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
CREATE SCHEMA app_core;
CREATE SCHEMA experience;
CREATE SCHEMA admin;
CREATE TABLE app_core.runtime_config(key text PRIMARY KEY, value jsonb);
CREATE TABLE admin.managed_config_keys(config_key text PRIMARY KEY, retired_at timestamptz, note text);
CREATE TABLE admin.config_drafts(id integer PRIMARY KEY, config_key text REFERENCES admin.managed_config_keys(config_key), value jsonb);
-- 与生产一致：发布引用草稿（ON DELETE RESTRICT），发布过的草稿删不掉
CREATE TABLE admin.config_releases(id serial PRIMARY KEY, config_key text REFERENCES admin.managed_config_keys(config_key), value jsonb,
  source_draft_id integer REFERENCES admin.config_drafts(id) ON DELETE RESTRICT);
INSERT INTO admin.managed_config_keys(config_key) VALUES ('choice_rules'), ('status_rules'), ('memory_rules'), ('system_instructions');
INSERT INTO admin.config_drafts VALUES (1, 'status_rules', '{}'), (2, 'choice_rules', '{}'), (3, 'status_rules', '{"pending":true}');
INSERT INTO admin.config_releases(config_key, value, source_draft_id) VALUES ('status_rules', '{}', 1);
INSERT INTO app_core.runtime_config VALUES ('status_rules', '{}'), ('choice_rules', '{}');

CREATE TABLE experience.chat_history(
  id uuid PRIMARY KEY,
  choice_rules_mode text, status_rules_mode text, memory_rules_mode text,
  CONSTRAINT chat_history_status_rules_mode_check CHECK (((status_rules_mode IS NULL) OR (status_rules_mode = ANY (ARRAY['full'::text, 'concise'::text, 'off'::text]))))
);

CREATE FUNCTION experience.guard_chat_history_instruction_slot_modes() RETURNS trigger
LANGUAGE plpgsql AS $$
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
  IF TG_OP = 'UPDATE' AND OLD.choice_rules_mode IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'slot modes are immutable';
END $$;
-- 与生产一致：按列声明（2026-11-20 只读核对 pg_get_triggerdef），删列前必须先重建
CREATE TRIGGER trg_guard_chat_history_instruction_slot_modes
BEFORE INSERT OR UPDATE OF choice_rules_mode, status_rules_mode, memory_rules_mode ON experience.chat_history
FOR EACH ROW EXECUTE FUNCTION experience.guard_chat_history_instruction_slot_modes();

-- 两个开始轮次的函数：只保留写档位、返回档位这两段原文
CREATE FUNCTION experience.start_chat_history_turn_with_current_postprocess(p_history_id uuid, p_a text, p_b text, p_c integer, p_d integer, p_e integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_history_id uuid := p_history_id; v_mode text := 'full'; v_started jsonb := '{}'::jsonb;
  v_settings record;
BEGIN
  SELECT true AS pref_show_options, true AS pref_show_status, false AS pref_show_memory INTO v_settings;
  UPDATE experience.chat_history SET
    choice_rules_mode = CASE WHEN v_settings.pref_show_options THEN v_mode ELSE 'off' END,
    status_rules_mode = CASE WHEN v_settings.pref_show_status THEN v_mode ELSE 'off' END,
    memory_rules_mode = CASE WHEN v_settings.pref_show_memory THEN v_mode ELSE 'off' END
  WHERE id = v_history_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000'; END IF;
  RETURN v_started || (SELECT pg_catalog.jsonb_build_object('choice_rules_mode', choice_rules_mode, 'status_rules_mode', status_rules_mode, 'memory_rules_mode', memory_rules_mode) FROM experience.chat_history WHERE id = v_history_id);
END;
$$;
CREATE FUNCTION experience.start_chat_history_regeneration_with_current_postprocess(p_history_id uuid, p_a integer, p_b text, p_c integer, p_d integer, p_e integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_history_id uuid := p_history_id; v_mode text := 'concise'; v_started jsonb := '{}'::jsonb;
  v_settings record;
BEGIN
  SELECT false AS pref_show_options, true AS pref_show_status, true AS pref_show_memory INTO v_settings;
  UPDATE experience.chat_history SET
    choice_rules_mode = CASE WHEN v_settings.pref_show_options THEN v_mode ELSE 'off' END,
    status_rules_mode = CASE WHEN v_settings.pref_show_status THEN v_mode ELSE 'off' END,
    memory_rules_mode = CASE WHEN v_settings.pref_show_memory THEN v_mode ELSE 'off' END
  WHERE id = v_history_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'started history row disappeared' USING ERRCODE = '55000'; END IF;
  RETURN v_started || (SELECT pg_catalog.jsonb_build_object('choice_rules_mode', choice_rules_mode, 'status_rules_mode', status_rules_mode, 'memory_rules_mode', memory_rules_mode) FROM experience.chat_history WHERE id = v_history_id);
END;
$$;

-- 配置校验：只保留模板必填占位与槽位分发两段原文
CREATE FUNCTION admin.validate_managed_config_value(p_config_key text, p_value jsonb, p_text_value text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_field text;
BEGIN
  CASE p_config_key
    WHEN 'system_instructions' THEN
      FOREACH v_field IN ARRAY ARRAY[
        '{{CHOICE_RULES}}', '{{STATUS_RULES}}', '{{MEMORY_RULES}}',
        '{{WORD_COUNT}}', '{{USER_CUSTOM_INSTRUCTIONS}}'
      ] LOOP
        IF position(v_field IN coalesce(p_text_value, '')) = 0 THEN
          RAISE EXCEPTION 'system_instructions is missing required placeholder %', v_field;
        END IF;
      END LOOP;
    WHEN 'choice_rules', 'status_rules', 'memory_rules' THEN
      IF NOT (p_value ? 'off') THEN RAISE EXCEPTION 'slot rules incomplete'; END IF;
    ELSE NULL;
  END CASE;
END $$;
SQL

"${task_psql[@]}" < "$task_root/packages/shared/migrations/20261119_status_bar_legacy_cleanup.sql" >/dev/null

"${task_psql[@]}" <<'SQL'
DO $t$
DECLARE r jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'experience' AND table_name = 'chat_history' AND column_name = 'status_rules_mode') THEN
    RAISE EXCEPTION 'column must be dropped';
  END IF;
  -- 开始轮次：其他两档照写，返回值不再带 status_rules_mode
  INSERT INTO experience.chat_history(id) VALUES ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
  r := experience.start_chat_history_turn_with_current_postprocess('00000000-0000-4000-8000-000000000001', '', '', 0, 0, 0);
  IF r ? 'status_rules_mode' OR r->>'choice_rules_mode' <> 'full' OR r->>'memory_rules_mode' <> 'off' THEN
    RAISE EXCEPTION 'turn start returned %', r;
  END IF;
  r := experience.start_chat_history_regeneration_with_current_postprocess('00000000-0000-4000-8000-000000000002', 0, '', 0, 0, 0);
  IF r ? 'status_rules_mode' OR r->>'choice_rules_mode' <> 'off' OR r->>'memory_rules_mode' <> 'concise' THEN
    RAISE EXCEPTION 'regeneration start returned %', r;
  END IF;
  -- 守卫：档位定下来后仍不可改
  BEGIN
    UPDATE experience.chat_history SET memory_rules_mode = 'full' WHERE id = '00000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'slot modes must stay immutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'slot modes are immutable' THEN RAISE; END IF;
  END;
  -- 触发器重建后只看选项、记忆两列
  IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_guard_chat_history_instruction_slot_modes')
     NOT LIKE '%UPDATE OF choice_rules_mode, memory_rules_mode ON experience.chat_history%' THEN
    RAISE EXCEPTION 'guard trigger not rebuilt';
  END IF;
  -- 模板校验：不带 {{STATUS_RULES}} 也能过，其他占位照旧必填
  PERFORM admin.validate_managed_config_value('system_instructions', NULL, '{{CHOICE_RULES}}{{MEMORY_RULES}}{{WORD_COUNT}}{{USER_CUSTOM_INSTRUCTIONS}}');
  BEGIN
    PERFORM admin.validate_managed_config_value('system_instructions', NULL, '{{CHOICE_RULES}}{{WORD_COUNT}}{{USER_CUSTOM_INSTRUCTIONS}}');
    RAISE EXCEPTION 'memory placeholder must stay required';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%{{MEMORY_RULES}}%' THEN RAISE; END IF;
  END;
  -- 退役：保留行、发布历史与被发布引用的草稿，删未发布的草稿与运行值；其他 key 不动
  IF (SELECT retired_at FROM admin.managed_config_keys WHERE config_key = 'status_rules') IS NULL
     OR EXISTS (SELECT 1 FROM admin.config_drafts WHERE id = 3)
     OR NOT EXISTS (SELECT 1 FROM admin.config_drafts WHERE id = 1)
     OR EXISTS (SELECT 1 FROM app_core.runtime_config WHERE key = 'status_rules')
     OR NOT EXISTS (SELECT 1 FROM admin.config_releases WHERE config_key = 'status_rules')
     OR NOT EXISTS (SELECT 1 FROM admin.config_drafts WHERE config_key = 'choice_rules')
     OR NOT EXISTS (SELECT 1 FROM app_core.runtime_config WHERE key = 'choice_rules')
     OR (SELECT retired_at FROM admin.managed_config_keys WHERE config_key = 'choice_rules') IS NOT NULL THEN
    RAISE EXCEPTION 'retirement wrong';
  END IF;
  RAISE NOTICE 'behaviour ok';
END
$t$;
SQL

# 重跑：已改过的跳过，不报错
"${task_psql[@]}" < "$task_root/packages/shared/migrations/20261119_status_bar_legacy_cleanup.sql" >/dev/null
echo "status bar legacy cleanup migration: all checks passed"
