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
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/tests/creator_characters.sql"
printf 'PASS: creator core PG17 (owner/review CAS/access, real turn freeze, draft/public versions, rollback, branches, immutable ACL). Database: %s\n' "$task_database"
