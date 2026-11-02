#!/usr/bin/env bash
# Disposable PG17 only. Reuses real conversation/branch baseline and actual migrations.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="${CREATOR_TEST_CONTAINER:-st-creator-permissions-${RANDOM}-$$}"
task_database="creator_core_test_${RANDOM}"
task_owned=0
cleanup() { if [[ "$task_owned" == 1 ]]; then docker rm -f "$task_container" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
if [[ -z "${CREATOR_TEST_CONTAINER:-}" ]]; then
  docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
  task_owned=1
  for task_attempt in $(seq 1 30); do
    if docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$task_container")" == none ]]
docker exec "$task_container" createdb -U postgres "$task_database"
task_psql=(docker exec -i "$task_container" psql -X -U postgres -d "$task_database" -v ON_ERROR_STOP=1)
# Reuse the existing isolated chat fixture, avoiding a second drift-prone engine schema.
python3 - "$task_root" <<'PY' | "${task_psql[@]}" >/dev/null
import sys
from pathlib import Path
root=Path(sys.argv[1]); source=(root/'scripts/test-conversation-branches-migration.sh').read_text()
a=source.index("<<'SQL'\n")+len("<<'SQL'\n"); b=source.index('\nSQL\n',a)
sql=source[a:b]
for role in ['anon','authenticated','service_role']:
 line=next(x for x in sql.splitlines() if x.startswith('CREATE ROLE '+role+' '))
 sql=sql.replace(line, "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='"+role+"') THEN "+line+" END IF; END $$;")
print(sql)
PY
"${task_psql[@]}" >/dev/null <<'SQL'
ALTER TABLE app_core.characters ADD COLUMN name text NOT NULL DEFAULT '',ADD COLUMN description text NOT NULL DEFAULT '',
 ADD COLUMN avatar_url text NOT NULL DEFAULT '',ADD COLUMN creator text NOT NULL DEFAULT '',ADD COLUMN first_mes text NOT NULL DEFAULT '',
 ADD COLUMN system_prompt text NOT NULL DEFAULT '',ADD COLUMN personality text NOT NULL DEFAULT '',ADD COLUMN scenario text NOT NULL DEFAULT '',
 ADD COLUMN mes_example text NOT NULL DEFAULT '',ADD COLUMN post_history_instructions text NOT NULL DEFAULT '',
 ADD COLUMN creator_notes text NOT NULL DEFAULT '',ADD COLUMN tags jsonb NOT NULL DEFAULT '[]',ADD COLUMN sort_order integer DEFAULT 0,
 ADD COLUMN last_listed_at timestamptz,ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN created_at timestamptz DEFAULT now();
-- Match the live character row's text/JSON columns and historical dropped attribute slots.
-- The runtime reader must project its fields without serializing unrelated card imports.
ALTER TABLE app_core.characters ADD COLUMN legacy_fixture_column text,
 ADD COLUMN raw_card jsonb,ADD COLUMN character_book jsonb,
 ADD COLUMN extensions jsonb NOT NULL DEFAULT '{}',ADD COLUMN alternate_greetings jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN character_persona_and_style text;
ALTER TABLE app_core.characters DROP COLUMN legacy_fixture_column;
ALTER TABLE miniapp_features.character_favorites ADD COLUMN created_at timestamptz DEFAULT now();
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
CREATE SCHEMA admin;
CREATE TABLE admin.admin_users(user_id uuid PRIMARY KEY,email text NOT NULL,role text,can_access_test boolean,can_access_prod boolean);
CREATE TABLE admin.audit_logs(actor_user_id uuid,actor_email text,environment text,action text,schema_name text,table_name text,record_id text,after_value jsonb);
SQL
python3 - "$task_root" <<'PY' | "${task_psql[@]}" >/dev/null
import sys
from pathlib import Path
root=Path(sys.argv[1])/'packages/shared/migrations'
a=(root/'072_chat_history_conversation_source.sql').read_text()
for first,last in [('CREATE OR REPLACE FUNCTION miniapp.guard_chat_session_idle(', 'CREATE OR REPLACE FUNCTION miniapp.start_chat_history_turn('),('CREATE OR REPLACE FUNCTION miniapp.tf_refresh_chat_session_stats_from_history()', '-- 旧 M1 表')]:
 print(a[a.index(first):a.index(last,a.index(first))].replace('miniapp.','experience.'))
