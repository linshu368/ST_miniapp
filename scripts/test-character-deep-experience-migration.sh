#!/usr/bin/env bash
# Isolated PostgreSQL only: verifies the derived summary table and social RPC.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-character-deep-experience-${RANDOM}-$$"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$task_container" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
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
CREATE SCHEMA experience;
CREATE SCHEMA miniapp_features;
CREATE TABLE app_core.users(id uuid PRIMARY KEY);
CREATE TABLE app_core.characters(
  id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  archived_at timestamptz
);
CREATE FUNCTION app_core.can_use_character(p_user_id uuid,p_character_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM app_core.characters WHERE id=p_character_id AND enabled AND archived_at IS NULL)
$$;
CREATE TABLE miniapp_features.character_favorites(
  user_id uuid NOT NULL REFERENCES app_core.users(id),
  character_id uuid NOT NULL REFERENCES app_core.characters(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,character_id)
);
CREATE INDEX idx_character_favorites_character_created
  ON miniapp_features.character_favorites(character_id,created_at DESC);
CREATE TABLE experience.chat_sessions(id uuid PRIMARY KEY,character_id uuid NOT NULL);
CREATE TABLE experience.chat_message_likes(
  session_id uuid NOT NULL REFERENCES experience.chat_sessions(id),
  message_id uuid NOT NULL,
  PRIMARY KEY(session_id,message_id)
);
CREATE FUNCTION experience.get_character_reply_like_counts(p_character_ids uuid[])
RETURNS TABLE(character_id uuid,reply_like_count bigint)
LANGUAGE sql STABLE AS $$
  SELECT c, CASE WHEN c='11111111-1111-4111-8111-111111111111'::uuid THEN 2::bigint ELSE 0::bigint END
  FROM unnest(p_character_ids) AS ids(c)
$$;
ALTER DEFAULT PRIVILEGES IN SCHEMA miniapp_features GRANT ALL ON TABLES TO anon,authenticated,service_role;
INSERT INTO app_core.users VALUES('22222222-2222-4222-8222-222222222222');
INSERT INTO app_core.characters(id,enabled) VALUES
  ('11111111-1111-4111-8111-111111111111',true),
  ('11111111-1111-4111-8111-111111111112',false);
SQL
"${task_psql[@]}" -f - < "$repo_root/packages/shared/migrations/20261029_character_social.sql" >/dev/null
"${task_psql[@]}" -f - < "$repo_root/packages/shared/migrations/20261118_character_deep_experience.sql" >/dev/null
"${task_psql[@]}" -f - < "$repo_root/packages/shared/migrations/20261118_character_deep_experience.sql" >/dev/null
"${task_psql[@]}" >/dev/null <<'SQL'
INSERT INTO miniapp_features.character_likes(character_id,user_id)
VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
INSERT INTO miniapp_features.character_deep_experience_stats(character_id,deep_session_count)
VALUES('11111111-1111-4111-8111-111111111111',3);
DO $$ DECLARE s record; fn text; plan json; BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='miniapp_features.character_deep_experience_stats'::regclass) THEN
    RAISE EXCEPTION 'deep summary RLS absent';
  END IF;
  IF has_table_privilege('anon','miniapp_features.character_deep_experience_stats','SELECT')
     OR has_table_privilege('authenticated','miniapp_features.character_deep_experience_stats','SELECT') THEN
    RAISE EXCEPTION 'deep summary exposed to browser roles';
  END IF;
  IF NOT has_table_privilege('service_role','miniapp_features.character_deep_experience_stats','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'service role cannot maintain deep summary';
  END IF;
  SELECT * INTO s FROM miniapp_features.get_character_socials(
    ARRAY['11111111-1111-4111-8111-111111111111'::uuid,'11111111-1111-4111-8111-111111111112'::uuid],
    '22222222-2222-4222-8222-222222222222'
  );
  IF s.character_id<>'11111111-1111-4111-8111-111111111111'::uuid OR s.like_count<>6 OR s.favorite_count<>0 THEN
    RAISE EXCEPTION 'like total did not combine direct=1 reply=2 deep=3: %',s;
  END IF;
  IF (SELECT count(*) FROM miniapp_features.get_character_socials(
    ARRAY['11111111-1111-4111-8111-111111111112'::uuid],
    '22222222-2222-4222-8222-222222222222'))<>0 THEN
    RAISE EXCEPTION 'unavailable card leaked';
  END IF;
  SELECT pg_get_functiondef('miniapp_features.get_character_socials(uuid[],uuid)'::regprocedure) INTO fn;
  IF fn LIKE '%chat_history%' THEN RAISE EXCEPTION 'social read path scans chat_history'; END IF;
  IF NOT fn LIKE '%character_deep_experience_stats%' THEN RAISE EXCEPTION 'social RPC misses deep summary'; END IF;
  PERFORM set_config('enable_seqscan','off',true);
  EXECUTE 'EXPLAIN (FORMAT JSON) SELECT c.id,d.deep_session_count FROM app_core.characters c LEFT JOIN miniapp_features.character_deep_experience_stats d ON d.character_id=c.id WHERE c.id = ANY($1)' USING ARRAY['11111111-1111-4111-8111-111111111111'::uuid] INTO plan;
  IF plan::text NOT LIKE '%character_deep_experience_stats_pkey%' THEN RAISE EXCEPTION 'deep summary primary-key lookup missing: %',plan; END IF;
END $$;
RESET ROLE;
SQL
printf 'PASS: deep experience summary migration, idempotent replay, RLS/grants, bounded social aggregation and no chat_history read path\n'
