#!/usr/bin/env bash
# Isolated PostgreSQL only: no network, host ports, volumes, secrets or real business rows.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-character-social-${RANDOM}-$$"
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
CREATE SCHEMA app_core;
CREATE SCHEMA miniapp_features;
CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE app_core.characters (id uuid PRIMARY KEY,enabled boolean NOT NULL DEFAULT true,archived_at timestamptz);
CREATE TABLE miniapp_features.character_favorites(user_id uuid REFERENCES app_core.users(id),character_id uuid REFERENCES app_core.characters(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,character_id));
CREATE INDEX idx_character_favorites_character_created ON miniapp_features.character_favorites(character_id,created_at DESC);
GRANT USAGE ON SCHEMA app_core,miniapp_features TO service_role;
-- Production defaults can be permissive; new migration must explicitly narrow them.
ALTER DEFAULT PRIVILEGES IN SCHEMA miniapp_features GRANT ALL ON TABLES TO anon,authenticated,service_role;
INSERT INTO app_core.users VALUES('22222222-2222-4222-8222-222222222222'),('22222222-2222-4222-8222-222222222223'),('22222222-2222-4222-8222-222222222224');
INSERT INTO app_core.characters(id,enabled) VALUES('11111111-1111-4111-8111-111111111111',true),('11111111-1111-4111-8111-111111111112',false);
INSERT INTO miniapp_features.character_favorites(user_id,character_id) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
SQL
"${task_psql[@]}" -f - < "$task_root/packages/shared/migrations/20261029_character_social.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ DECLARE obj text; BEGIN
  FOREACH obj IN ARRAY ARRAY['character_likes','character_comments','character_comment_reports'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('miniapp_features.'||obj)::regclass) THEN RAISE EXCEPTION 'RLS absent %',obj; END IF;
    IF has_table_privilege('anon','miniapp_features.'||obj,'SELECT') OR has_table_privilege('authenticated','miniapp_features.'||obj,'INSERT') THEN RAISE EXCEPTION 'public table grants %',obj; END IF;
    IF has_table_privilege('service_role','miniapp_features.'||obj,'INSERT') THEN RAISE EXCEPTION 'direct write grant %',obj; END IF;
  END LOOP;
  IF has_function_privilege('anon','miniapp_features.get_character_socials(uuid[],uuid)','EXECUTE') THEN RAISE EXCEPTION 'public count RPC'; END IF;
  IF has_function_privilege('authenticated','miniapp_features.create_character_comment(uuid,uuid,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'public create RPC'; END IF;
END $$;
SET ROLE service_role;
DO $$ DECLARE s record; c record; BEGIN
  SELECT * INTO s FROM miniapp_features.get_character_socials(ARRAY['11111111-1111-4111-8111-111111111111'::uuid,'11111111-1111-4111-8111-111111111112'::uuid],'22222222-2222-4222-8222-222222222222');
  IF s.favorite_count<>1 OR s.like_count<>0 OR s.liked THEN RAISE EXCEPTION 'existing favorite was not preserved independently'; END IF;
  IF (SELECT count(*) FROM miniapp_features.get_character_socials(ARRAY['11111111-1111-4111-8111-111111111112'::uuid],'22222222-2222-4222-8222-222222222222'))<>0 THEN RAISE EXCEPTION 'inactive social leaked'; END IF;
  BEGIN
    PERFORM miniapp_features.get_character_socials(array_fill('11111111-1111-4111-8111-111111111111'::uuid,ARRAY[41]),'22222222-2222-4222-8222-222222222222');
    RAISE EXCEPTION 'unbounded batch';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM miniapp_features.set_character_like('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',true);
  SELECT * INTO s FROM miniapp_features.set_character_like('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',true);
  IF NOT s.liked OR s.like_count<>1 OR s.favorite_count<>1 THEN RAISE EXCEPTION 'like repeated or changed favorites'; END IF;
  SELECT * INTO s FROM miniapp_features.set_character_like('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',false);
  IF s.liked OR s.like_count<>0 OR s.favorite_count<>1 THEN RAISE EXCEPTION 'unlike changed favorites'; END IF;
  BEGIN
    PERFORM miniapp_features.set_character_like('11111111-1111-4111-8111-111111111112','22222222-2222-4222-8222-222222222222',true);
    RAISE EXCEPTION 'inactive like';
  EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
  PERFORM miniapp_features.create_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','  角色故事不错  ');
  SELECT * INTO c FROM miniapp_features.create_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','角色故事不错');
  IF c.body<>'角色故事不错' THEN RAISE EXCEPTION 'body normalization'; END IF;
  IF (SELECT count(*) FROM miniapp_features.character_comments)<>1 THEN RAISE EXCEPTION 'duplicate retry'; END IF;
  BEGIN
    PERFORM miniapp_features.create_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','different');
    RAISE EXCEPTION 'key body conflict allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM miniapp_features.create_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222223','角色故事不错');
    RAISE EXCEPTION 'key owner conflict allowed';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    PERFORM miniapp_features.create_character_comment(gen_random_uuid(),'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',chr(1));
    RAISE EXCEPTION 'control character accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM miniapp_features.create_character_comment(gen_random_uuid(),'11111111-1111-4111-8111-111111111112','22222222-2222-4222-8222-222222222222','inactive');
    RAISE EXCEPTION 'inactive comment';
  EXCEPTION WHEN SQLSTATE 'P0404' THEN NULL; END;
  PERFORM miniapp_features.report_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222223','spam');
  PERFORM miniapp_features.report_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222223','other');
  PERFORM miniapp_features.delete_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222223');
  IF (SELECT deleted_at FROM miniapp_features.character_comments LIMIT 1) IS NOT NULL THEN RAISE EXCEPTION 'other author deletion'; END IF;
  PERFORM miniapp_features.delete_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111112','22222222-2222-4222-8222-222222222222');
  IF (SELECT deleted_at FROM miniapp_features.character_comments LIMIT 1) IS NOT NULL THEN RAISE EXCEPTION 'cross character deletion'; END IF;
  PERFORM miniapp_features.delete_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
  PERFORM miniapp_features.delete_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
  BEGIN
    PERFORM miniapp_features.create_character_comment('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','角色故事不错');
    RAISE EXCEPTION 'deleted retry resurrected';
  EXCEPTION WHEN SQLSTATE 'P0410' THEN NULL; END;
  SELECT * INTO s FROM miniapp_features.get_character_socials(ARRAY['11111111-1111-4111-8111-111111111111'::uuid],'22222222-2222-4222-8222-222222222222');
  IF s.comment_count<>0 THEN RAISE EXCEPTION 'tombstone counted'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM miniapp_features.character_comment_reports)<>1 THEN RAISE EXCEPTION 'report not deduplicated'; END IF;
