#!/usr/bin/env bash
# Isolated disposable PostgreSQL container, no ports, credentials, volumes or remote business data.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-drama-migration-${RANDOM}-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for task_attempt in $(seq 1 30); do
  if docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -U postgres -v ON_ERROR_STOP=1)
"${task_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA drama_archive;
CREATE SCHEMA app_core;
-- Existing environments may have broad defaults: the migration must narrow them explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA drama_archive GRANT ALL ON TABLES TO anon,authenticated,service_role;
CREATE TABLE drama_archive.dramas (id uuid PRIMARY KEY);
CREATE TABLE app_core.users (id uuid PRIMARY KEY);
GRANT USAGE ON SCHEMA drama_archive TO service_role;
INSERT INTO drama_archive.dramas VALUES('11111111-1111-4111-8111-111111111111');
INSERT INTO app_core.users VALUES('22222222-2222-4222-8222-222222222222'),('22222222-2222-4222-8222-222222222223');
SQL
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261027_drama_interactions.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF has_table_privilege('anon','drama_archive.drama_comments','SELECT') OR has_table_privilege('authenticated','drama_archive.drama_likes','INSERT')
    OR has_function_privilege('anon','drama_archive.create_drama_comment(uuid,uuid,uuid,text)','EXECUTE')
    OR has_table_privilege('service_role','drama_archive.drama_comments','INSERT')
    OR has_table_privilege('service_role','drama_archive.drama_likes','TRUNCATE')
    OR has_column_privilege('service_role','drama_archive.drama_comments','body','UPDATE')
    OR NOT has_column_privilege('service_role','drama_archive.drama_comments','deleted_at','UPDATE') THEN RAISE EXCEPTION 'privilege mismatch'; END IF;
  IF (SELECT count(*) FROM pg_class WHERE oid IN ('drama_archive.drama_comments'::regclass,'drama_archive.drama_likes'::regclass) AND relrowsecurity)<>2 THEN RAISE EXCEPTION 'RLS missing'; END IF;
END $$;
SET ROLE service_role;
INSERT INTO drama_archive.drama_likes(drama_id,user_id) VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO drama_archive.drama_likes(drama_id,user_id) VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222') ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM drama_archive.drama_likes)<>1 THEN RAISE EXCEPTION 'duplicate like'; END IF;
END $$;
DELETE FROM drama_archive.drama_likes WHERE user_id='22222222-2222-4222-8222-222222222222';
SELECT * FROM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333331','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','first');
SELECT * FROM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333331','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','first');
SELECT * FROM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333332','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','second');
SELECT * FROM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','third');
DO $$ BEGIN
  IF (SELECT count(*) FROM drama_archive.drama_comments)<>3 THEN RAISE EXCEPTION 'duplicate comment'; END IF;
  BEGIN
    PERFORM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333334','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','fourth');
    RAISE EXCEPTION 'limit missing';
  EXCEPTION WHEN SQLSTATE 'P0429' THEN NULL; END;
  BEGIN
    PERFORM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333331','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222223','first');
    RAISE EXCEPTION 'foreign idempotency key accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
UPDATE drama_archive.drama_comments SET deleted_at=now() WHERE id='33333333-3333-4333-8333-333333333331' AND user_id='22222222-2222-4222-8222-222222222223';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM drama_archive.drama_comments WHERE deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'non-owner removed comment'; END IF;
END $$;
UPDATE drama_archive.drama_comments SET deleted_at=now() WHERE id='33333333-3333-4333-8333-333333333331' AND user_id='22222222-2222-4222-8222-222222222222';
DO $$ BEGIN
  BEGIN
    PERFORM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333331','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','first');
    RAISE EXCEPTION 'deleted comment resurrected';
  EXCEPTION WHEN SQLSTATE 'P0410' THEN NULL; END;
  BEGIN
    PERFORM drama_archive.create_drama_comment('33333333-3333-4333-8333-333333333334','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','fourth');
    RAISE EXCEPTION 'delete bypassed limit';
  EXCEPTION WHEN SQLSTATE 'P0429' THEN NULL; END;
  BEGIN
    PERFORM drama_archive.create_drama_comment(gen_random_uuid(),'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222223','');
    RAISE EXCEPTION 'empty body allowed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM drama_archive.create_drama_comment(gen_random_uuid(),'11111111-1111-4111-8111-111111111112','22222222-2222-4222-8222-222222222223','unknown drama');
    RAISE EXCEPTION 'orphan allowed';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
SQL
# Parallel publications by the same second viewer: exactly three may be inserted.
for task_i in $(seq 1 6); do
  "${task_psql[@]}" >/dev/null <<'SQL' &
SET ROLE service_role;
DO $$ BEGIN
  PERFORM drama_archive.create_drama_comment(gen_random_uuid(),'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222223','parallel');
EXCEPTION WHEN SQLSTATE 'P0429' THEN NULL; END $$;
SQL
done
wait
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM drama_archive.drama_comments WHERE user_id='22222222-2222-4222-8222-222222222223')<>3 THEN RAISE EXCEPTION 'concurrent limit failed'; END IF;
END $$;
DELETE FROM app_core.users;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM drama_archive.drama_comments) THEN RAISE EXCEPTION 'user cascade failed'; END IF;
END $$;
DROP FUNCTION drama_archive.create_drama_comment(uuid,uuid,uuid,text);
DROP TABLE drama_archive.drama_comments,drama_archive.drama_likes;
SQL
printf 'PASS: migration, grants/RLS, idempotency, owner deletion, concurrency limit, cascade and rollback\n'