b=(root/'077_context_window.sql').read_text()
print(b[b.index('CREATE OR REPLACE FUNCTION miniapp.apply_context_window_flood('):b.index('COMMIT;')].replace('miniapp.','experience.'))
PY
for task_migration in \
  20260928_chat_history_postprocess_version.sql \
  20260930_bind_current_text_postprocess_on_turn_start.sql \
  20261013_platform_instruction_slot_windows.sql \
  20261013_session_scoped_instruction_slot_modes.sql \
  20261014_rich_reply_dynamic_mode.sql \
  20261029_character_social.sql \
  20261029_conversation_branches.sql \
  20261029_chat_message_likes.sql \
  20261030_creator_cover_assets.sql \
  20261030_creator_characters.sql \
  20261030_creator_character_versions.sql \
  20261030_creator_runtime_projection_fix.sql; do
  "${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/$task_migration" >/dev/null
done
# Build old queued submissions through the old RPC before applying the forward migration.
"${task_psql[@]}" >/dev/null <<'SQL'
DO $legacy$
DECLARE
 owner_id uuid:='30000000-0000-4000-8000-000000000101';
 cover_id uuid:='30000000-0000-4000-8000-000000000102';
 admin_id uuid:='30000000-0000-4000-8000-000000000103';
 viewer_id uuid:='30000000-0000-4000-8000-000000000104';
 session_id uuid:='30000000-0000-4000-8000-000000000105';
 card_id uuid; r jsonb; d jsonb; runtime jsonb; payload jsonb; turn jsonb; n integer;
BEGIN
 INSERT INTO app_core.users(id) VALUES(owner_id),(viewer_id);
 INSERT INTO admin.admin_users VALUES(admin_id,'legacy-fixture@example.invalid','operator',true,false);
 INSERT INTO app_core.character_cover_assets VALUES(cover_id,owner_id,'fixture/legacy.png','image/png',100,100,100,now());
 d:='{"name":"旧版A","description":"旧版简介","opening":"旧开场","background":"旧背景","preset":"预设","tags":["日常"],"backgroundFiles":[],"presetFiles":[]}'::jsonb;
 runtime:='{"name":"旧版A","description":"旧版简介","first_mes":"旧开场","system_prompt":"legacy A"}'::jsonb;
 payload:=jsonb_build_object('draft',d,'runtime',runtime,'cover_asset_id',cover_id);
 FOR n IN 1..10 LOOP
  card_id:=('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  r:=app_core.mutate_creator_character(owner_id,card_id,'create',NULL,payload);
  IF n=6 THEN CONTINUE; END IF;
  r:=app_core.mutate_creator_character(owner_id,card_id,'publish',1,'{"visibility":"public"}');
  ASSERT r->>'review_status'='pending','legacy fixture did not exercise old publication behavior';
  IF n=1 THEN
   r:=app_core.review_creator_character(admin_id,card_id,(r->>'submitted_revision')::integer,'approve',NULL,'test');
   PERFORM app_core.grant_creator_character_access(viewer_id,card_id);
   INSERT INTO experience.chat_sessions(id,user_id,character_id) VALUES(session_id,viewer_id,card_id);
   turn:=experience.start_chat_history_turn_with_current_postprocess(session_id,'旧版已开聊','fixture');
   UPDATE experience.chat_history SET status='success',assistant_reply='旧版回复' WHERE id=(turn->>'history_id')::uuid;
   r:=app_core.mutate_creator_character(owner_id,card_id,'save',(r->>'revision')::integer,
     jsonb_build_object('draft',d||'{"name":"提交B","opening":"提交开场B"}'::jsonb,
       'runtime',runtime||'{"name":"提交B","first_mes":"提交开场B","system_prompt":"submitted B"}'::jsonb,'cover_asset_id',cover_id));
   r:=app_core.mutate_creator_character(owner_id,card_id,'publish',(r->>'revision')::integer,'{"visibility":"public"}');
   -- The submission is authoritative even if a different draft somehow exists alongside it.
   UPDATE app_core.character_creations SET draft_runtime=draft_runtime||'{"system_prompt":"unsubmitted C"}'::jsonb WHERE character_id=card_id;
  ELSIF n=2 THEN
   UPDATE app_core.characters SET enabled=false WHERE id=card_id;
  ELSIF n=3 THEN
   UPDATE app_core.characters SET archived_at=now() WHERE id=card_id;
  ELSIF n=4 THEN
   UPDATE app_core.character_creations SET revision=revision+1 WHERE character_id=card_id;
  ELSIF n=5 THEN
   UPDATE app_core.character_creations SET submission=submission-'runtime' WHERE character_id=card_id;
  ELSIF n=7 THEN
   PERFORM app_core.review_creator_character(admin_id,card_id,(r->>'submitted_revision')::integer,'reject','fixture rejection','test');
  ELSIF n=8 THEN
   UPDATE app_core.character_creations SET submission=jsonb_set(submission,'{cover_asset_id}','"invalid-cover-id"') WHERE character_id=card_id;
  ELSIF n=9 THEN
   UPDATE app_core.character_creations SET submission=jsonb_set(submission,'{runtime}',(submission->'runtime')-'description') WHERE character_id=card_id;
  ELSIF n=10 THEN
   UPDATE app_core.character_creations SET submission=jsonb_set(submission,'{runtime}',(submission->'runtime')-'system_prompt') WHERE character_id=card_id;
  END IF;
 END LOOP;
END $legacy$;
SQL
{
cat <<'SQL'
CREATE TEMP TABLE creator_review_state_before AS SELECT
 (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.character_id) FROM app_core.character_creations c) AS creations,
 (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app_core.characters c) AS characters,
 (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM app_core.character_versions v) AS versions,
 (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM experience.chat_sessions s) AS sessions,
 (SELECT count(*) FROM admin.audit_logs) AS audit_count;
SQL
cat "$task_root/packages/shared/migrations/20261102_creator_ai_review.sql"
cat <<'SQL'
DO $verify$
BEGIN
 ASSERT (SELECT creations IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.character_id) FROM app_core.character_creations c)
   AND characters IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app_core.characters c)
   AND versions IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM app_core.character_versions v)
   AND sessions IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM experience.chat_sessions s)
   AND audit_count=(SELECT count(*) FROM admin.audit_logs)
   FROM creator_review_state_before),'AI review migration changed existing pending/cards/chats';
 ASSERT (SELECT review_status='pending' AND revision=5 AND approved_revision=2 FROM app_core.character_creations
   WHERE character_id='30000000-0000-4000-8000-000000000001'),'legacy pending update was automatically approved';
 ASSERT app_core.read_session_character_runtime('30000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000104','30000000-0000-4000-8000-000000000105')->>'system_prompt'='legacy A',
   'legacy conversation snapshot changed';