END $$;
SQL
# Concurrent submissions from one viewer: exactly three insertions across replicas.
for task_i in $(seq 1 6); do
  "${task_psql[@]}" >/dev/null <<'SQL' &
SET ROLE service_role;
DO $$ BEGIN
  PERFORM miniapp_features.create_character_comment(gen_random_uuid(),'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222224','parallel');
EXCEPTION WHEN SQLSTATE 'P0429' THEN NULL; END $$;
SQL
done
wait
"${task_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM miniapp_features.character_comments WHERE user_id='22222222-2222-4222-8222-222222222224')<>3 THEN RAISE EXCEPTION 'concurrent limit failed'; END IF;
END $$;
DELETE FROM miniapp_features.character_favorites;
DELETE FROM app_core.users;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM miniapp_features.character_comments) OR EXISTS(SELECT 1 FROM miniapp_features.character_comment_reports) THEN RAISE EXCEPTION 'user cascade failed'; END IF;
END $$;
DROP FUNCTION miniapp_features.set_character_like(uuid,uuid,boolean),miniapp_features.get_character_socials(uuid[],uuid),miniapp_features.create_character_comment(uuid,uuid,uuid,text),miniapp_features.delete_character_comment(uuid,uuid,uuid),miniapp_features.report_character_comment(uuid,uuid,uuid,text);
DROP TABLE miniapp_features.character_comment_reports,miniapp_features.character_comments,miniapp_features.character_likes;
DO $$ BEGIN
  IF to_regclass('miniapp_features.idx_character_favorites_character_created') IS NULL THEN RAISE EXCEPTION 'existing favorite index changed'; END IF;
END $$;
SQL
printf 'PASS: character migration, existing favorites, active visibility, permissions/RLS, independent likes, retry identity, author deletion, report deduplication, concurrent limit and rollback\n'