END $verify$;
CREATE TEMP TABLE creator_review_function_before AS SELECT pg_get_functiondef(
 'app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)'::regprocedure) AS definition;
SQL
cat "$task_root/packages/shared/migrations/20261102_creator_ai_review.sql"
cat <<'SQL'
DO $verify$
BEGIN
 ASSERT (SELECT creations IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.character_id) FROM app_core.character_creations c)
   AND characters IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app_core.characters c)
   AND versions IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM app_core.character_versions v)
   AND sessions IS NOT DISTINCT FROM (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM experience.chat_sessions s)
   AND audit_count=(SELECT count(*) FROM admin.audit_logs)
   FROM creator_review_state_before),'AI review migration changed existing pending/cards/chats';
 ASSERT (SELECT review_status='pending' AND revision=5 AND approved_revision=2 FROM app_core.character_creations
   WHERE character_id='30000000-0000-4000-8000-000000000001'),'legacy pending update was automatically approved';
 ASSERT app_core.read_session_character_runtime('30000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000104','30000000-0000-4000-8000-000000000105')->>'system_prompt'='legacy A',
   'legacy conversation snapshot changed';
END $verify$;
DO $$ BEGIN
 ASSERT (SELECT definition=pg_get_functiondef('app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)'::regprocedure)
   FROM creator_review_function_before),'AI review migration replay changed function';
END $$;
SQL
} | "${task_psql[@]}" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/tests/creator_characters.sql"
printf 'PASS: creator core PG17 (AI review gate, untouched legacy queue, disabled/archive preservation, CAS/access, real turn freeze, branches, immutable ACL). Database: %s\n' "$task_database"

# Reuse the existing message-center fixture and actual VIP shape constraints for wishes.
python3 - "$task_root" <<'PY' | "${task_psql[@]}" >/dev/null
import sys
from pathlib import Path
root=Path(sys.argv[1])/'packages/shared/migrations'
base=(root/'fixtures/vip_billing_t2_harness.sql').read_text()
a=base.index('CREATE TABLE IF NOT EXISTS miniapp_features.notifications (')
b=base.index('\nALTER TABLE billing.user_wallets',a)
print(base[a:b])
vip=(root/'20260924_vip_billing_schema_pg_cron_compat.sql').read_text()
a=vip.index('-- ── 7. 通知去重键')
b=vip.index('-- ── 8.',a)
print(vip[a:b])
PY
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261102_character_wishes.sql" >/dev/null
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/tests/character_wishes.sql"
printf 'PASS: character wishes PG17 (anonymous public-only writes, owner ACL, unique support, response ownership, atomic notifications and retry deduplication).\n'

CREATOR_ANALYTICS_TEST_CONTAINER="$task_container" CREATOR_ANALYTICS_TEST_DB="$task_database" \
  pnpm --dir "$task_root/packages/backend" exec vitest run src/features/creator/analytics.integration.test.ts
