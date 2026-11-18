#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261118_db_reorg_p3c_character_listings.sql (+ _contract) as a NON-superuser with CREATEROLE:
# - expand refuses when a rewritten function differs from the production version it was written against, or when a
#   creator-function sentence it replaces is not found exactly once;
# - backfill equals the card columns; a fixed scenario (layout publish incl. restore from archive, operator create,
#   creator publish/review with and without first approval, save) gives identical results with the old functions,
#   after expand and after contract: card listing state, admin list, layout, discover/use, analytics view, audit,
#   releases and the create_character payload;
# - release window: the mirror keeps the 4 card columns equal to the listing (scenario, old-style insert with
#   listing values, new-style insert + listing update); test-card guards; cascade delete; grants; idempotent;
# - contract refuses on a function or view still reading the old columns and on card/listing divergence, then drops
#   the mirror, old CHECK/indexes/trigger function/columns; new cards get a default listing row; idempotent.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
expand="$task_root/packages/shared/migrations/20261118_db_reorg_p3c_character_listings.sql"
contract="$task_root/packages/shared/migrations/20261118_db_reorg_p3c_character_listings_contract.sql"
task_container="st-db-reorg-p3c-${RANDOM}-$$"
work_dir="$(mktemp -d)"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$work_dir"' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

# Fixture mirrors the production shape and function bodies collected on 2026-11-18 (after 3b-2).
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE cs_persona_reader NOLOGIN;
GRANT anon, authenticated, service_role, cs_persona_reader TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA admin; CREATE SCHEMA auth; CREATE SCHEMA miniapp_analytics;
CREATE SCHEMA miniapp_features; CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA app_core, admin TO service_role, authenticated;
GRANT USAGE ON SCHEMA miniapp_analytics TO cs_persona_reader;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION test_fixture.id(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('00000000-0000-0000-0000-' || lpad(p, 12, '0'))::uuid $$;

CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE app_core.character_cover_assets (id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES app_core.users(id));
CREATE TABLE app_core.characters (
  id uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL, description text NOT NULL DEFAULT ''::text,
  avatar_url text NOT NULL DEFAULT ''::text, creator_notes text NOT NULL DEFAULT ''::text,
  created_at timestamp without time zone NOT NULL DEFAULT timezone('Asia/Shanghai'::text, now()),
  updated_at timestamp without time zone NOT NULL DEFAULT timezone('Asia/Shanghai'::text, now()),
  alternate_greetings jsonb NOT NULL DEFAULT '[]'::jsonb, character_book jsonb, character_version text NOT NULL DEFAULT ''::text,
  creator text NOT NULL DEFAULT ''::text, extensions jsonb NOT NULL DEFAULT '{}'::jsonb, first_mes text NOT NULL DEFAULT ''::text,
  mes_example text NOT NULL DEFAULT ''::text, personality text NOT NULL DEFAULT ''::text,
  post_history_instructions text NOT NULL DEFAULT ''::text, scenario text NOT NULL DEFAULT ''::text,
  spec text NOT NULL DEFAULT 'chara_card_v2'::text, spec_version text NOT NULL DEFAULT '2.0'::text,
  system_prompt text NOT NULL DEFAULT ''::text, tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0, raw_card jsonb,
  archived_at timestamp without time zone, is_test boolean NOT NULL DEFAULT false, card_hash text,
  last_listed_at timestamp with time zone, character_persona_and_style text,
  CONSTRAINT characters_pkey PRIMARY KEY (id),
  CONSTRAINT characters_test_cards_disabled CHECK (((NOT is_test) OR ((enabled = false) AND (card_hash IS NOT NULL)))));
CREATE INDEX idx_characters_active_order ON app_core.characters USING btree (enabled, sort_order, created_at DESC) WHERE (archived_at IS NULL);
CREATE INDEX idx_characters_enabled_sort ON app_core.characters USING btree (enabled, sort_order) WHERE (enabled = true);
CREATE UNIQUE INDEX idx_characters_card_hash_unique ON app_core.characters USING btree (card_hash) WHERE (card_hash IS NOT NULL);
CREATE INDEX idx_characters_test_name ON app_core.characters USING btree (name) WHERE (is_test = true);
CREATE INDEX idx_characters_last_listed_at ON app_core.characters USING btree (last_listed_at DESC) WHERE (enabled AND (archived_at IS NULL));
GRANT SELECT ON app_core.characters TO service_role;
CREATE OR REPLACE FUNCTION app_core.tf_track_character_listing()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  -- 由「未上架」转为「已上架」时刷新；已在架状态下的其它更新不刷新，避免编辑角色就顶到最新页最前。
  IF NEW.enabled AND NEW.archived_at IS NULL
     AND (
       TG_OP = 'INSERT'
       OR OLD.enabled IS DISTINCT FROM TRUE
       OR OLD.archived_at IS NOT NULL
     )
  THEN
    NEW.last_listed_at := now();
  END IF;

  IF NEW.last_listed_at IS NULL THEN
    NEW.last_listed_at := COALESCE(NEW.created_at AT TIME ZONE 'Asia/Shanghai', now());
  END IF;

  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_characters_track_listing BEFORE INSERT OR UPDATE OF enabled, archived_at ON app_core.characters
  FOR EACH ROW EXECUTE FUNCTION app_core.tf_track_character_listing();

CREATE TABLE app_core.character_creations (
  character_id uuid NOT NULL REFERENCES app_core.characters(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE RESTRICT,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'), draft_runtime jsonb NOT NULL CHECK (jsonb_typeof(draft_runtime) = 'object'),
  cover_asset_id uuid REFERENCES app_core.character_cover_assets(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'draft' CHECK (state = ANY (ARRAY['draft', 'ready'])),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility = ANY (ARRAY['private', 'public'])),
  review_status text NOT NULL DEFAULT 'not_submitted' CHECK (review_status = ANY (ARRAY['not_submitted', 'pending', 'approved', 'rejected'])),
  review_message text, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0), submitted_revision integer,
  published_revision integer, approved_revision integer, submission jsonb, last_mutation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id));
CREATE TABLE app_core.character_access_grants (
  user_id uuid NOT NULL, character_id uuid NOT NULL REFERENCES app_core.characters(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, character_id));

CREATE TABLE admin.environment_config (id integer PRIMARY KEY, environment text NOT NULL);
CREATE TABLE admin.admin_users (
  user_id uuid PRIMARY KEY, email text NOT NULL, role text NOT NULL, can_access_test boolean NOT NULL DEFAULT true,
  can_access_prod boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), display_name text);
CREATE TABLE admin.audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, actor_user_id uuid, actor_email text NOT NULL, environment text NOT NULL,
  action text NOT NULL, schema_name text NOT NULL, table_name text NOT NULL, record_id text NOT NULL, before_value jsonb,
  after_value jsonb, created_at timestamptz NOT NULL DEFAULT now(), actor_name text, request_id uuid, request_digest text);
CREATE TABLE admin.character_layout_state (
  environment text PRIMARY KEY, layout_version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE admin.character_layout_drafts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  environment text NOT NULL CHECK (environment = ANY (ARRAY['test', 'production'])),
  listed_ids uuid[] NOT NULL DEFAULT '{}', delisted_ids uuid[] NOT NULL DEFAULT '{}', deleted_ids uuid[] NOT NULL DEFAULT '{}',
  base_layout_version integer NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK (status = ANY (ARRAY['draft', 'published'])),
  created_by uuid NOT NULL REFERENCES admin.admin_users(user_id), updated_by uuid NOT NULL REFERENCES admin.admin_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE TABLE admin.character_layout_releases (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, environment text NOT NULL, layout_version integer NOT NULL,
  listed_ids uuid[] NOT NULL, delisted_ids uuid[] NOT NULL, deleted_ids uuid[] NOT NULL, source_draft_id uuid,
  released_by uuid NOT NULL, released_at timestamptz NOT NULL DEFAULT now(), release_kind text NOT NULL DEFAULT 'publish',
  rollback_target_release_id uuid);
CREATE TABLE miniapp_features.character_ranking_scores (
  character_id uuid NOT NULL PRIMARY KEY, n_c integer NOT NULL DEFAULT 0, d30_raw double precision, d30_shrunk double precision,
  k_c integer NOT NULL DEFAULT 0, r48_raw double precision, score numeric NOT NULL DEFAULT 0, window_days integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(), min_users integer NOT NULL DEFAULT 20, quality_version text,
  trusted_score numeric, trusted_sample_size integer, trusted_at timestamptz);

CREATE OR REPLACE FUNCTION admin.current_environment()
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_environment TEXT;
BEGIN
  SELECT config.environment INTO v_environment FROM admin.environment_config AS config WHERE config.id = 1;
  IF NOT FOUND OR v_environment NOT IN ('test', 'production') THEN
    RAISE EXCEPTION 'admin environment is not configured' USING ERRCODE = '55000';
  END IF;
  RETURN v_environment;
END;
$function$;
CREATE OR REPLACE FUNCTION admin.can_access_environment(p_environment text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM admin.admin_users AS au
    WHERE au.user_id = auth.uid()
      AND p_environment = admin.current_environment()
      AND (
        (p_environment = 'test' AND au.can_access_test)
        OR (p_environment = 'production' AND au.can_access_prod)
      )
  );
$function$;
CREATE OR REPLACE FUNCTION admin.validate_character_layout(p_listed_ids uuid[], p_delisted_ids uuid[], p_deleted_ids uuid[])
 RETURNS void LANGUAGE plpgsql STABLE SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_all UUID[] := COALESCE(p_listed_ids, '{}') || COALESCE(p_delisted_ids, '{}') ||
                  COALESCE(p_deleted_ids, '{}');
  v_character_count INTEGER;
  v_unique_count INTEGER;
  v_test_names TEXT;
BEGIN
  SELECT string_agg(card.name, '、' ORDER BY card.name) INTO v_test_names
  FROM app_core.characters AS card
  WHERE card.is_test
    AND EXISTS (SELECT 1 FROM unnest(v_all) AS item(id) WHERE item.id = card.id);
  IF v_test_names IS NOT NULL THEN
    RAISE EXCEPTION 'character layout must not contain evaluation test cards: %', v_test_names
      USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_character_count FROM app_core.characters AS card WHERE NOT card.is_test;
  SELECT count(DISTINCT item.id) INTO v_unique_count FROM unnest(v_all) AS item(id);
  IF cardinality(v_all) <> v_character_count OR v_unique_count <> v_character_count
     OR EXISTS (
       SELECT 1 FROM unnest(v_all) AS item(id)
       WHERE NOT EXISTS (SELECT 1 FROM app_core.characters AS card WHERE card.id = item.id)
     ) THEN
    RAISE EXCEPTION 'character layout must partition every character exactly once'
      USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- Old functions verbatim from production (get_characters / get_character_layout get CRLF below, as in production).
CREATE OR REPLACE FUNCTION admin.get_characters()
 RETURNS TABLE(id uuid, name text, description text, avatar_url text, tags jsonb, creator text, first_mes text, creator_notes text, enabled boolean, sort_order integer, archived_at timestamp without time zone, created_at timestamp without time zone, updated_at timestamp without time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT card.id, card.name, card.description, card.avatar_url, card.tags,
         card.creator, card.first_mes, card.creator_notes, card.enabled,
         card.sort_order, card.archived_at, card.created_at, card.updated_at
  FROM app_core.characters AS card
  WHERE NOT card.is_test
  ORDER BY (card.archived_at IS NOT NULL), card.enabled DESC,
           card.sort_order ASC, card.created_at DESC;
END;
$function$;
CREATE OR REPLACE FUNCTION admin.get_character_layout()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_environment TEXT := admin.current_environment();
  v_version INTEGER;
  v_draft admin.character_layout_drafts%ROWTYPE;
  v_listed UUID[];
  v_delisted UUID[];
  v_deleted UUID[];
BEGIN
  IF NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(state.layout_version, 0) INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment;
  v_version := COALESCE(v_version, 0);

  SELECT COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC), '{}')
    INTO v_listed
  FROM app_core.characters AS card
  WHERE card.enabled AND card.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY card.sort_order, card.created_at DESC), '{}')
    INTO v_delisted
  FROM app_core.characters AS card
  WHERE NOT card.enabled AND card.archived_at IS NULL AND NOT card.is_test;
  SELECT COALESCE(array_agg(card.id ORDER BY card.archived_at DESC, card.created_at DESC), '{}')
    INTO v_deleted
  FROM app_core.characters AS card
  WHERE card.archived_at IS NOT NULL AND NOT card.is_test;

  SELECT draft.* INTO v_draft
  FROM admin.character_layout_drafts AS draft
  WHERE draft.environment = v_environment AND draft.status = 'draft'
  ORDER BY draft.updated_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'layout_version', v_version,
    'published', jsonb_build_object(
      'listed_ids', to_jsonb(v_listed),
      'delisted_ids', to_jsonb(v_delisted),
      'deleted_ids', to_jsonb(v_deleted)
    ),
    'draft', CASE WHEN v_draft.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_draft.id,
      'listed_ids', to_jsonb(v_draft.listed_ids),
      'delisted_ids', to_jsonb(v_draft.delisted_ids),
      'deleted_ids', to_jsonb(v_draft.deleted_ids),
      'base_layout_version', v_draft.base_layout_version,
      'updated_at', v_draft.updated_at
    ) END
  );
END;
$function$;
CREATE OR REPLACE FUNCTION admin.publish_character_layout_draft(p_draft_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_draft admin.character_layout_drafts%ROWTYPE;
  v_version INTEGER;
  v_before JSONB;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));
  SELECT draft.* INTO v_draft
  FROM admin.character_layout_drafts AS draft
  WHERE draft.id = p_draft_id AND draft.environment = v_environment AND draft.status = 'draft'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active character layout draft not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM admin.validate_character_layout(v_draft.listed_ids, v_draft.delisted_ids, v_draft.deleted_ids);

  INSERT INTO admin.character_layout_state(environment)
  VALUES (v_environment) ON CONFLICT (environment) DO NOTHING;
  SELECT state.layout_version INTO v_version
  FROM admin.character_layout_state AS state
  WHERE state.environment = v_environment FOR UPDATE;
  IF v_draft.base_layout_version <> v_version THEN
    RAISE EXCEPTION 'character layout version changed; refresh before publishing'
      USING ERRCODE = '40001';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'id', card.id, 'enabled', card.enabled, 'sort_order', card.sort_order,
    'archived_at', card.archived_at
  ) ORDER BY card.id) INTO v_before FROM app_core.characters AS card;

  UPDATE app_core.characters AS card
  SET enabled = true, archived_at = NULL, sort_order = ordered.position - 1,
      updated_at = timezone('Asia/Shanghai', now())
  FROM unnest(v_draft.listed_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE card.id = ordered.id;

  UPDATE app_core.characters AS card
  SET enabled = false, archived_at = NULL,
      updated_at = timezone('Asia/Shanghai', now())
  WHERE card.id = ANY(v_draft.delisted_ids);

  UPDATE app_core.characters AS card
  SET enabled = false,
      archived_at = COALESCE(card.archived_at, timezone('Asia/Shanghai', now())),
      updated_at = timezone('Asia/Shanghai', now())
  WHERE card.id = ANY(v_draft.deleted_ids);

  v_version := v_version + 1;
  UPDATE admin.character_layout_state
  SET layout_version = v_version, updated_at = now()
  WHERE environment = v_environment;
  UPDATE admin.character_layout_drafts
  SET status = 'published', published_at = now(), updated_at = now()
  WHERE id = v_draft.id;
  INSERT INTO admin.character_layout_releases(
    environment, layout_version, listed_ids, delisted_ids, deleted_ids,
    source_draft_id, released_by
  ) VALUES (
    v_environment, v_version, v_draft.listed_ids, v_draft.delisted_ids,
    v_draft.deleted_ids, v_draft.id, v_actor.user_id
  );
  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.layout.publish',
    'app_core', 'characters', v_version::TEXT, v_before,
    jsonb_build_object('layout_version', v_version, 'listed_ids', v_draft.listed_ids,
                       'delisted_ids', v_draft.delisted_ids, 'deleted_ids', v_draft.deleted_ids)
  );
  RETURN v_version;
END;
$function$;
CREATE OR REPLACE FUNCTION admin.create_character(p_name text, p_description text DEFAULT ''::text, p_avatar_url text DEFAULT ''::text, p_tags jsonb DEFAULT '[]'::jsonb, p_creator text DEFAULT ''::text, p_first_mes text DEFAULT ''::text, p_creator_notes text DEFAULT ''::text, p_personality text DEFAULT ''::text, p_scenario text DEFAULT ''::text, p_system_prompt text DEFAULT ''::text, p_mes_example text DEFAULT ''::text)
 RETURNS app_core.characters
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_environment TEXT := admin.current_environment();
  v_character app_core.characters%ROWTYPE;
  v_next_order INTEGER;
  v_now TIMESTAMP WITHOUT TIME ZONE := timezone('Asia/Shanghai', now());
BEGIN
  SELECT actor.* INTO v_actor
  FROM admin.admin_users AS actor
  WHERE actor.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  p_name := btrim(COALESCE(p_name, ''));
  p_description := btrim(COALESCE(p_description, ''));
  p_avatar_url := btrim(COALESCE(p_avatar_url, ''));
  p_creator := btrim(COALESCE(p_creator, ''));

  IF length(p_name) < 1 OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'character name must contain 1 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF length(p_description) > 4000 OR length(COALESCE(p_first_mes, '')) > 20000
     OR length(COALESCE(p_creator_notes, '')) > 20000
     OR length(COALESCE(p_personality, '')) > 20000
     OR length(COALESCE(p_scenario, '')) > 20000
     OR length(COALESCE(p_system_prompt, '')) > 30000
     OR length(COALESCE(p_mes_example, '')) > 30000 THEN
    RAISE EXCEPTION 'character text field exceeds the allowed length'
      USING ERRCODE = '22023';
  END IF;
  IF p_avatar_url <> '' AND p_avatar_url !~* '^https://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'avatar URL must be an HTTPS URL' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_tags, '[]'::JSONB)) IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_tags, '[]'::JSONB)) AS tag(value)
       WHERE jsonb_typeof(tag.value) IS DISTINCT FROM 'string'
          OR length(btrim(tag.value #>> '{}')) > 40
     ) THEN
    RAISE EXCEPTION 'tags must be an array of strings up to 40 characters'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('admin.character_layout:' || v_environment));
  SELECT LEAST(COALESCE(max(card.sort_order), -1) + 1, 2147483646) INTO v_next_order
  FROM app_core.characters AS card
  WHERE card.sort_order < 2147483647;

  INSERT INTO app_core.characters(
    name, description, avatar_url, tags, creator, first_mes, creator_notes,
    personality, scenario, system_prompt, mes_example,
    enabled, archived_at, sort_order, spec, spec_version, raw_card,
    created_at, updated_at
  ) VALUES (
    p_name, p_description, p_avatar_url, COALESCE(p_tags, '[]'::JSONB),
    p_creator, COALESCE(p_first_mes, ''), COALESCE(p_creator_notes, ''),
    COALESCE(p_personality, ''), COALESCE(p_scenario, ''),
    COALESCE(p_system_prompt, ''), COALESCE(p_mes_example, ''),
    false, NULL, v_next_order, 'chara_card_v2', '2.0',
    jsonb_build_object(
      'spec', 'chara_card_v2',
      'spec_version', '2.0',
      'data', jsonb_build_object(
        'name', p_name,
        'description', p_description,
        'personality', COALESCE(p_personality, ''),
        'scenario', COALESCE(p_scenario, ''),
        'first_mes', COALESCE(p_first_mes, ''),
        'mes_example', COALESCE(p_mes_example, ''),
        'creator_notes', COALESCE(p_creator_notes, ''),
        'system_prompt', COALESCE(p_system_prompt, ''),
        'tags', COALESCE(p_tags, '[]'::JSONB),
        'creator', p_creator
      )
    ),
    v_now, v_now
  ) RETURNING * INTO v_character;

  UPDATE admin.character_layout_drafts AS draft
  SET delisted_ids = draft.delisted_ids || v_character.id,
      updated_by = v_actor.user_id,
      updated_at = now()
  WHERE draft.environment = v_environment
    AND draft.status = 'draft'
    AND NOT v_character.id = ANY(
      draft.listed_ids || draft.delisted_ids || draft.deleted_ids
    );

  INSERT INTO admin.audit_logs(
    actor_user_id, actor_email, environment, action, schema_name,
    table_name, record_id, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, v_environment, 'character.create',
    'app_core', 'characters', v_character.id::TEXT,
    jsonb_build_object(
      'id', v_character.id,
      'name', v_character.name,
      'enabled', v_character.enabled,
      'sort_order', v_character.sort_order,
      'avatar_url', v_character.avatar_url,
      'draft_state', 'delisted'
    )
  );

  RETURN v_character;
END;
$function$;
CREATE OR REPLACE FUNCTION app_core.can_discover_character(p_character_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT EXISTS(SELECT 1 FROM app_core.characters c LEFT JOIN app_core.character_creations cr ON cr.character_id=c.id
 WHERE c.id=p_character_id AND c.enabled AND c.archived_at IS NULL
 AND (cr.character_id IS NULL OR (cr.state='ready' AND cr.visibility='public' AND cr.approved_revision IS NOT NULL)))
$function$;
CREATE OR REPLACE FUNCTION app_core.can_use_character(p_user_id uuid, p_character_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
 SELECT EXISTS(SELECT 1 FROM app_core.characters c LEFT JOIN app_core.character_creations cr ON cr.character_id=c.id
 WHERE c.id=p_character_id AND c.enabled AND c.archived_at IS NULL AND (
 cr.character_id IS NULL OR cr.owner_user_id=p_user_id OR
 (cr.state='ready' AND ((cr.visibility='public' AND cr.approved_revision IS NOT NULL) OR
 EXISTS(SELECT 1 FROM app_core.character_access_grants g WHERE g.character_id=c.id AND g.user_id=p_user_id)))))
$function$;
CREATE OR REPLACE FUNCTION app_core.mutate_creator_character(p_user_id uuid, p_character_id uuid, p_action text, p_expected_revision integer, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r app_core.character_creations; next_revision integer; cover uuid; mutation jsonb;
BEGIN
 IF p_user_id IS NULL OR p_character_id IS NULL OR p_action NOT IN ('create','save','publish','visibility') OR p_payload IS NULL THEN
   RAISE EXCEPTION 'invalid creator mutation' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('creator:'||p_character_id::text,0));
 IF p_action='create' THEN
   SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id;
   IF FOUND THEN
     IF r.owner_user_id<>p_user_id THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
     RETURN to_jsonb(r);
   END IF;
   IF EXISTS(SELECT 1 FROM app_core.characters WHERE id=p_character_id) THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
   IF (SELECT count(*) FROM app_core.character_creations WHERE owner_user_id=p_user_id AND created_at>now()-interval '1 hour')>=30 THEN
     RAISE EXCEPTION 'creation rate limit' USING ERRCODE='P0429';
   END IF;
   cover:=(p_payload->>'cover_asset_id')::uuid;
   IF cover IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_core.character_cover_assets WHERE id=cover AND owner_user_id=p_user_id) THEN
     RAISE EXCEPTION 'cover unavailable' USING ERRCODE='P0404';
   END IF;
   INSERT INTO app_core.characters(id,name,enabled,sort_order) VALUES(p_character_id,'',true,2147483647);
   INSERT INTO app_core.character_creations(character_id,owner_user_id,draft,draft_runtime,cover_asset_id)
   VALUES(p_character_id,p_user_id,p_payload->'draft',p_payload->'runtime',cover) RETURNING * INTO r;
   RETURN to_jsonb(r);
 END IF;
 PERFORM 1 FROM app_core.characters WHERE id=p_character_id FOR UPDATE;
 SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id FOR UPDATE;
 IF NOT FOUND OR r.owner_user_id<>p_user_id THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 -- Idempotency is the client intent. A server preset asset update must not change a replay.
 mutation:=jsonb_build_object('action',p_action,'expected_revision',p_expected_revision,'payload',p_payload-'runtime'-'review');
 IF r.last_mutation=mutation THEN RETURN to_jsonb(r); END IF;
 IF p_expected_revision IS NULL OR r.revision<>p_expected_revision THEN RAISE EXCEPTION 'revision conflict' USING ERRCODE='P0409'; END IF;
 next_revision:=r.revision+1;
 IF p_action='save' THEN
   cover:=(p_payload->>'cover_asset_id')::uuid;
   IF cover IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_core.character_cover_assets WHERE id=cover AND owner_user_id=p_user_id) THEN
     RAISE EXCEPTION 'cover unavailable' USING ERRCODE='P0404';
   END IF;
   r.draft:=p_payload->'draft'; r.draft_runtime:=p_payload->'runtime'; r.cover_asset_id:=cover;
   -- Edits invalidate the pending review. Approved runtime itself is intentionally untouched.
   r.review_status:='not_submitted'; r.review_message:=NULL; r.submission:=NULL; r.submitted_revision:=NULL;
 ELSE
   IF p_payload->>'visibility' NOT IN ('private','public') THEN RAISE EXCEPTION 'invalid visibility' USING ERRCODE='22023'; END IF;
   IF p_action='visibility' AND r.state<>'ready' THEN RAISE EXCEPTION 'publish first' USING ERRCODE='22023'; END IF;
   IF p_action='publish' OR p_payload->>'visibility'='public' THEN
     IF r.cover_asset_id IS NULL OR btrim(coalesce(r.draft->>'name',''))='' OR btrim(coalesce(r.draft->>'description',''))=''
       OR btrim(coalesce(r.draft->>'opening',''))='' OR jsonb_array_length(r.draft->'tags')=0
       OR (btrim(coalesce(r.draft->>'background',''))='' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.draft->'backgroundFiles') f WHERE btrim(coalesce(f->>'content',''))<>'')) THEN
       RAISE EXCEPTION 'required fields missing' USING ERRCODE='22023';
     END IF;
   END IF;
   r.visibility:=p_payload->>'visibility';
   IF r.visibility='public' THEN
     r.state:='ready'; r.review_status:='pending'; r.review_message:=NULL;
     r.submitted_revision:=next_revision;
     r.submission:=jsonb_build_object('draft',r.draft,'runtime',r.draft_runtime,'cover_asset_id',r.cover_asset_id);
     -- Only the trusted backend may attach a validated AI result. Old backends keep pending.
     IF p_payload ? 'review' THEN
       IF jsonb_typeof(p_payload->'review') IS DISTINCT FROM 'object' THEN
         RAISE EXCEPTION 'invalid creator review result' USING ERRCODE='22023';
       END IF;
       IF (SELECT count(*) FROM jsonb_object_keys(p_payload->'review'))<>2
         OR jsonb_typeof(p_payload->'review'->'approved') IS DISTINCT FROM 'boolean'
         OR p_payload->'review'->'approved'<>'true'::jsonb
         OR jsonb_typeof(p_payload->'review'->'reason') IS DISTINCT FROM 'string'
         OR btrim(p_payload->'review'->>'reason')=''
         OR char_length(p_payload->'review'->>'reason')>1000 THEN
         RAISE EXCEPTION 'invalid creator review result' USING ERRCODE='22023';
       END IF;
       r.review_status:='approved'; r.approved_revision:=next_revision;
       r.submission:=r.submission||jsonb_build_object('review',p_payload->'review');
     END IF;
   ELSE
     r.review_status:='not_submitted'; r.review_message:=NULL; r.submitted_revision:=NULL; r.submission:=NULL;
     r.approved_revision:=NULL;
   END IF;
   -- AI-reviewed publication updates only the card; existing conversation snapshots stay immutable.
   IF (r.visibility='public' AND r.review_status='approved')
     OR (p_action='publish' AND r.visibility='private') OR r.published_revision IS NULL THEN
     UPDATE app_core.characters SET name=r.draft_runtime->>'name',description=r.draft_runtime->>'description',
       first_mes=r.draft_runtime->>'first_mes',system_prompt=r.draft_runtime->>'system_prompt',tags=r.draft->'tags',
       avatar_url=CASE WHEN r.cover_asset_id IS NULL THEN '' ELSE 'creator-cover:'||r.cover_asset_id::text END,
       last_listed_at=CASE WHEN r.visibility='public' AND r.review_status='approved'
         AND (SELECT approved_revision IS NULL FROM app_core.character_creations WHERE character_id=p_character_id)
         THEN now() ELSE last_listed_at END,
       updated_at=now() WHERE id=p_character_id;
     r.state:='ready'; r.published_revision:=next_revision;
     IF r.visibility='private' OR r.review_status<>'approved' THEN r.approved_revision:=NULL; END IF;
   END IF;
 END IF;
 UPDATE app_core.character_creations SET draft=r.draft,draft_runtime=r.draft_runtime,cover_asset_id=r.cover_asset_id,
 state=r.state,visibility=r.visibility,review_status=r.review_status,review_message=r.review_message,
 revision=next_revision,submitted_revision=r.submitted_revision,published_revision=r.published_revision,
 approved_revision=r.approved_revision,submission=r.submission,last_mutation=mutation,updated_at=now()
 WHERE character_id=p_character_id RETURNING * INTO r;
 RETURN to_jsonb(r);
END $function$;
CREATE OR REPLACE FUNCTION app_core.review_creator_character(p_admin_user_id uuid, p_character_id uuid, p_submitted_revision integer, p_decision text, p_reason text, p_environment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE r app_core.character_creations; actor admin.admin_users; runtime jsonb; approved_cover uuid;
BEGIN
 SELECT * INTO actor FROM admin.admin_users WHERE user_id=p_admin_user_id AND role IN ('owner','operator');
 IF NOT FOUND OR p_environment NOT IN ('test','production') OR
   (p_environment='production' AND NOT actor.can_access_prod) OR (p_environment='test' AND NOT actor.can_access_test) THEN
   RAISE EXCEPTION 'operator required' USING ERRCODE='42501';
 END IF;
 IF p_decision NOT IN ('approve','reject') OR (p_decision='reject' AND btrim(coalesce(p_reason,''))='') OR char_length(coalesce(p_reason,''))>1000 THEN
   RAISE EXCEPTION 'invalid review' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM app_core.characters WHERE id=p_character_id FOR UPDATE;
 SELECT * INTO r FROM app_core.character_creations WHERE character_id=p_character_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'character unavailable' USING ERRCODE='P0404'; END IF;
 IF r.review_status<>'pending' OR r.submitted_revision IS DISTINCT FROM p_submitted_revision OR r.revision<>p_submitted_revision OR r.visibility<>'public' THEN
   RAISE EXCEPTION 'submission changed' USING ERRCODE='P0409';
 END IF;
 IF p_decision='approve' THEN
   runtime:=r.submission->'runtime'; approved_cover:=(r.submission->>'cover_asset_id')::uuid;
   UPDATE app_core.characters SET name=runtime->>'name',description=runtime->>'description',first_mes=runtime->>'first_mes',
     system_prompt=runtime->>'system_prompt',tags=r.submission->'draft'->'tags',avatar_url='creator-cover:'||approved_cover::text,
     last_listed_at=CASE WHEN r.approved_revision IS NULL THEN now() ELSE last_listed_at END,updated_at=now()
   WHERE id=p_character_id;
   r.published_revision:=p_submitted_revision; r.approved_revision:=p_submitted_revision;
 END IF;
 UPDATE app_core.character_creations SET review_status=CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END,
   review_message=CASE WHEN p_decision='reject' THEN p_reason ELSE NULL END,
   published_revision=r.published_revision,approved_revision=r.approved_revision,revision=revision+1,last_mutation=NULL,updated_at=now()
 WHERE character_id=p_character_id RETURNING * INTO r;
 INSERT INTO admin.audit_logs(actor_user_id,actor_email,environment,action,schema_name,table_name,record_id,after_value)
 VALUES(actor.user_id,actor.email,p_environment,'character.creator.'||p_decision,'app_core','character_creations',p_character_id::text,
   jsonb_build_object('submitted_revision',p_submitted_revision,'decision',p_decision,'reason',p_reason));
 RETURN to_jsonb(r);
END $function$;
-- The three 0-call operator functions (bodies reduced; dropped by expand).
CREATE FUNCTION admin.archive_character(p_id uuid) RETURNS void LANGUAGE sql AS
  $$ UPDATE app_core.characters SET enabled = false, archived_at = timezone('Asia/Shanghai', now()) WHERE id = p_id $$;
CREATE FUNCTION admin.set_character_enabled(p_id uuid, p_enabled boolean) RETURNS void LANGUAGE sql AS
  $$ UPDATE app_core.characters SET enabled = p_enabled WHERE id = p_id $$;
CREATE FUNCTION admin.reorder_characters(p_ids uuid[]) RETURNS void LANGUAGE sql AS
  $$ UPDATE app_core.characters c SET sort_order = o.n - 1 FROM unnest(p_ids) WITH ORDINALITY o(id, n) WHERE c.id = o.id $$;
REVOKE ALL ON FUNCTION admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text) TO authenticated, service_role;

-- Production stores these two bodies with CRLF line endings; the expand guard compares md5(prosrc).
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_src text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['admin.get_characters()'::regprocedure, 'admin.get_character_layout()'::regprocedure] LOOP
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
    EXECUTE replace(pg_get_functiondef(v_fn), v_src, replace(v_src, E'\n', E'\r\n'));
  END LOOP;
END
$crlf$;

CREATE VIEW miniapp_analytics.v_card_quality_session AS
 SELECT c.name,
    c.id,
    c.enabled,
    c.sort_order,
    COALESCE(s.n_c, 0) AS user_cnt,
    COALESCE(s.k_c, 0) AS r48_eligible_user_cnt,
    round(s.d30_shrunk::numeric, 4) AS d30_score,
    round(s.r48_raw::numeric, 4) AS r48_score,
    s.score AS final_score,
    s.window_days,
    s.computed_at,
        CASE
            WHEN s.n_c >= 20 AND s.d30_shrunk IS NOT NULL THEN round((100.0::double precision * (0.75::double precision * GREATEST(0.0::double precision, LEAST(1.0::double precision, (s.d30_shrunk - 0.407823074175645::double precision) / (0.543018423396861 - 0.407823074175645)::double precision)) + 0.25::double precision * (LEAST(s.k_c::numeric / 40.0, 1.0)::double precision *
            CASE
                WHEN s.r48_raw IS NULL THEN 0.5::double precision
                ELSE GREATEST(0.0::double precision, LEAST(1.0::double precision, (s.r48_raw - 0.10605434609884::double precision) / (0.20198105081826 - 0.10605434609884)::double precision))
            END + (1.0::double precision - LEAST(s.k_c::numeric / 40.0, 1.0)::double precision) * 0.5::double precision)))::numeric, 2)
            ELSE NULL::numeric
        END AS absolute_score,
    c.last_listed_at
   FROM app_core.characters c
     LEFT JOIN miniapp_features.character_ranking_scores s ON s.character_id = c.id
  WHERE c.enabled = true
  ORDER BY s.score DESC NULLS LAST, s.d30_shrunk DESC NULLS LAST, s.r48_raw DESC NULLS LAST, s.n_c DESC NULLS LAST, c.id;
GRANT SELECT ON miniapp_analytics.v_card_quality_session TO cs_persona_reader;

-- pg_cron stand-in (Supabase: postgres may only change jobs through cron.alter_job). Job text as in production.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text NOT NULL, command text NOT NULL,
  active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS
  $$ UPDATE cron.job j SET command = COALESCE(alter_job.command, j.command) WHERE j.jobid = alter_job.job_id $$;
CREATE TABLE miniapp_analytics.card_position_snapshot (snapshot_at timestamptz NOT NULL DEFAULT now(),
  character_id uuid NOT NULL, name text, sort_order integer, enabled boolean);
INSERT INTO cron.job VALUES (5, 'card_position_hourly_snapshot', '0 * * * *',
E'INSERT INTO miniapp_analytics.card_position_snapshot (character_id, name, sort_order, enabled)\n    SELECT id, name, sort_order, enabled FROM app_core.characters\n    WHERE enabled = true AND COALESCE(is_test,false) = false AND archived_at IS NULL');

DO $md5$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('admin.get_characters()', '4f07ba1b25c8f7d33e1665df218d3288'),
    ('admin.get_character_layout()', 'bb2b7e2b2dda2e9448e54a4db73afc2d'),
    ('admin.publish_character_layout_draft(uuid)', 'fffac1b197945dd3eb6854b184cc3fd7'),
    ('admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)', '9203391ec9ef1cdcde800d33a0cbfd0b'),
    ('app_core.can_discover_character(uuid)', 'fd5b9c5d4764da03b28665bddda0506c'),
    ('app_core.can_use_character(uuid,uuid)', '9bc52831ca37bbf6d1c44ec19f510fa8'),
    ('app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)', '37f2e03d5c4ffc45881dbbb6a5b0039b'),
    ('app_core.review_creator_character(uuid,uuid,integer,text,text,text)', '6a07e09bab6e15b11c78cf7e1161287c')
  ) AS t(fn, md5sum) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(r.fn)) <> r.md5sum THEN
      RAISE EXCEPTION 'fixture % does not match the production body', r.fn;
    END IF;
  END LOOP;
END
$md5$;

-- Seed ---------------------------------------------------------------------------------------------------------
INSERT INTO admin.environment_config VALUES (1, 'test');
INSERT INTO app_core.users VALUES (test_fixture.id('a001')), (test_fixture.id('a002')), (test_fixture.id('a003')), (test_fixture.id('a0ad'));
INSERT INTO admin.admin_users (user_id, email, role, can_access_test, can_access_prod)
  VALUES (test_fixture.id('a0ad'), 'owner@example.test', 'owner', true, false);
INSERT INTO admin.character_layout_state VALUES ('test', 3, now());
INSERT INTO app_core.character_cover_assets VALUES (test_fixture.id('cc01'), test_fixture.id('a001')), (test_fixture.id('cc02'), test_fixture.id('a002'));
INSERT INTO app_core.characters (id, name, created_at, updated_at, enabled, sort_order, archived_at, is_test, card_hash, tags, creator)
SELECT test_fixture.id(k), '官方' || k, timestamp '2026-09-01 10:00' + n * interval '1 day',
       timestamp '2026-10-01 10:00' + n * interval '1 day', en, so, arch, false, 'hash-' || k, jsonb_build_array('标签' || k), '作者'
FROM (VALUES ('1', 1, true, 0, NULL::timestamp), ('2', 2, true, 1, NULL), ('3', 3, true, 2, NULL), ('4', 4, true, 3, NULL),
             ('5', 5, true, 4, NULL), ('6', 6, true, 5, NULL), ('7', 7, false, 6, NULL), ('8', 8, false, 7, NULL),
             ('9', 9, false, 8, timestamp '2026-10-20 09:00'), ('a', 10, false, 9, timestamp '2026-10-10 09:00')) AS v(k, n, en, so, arch);
INSERT INTO app_core.characters (id, name, enabled, is_test, card_hash)
VALUES (test_fixture.id('f1'), '测试一', false, true, 'test-hash-1'), (test_fixture.id('f2'), '测试二', false, true, 'test-hash-2');
UPDATE app_core.characters SET last_listed_at = (created_at AT TIME ZONE 'Asia/Shanghai') + interval '3 days';

CREATE FUNCTION test_fixture.creator_payload(p_name text, p_cover uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'draft', jsonb_build_object('name', p_name, 'description', p_name || '简介', 'opening', p_name || '开场',
                                'tags', jsonb_build_array('创作'), 'background', p_name || '背景'),
    'runtime', jsonb_build_object('name', p_name, 'description', p_name || '简介', 'first_mes', p_name || '开场',
                                  'system_prompt', p_name || '设定'),
    'cover_asset_id', p_cover) $$;
DO $seed$
DECLARE
  u1 uuid := test_fixture.id('a001');
  u2 uuid := test_fixture.id('a002');
  k1 uuid := test_fixture.id('cc01');
  k2 uuid := test_fixture.id('cc02');
  approve constant jsonb := '{"visibility":"public","review":{"approved":true,"reason":"ok"}}';
BEGIN
  -- c1 draft (first approval in scenario), c2 pending first review, c3 approved, c4 approved then pending again,
  -- c5 private draft, c6 published private + granted to u3.
  PERFORM app_core.mutate_creator_character(u1, test_fixture.id('c1'), 'create', NULL, test_fixture.creator_payload('创作一', k1));
  PERFORM app_core.mutate_creator_character(u1, test_fixture.id('c2'), 'create', NULL, test_fixture.creator_payload('创作二', k1));
  PERFORM app_core.mutate_creator_character(u1, test_fixture.id('c2'), 'publish', 1, '{"visibility":"public"}');
  PERFORM app_core.mutate_creator_character(u2, test_fixture.id('c3'), 'create', NULL, test_fixture.creator_payload('创作三', k2));
  PERFORM app_core.mutate_creator_character(u2, test_fixture.id('c3'), 'publish', 1, approve);
  PERFORM app_core.mutate_creator_character(u2, test_fixture.id('c4'), 'create', NULL, test_fixture.creator_payload('创作四', k2));
  PERFORM app_core.mutate_creator_character(u2, test_fixture.id('c4'), 'publish', 1, approve);
  PERFORM app_core.mutate_creator_character(u2, test_fixture.id('c4'), 'publish', 2, '{"visibility":"public"}');
  PERFORM app_core.mutate_creator_character(u1, test_fixture.id('c5'), 'create', NULL, test_fixture.creator_payload('创作五', k1));
  PERFORM app_core.mutate_creator_character(u2, test_fixture.id('c6'), 'create', NULL, test_fixture.creator_payload('创作六', k2));
  PERFORM app_core.mutate_creator_character(u2, test_fixture.id('c6'), 'publish', 1, '{"visibility":"private"}');
END
$seed$;
UPDATE app_core.characters SET last_listed_at = timestamptz '2026-11-01 00:00+00' + (ascii(right(id::text, 1)) - 48) * interval '1 hour',
  updated_at = timestamp '2026-11-02 00:00' + (ascii(right(id::text, 1)) - 48) * interval '1 hour',
  created_at = timestamp '2026-10-25 00:00' + (ascii(right(id::text, 1)) - 48) * interval '1 hour'
WHERE id::text LIKE '%c_';
UPDATE app_core.character_creations SET created_at = timestamptz '2026-10-25 00:00+00', updated_at = timestamptz '2026-11-02 00:00+00';
INSERT INTO app_core.character_access_grants (user_id, character_id) VALUES (test_fixture.id('a003'), test_fixture.id('c6'));
INSERT INTO miniapp_features.character_ranking_scores (character_id, n_c, d30_shrunk, k_c, r48_raw, score, window_days)
VALUES (test_fixture.id('1'), 30, 0.5, 12, 0.15, 0.8, 30), (test_fixture.id('2'), 5, NULL, 1, NULL, 0.2, 30),
       (test_fixture.id('c3'), 25, 0.45, 40, 0.18, 0.6, 30);

-- Scenario helpers: read the listing state wherever it lives; normalise "now" so runs at different times compare.
CREATE FUNCTION test_fixture.nts(x timestamp) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT CASE WHEN x IS NULL THEN NULL WHEN x IN (timezone('Asia/Shanghai', now()), localtimestamp) THEN 'now' ELSE x::text END $$;
CREATE FUNCTION test_fixture.ntz(x timestamptz) RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT CASE WHEN x IS NULL THEN NULL WHEN x = now() THEN 'now' ELSE x::text END $$;
CREATE FUNCTION test_fixture.listing_state()
RETURNS TABLE(id uuid, enabled boolean, sort_order integer, archived_at timestamp, last_listed_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF to_regclass('app_core.character_listings') IS NULL THEN
    RETURN QUERY EXECUTE 'SELECT id, enabled, sort_order, archived_at, last_listed_at FROM app_core.characters';
  ELSE
    RETURN QUERY EXECUTE 'SELECT character_id, enabled, sort_order, archived_at, last_listed_at FROM app_core.character_listings';
  END IF;
END $$;
CREATE FUNCTION test_fixture.snapshot() RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  -- Listing state comes from listing_state() (characters before expand, character_listings after).
  PERFORM set_config('test.uid', test_fixture.id('a0ad')::text, true);
  RETURN jsonb_build_object(
    'cards', (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'enabled', s.enabled, 'sort', s.sort_order,
                'archived', test_fixture.nts(s.archived_at), 'listed', test_fixture.ntz(s.last_listed_at),
                'name', c.name, 'avatar', c.avatar_url, 'test', c.is_test) ORDER BY s.id)
              FROM test_fixture.listing_state() s JOIN app_core.characters c ON c.id = s.id),
    'admin_list', (SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'enabled', g.enabled, 'sort', g.sort_order,
                'archived', test_fixture.nts(g.archived_at), 'created', test_fixture.nts(g.created_at),
                'updated', test_fixture.nts(g.updated_at), 'tags', g.tags, 'creator', g.creator) ORDER BY g.ord)
              FROM admin.get_characters() WITH ORDINALITY AS g(id, name, description, avatar_url, tags, creator, first_mes,
                creator_notes, enabled, sort_order, archived_at, created_at, updated_at, ord)),
    'layout', admin.get_character_layout(),
    'discover', (SELECT jsonb_object_agg(c.id, app_core.can_discover_character(c.id)) FROM app_core.characters c),
    'use', (SELECT jsonb_object_agg(c.id::text || '|' || u.id::text, app_core.can_use_character(u.id, c.id))
            FROM app_core.characters c CROSS JOIN app_core.users u),
    'view', (SELECT jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'enabled', v.enabled, 'sort', v.sort_order,
               'listed', test_fixture.ntz(v.last_listed_at), 'final', v.final_score, 'abs', v.absolute_score) ORDER BY v.id)
             FROM miniapp_analytics.v_card_quality_session v));
END $$;
CREATE FUNCTION test_fixture.revision(p uuid) RETURNS integer LANGUAGE sql STABLE AS
  $$ SELECT revision FROM app_core.character_creations WHERE character_id = p $$;
CREATE FUNCTION test_fixture.run_scenario() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  c_owner constant uuid := test_fixture.id('a0ad');
  c_draft constant uuid := test_fixture.id('d1');
  approve constant jsonb := '{"visibility":"public","review":{"approved":true,"reason":"again"}}';
  v_initial jsonb;
  v_new jsonb;
  v_out jsonb;
BEGIN
  v_initial := test_fixture.snapshot();
  PERFORM set_config('test.uid', c_owner::text, true);
  -- Layout draft: reorder, restore 9 from archive, delist 4/5, archive 6; creator cards stay listed.
  INSERT INTO admin.character_layout_drafts (id, environment, listed_ids, delisted_ids, deleted_ids, base_layout_version, created_by, updated_by)
  VALUES (c_draft, 'test',
    ARRAY[test_fixture.id('3'), test_fixture.id('1'), test_fixture.id('9'), test_fixture.id('2'), test_fixture.id('7'),
          test_fixture.id('c1'), test_fixture.id('c2'), test_fixture.id('c3'), test_fixture.id('c4'), test_fixture.id('c5'), test_fixture.id('c6')],
    ARRAY[test_fixture.id('4'), test_fixture.id('5'), test_fixture.id('8')],
    ARRAY[test_fixture.id('6'), test_fixture.id('a')], 3, c_owner, c_owner);
  -- Operator create appends the new card to the active draft's delisted list.
  v_new := to_jsonb(admin.create_character('新卡甲', '新卡简介', '', '["新"]'::jsonb, '运营'));
  PERFORM admin.publish_character_layout_draft(c_draft);
  PERFORM app_core.mutate_creator_character(test_fixture.id('a001'), test_fixture.id('c1'), 'publish',
    test_fixture.revision(test_fixture.id('c1')), approve);
  PERFORM app_core.review_creator_character(c_owner, test_fixture.id('c2'), test_fixture.revision(test_fixture.id('c2')), 'approve', NULL, 'test');
  PERFORM app_core.mutate_creator_character(test_fixture.id('a002'), test_fixture.id('c3'), 'publish',
    test_fixture.revision(test_fixture.id('c3')), approve);
  PERFORM app_core.review_creator_character(c_owner, test_fixture.id('c4'), test_fixture.revision(test_fixture.id('c4')), 'approve', NULL, 'test');
  PERFORM app_core.mutate_creator_character(test_fixture.id('a001'), test_fixture.id('c5'), 'save',
    test_fixture.revision(test_fixture.id('c5')), test_fixture.creator_payload('创作五改', test_fixture.id('cc01')));
  EXECUTE (SELECT command FROM cron.job WHERE jobname = 'card_position_hourly_snapshot');
  v_out := jsonb_build_object(
    'position_snapshot', (SELECT jsonb_agg(jsonb_build_object('id', p.character_id, 'name', p.name, 'sort', p.sort_order,
                            'enabled', p.enabled) ORDER BY p.character_id) FROM miniapp_analytics.card_position_snapshot p),
    'initial', v_initial,
    'final', test_fixture.snapshot(),
    'created', (v_new - 'created_at' - 'updated_at' - 'last_listed_at') || jsonb_build_object(
      'created', test_fixture.nts((v_new->>'created_at')::timestamp),
      'listed', test_fixture.ntz((v_new->>'last_listed_at')::timestamptz)),
    'audit', (SELECT jsonb_agg(jsonb_build_object('action', a.action, 'record', a.record_id, 'before', a.before_value,
                'after', a.after_value) ORDER BY a.action, a.record_id) FROM admin.audit_logs a),
    'releases', (SELECT jsonb_agg(jsonb_build_object('v', r.layout_version, 'listed', r.listed_ids, 'delisted', r.delisted_ids,
                   'deleted', r.deleted_ids)) FROM admin.character_layout_releases r),
    'state', (SELECT jsonb_agg(s.layout_version) FROM admin.character_layout_state s));
  RETURN replace(v_out::text, v_new->>'id', 'NEW-CARD')::jsonb;
END $$;
SQL
echo "ok: fixture (production bodies, md5 verified)"

scenario() {
  "${admin_psql[@]}" -At <<'SQL'
BEGIN;
SELECT jsonb_pretty(test_fixture.run_scenario());
ROLLBACK;
SQL
}
expect_fail() { # label, expected error substring, sql file (stdin)
  local out
  if out=$("${admin_psql[@]}" 2>&1); then
    echo "FAIL: $1 should have been refused"; exit 1
  fi
  if [[ "$out" != *"$2"* ]]; then
    echo "FAIL: $1 refused with an unexpected error:"; echo "$out"; exit 1
  fi
  echo "ok: $1 refused"
}

scenario >"$work_dir/before.json"
# The baseline must exercise every listing rule, otherwise "identical" proves nothing.
id() { printf '00000000-0000-0000-0000-%012s' "$1" | tr ' ' 0; }
card() { jq -r --arg id "$(id "$1")" ".final.cards[] | select(.id == \$id) | .$2" "$work_dir/before.json"; }
check() { [[ "$(card "$1" "$2")" == "$3" ]] || { echo "FAIL: baseline card $1 $2 is $(card "$1" "$2"), expected $3"; exit 1; }; }
check c1 listed now      # first approval on publish refreshes
check c2 listed now      # first approval by review refreshes
check c3 listed '2026-11-01 03:00:00+00'  # re-approval keeps
check c4 listed '2026-11-01 04:00:00+00'
check 9 listed now       # restored from archive
check 9 archived null
check 1 listed '2026-09-05 02:00:00+00'   # stays listed, reorder only
check 1 sort 1
check 6 archived now
check 4 enabled false
check f1 enabled false
check c1 name 创作一
jq -e '.final.layout.published.delisted_ids | index("NEW-CARD")' "$work_dir/before.json" >/dev/null &&
  jq -e '.created.enabled == false and .created.listed == "now" and .created.sort_order == 10' "$work_dir/before.json" >/dev/null &&
  jq -e '.final.discover["'"$(id c1)"'"] == true and .final.discover["'"$(id c5)"'"] == false and .final.discover["'"$(id c6)"'"] == false' "$work_dir/before.json" >/dev/null &&
  jq -e '.final.use["'"$(id c6)|$(id a003)"'"] == true and .final.use["'"$(id c6)|$(id a001)"'"] == false' "$work_dir/before.json" >/dev/null &&
  jq -e '[.final.admin_list[] | select(.updated == "now")] | length == 17' "$work_dir/before.json" >/dev/null &&
  jq -e '(.audit | length) == 4 and .final.layout.layout_version == 4' "$work_dir/before.json" >/dev/null &&
  jq -e '(.position_snapshot | length) == 11' "$work_dir/before.json" >/dev/null ||
  { echo "FAIL: baseline scenario misses an expected effect"; exit 1; }
echo "ok: baseline scenario with the old functions"

# Expand guards -----------------------------------------------------------------------------------------------
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.saved_defs AS
SELECT oid::regprocedure::text AS fn, pg_get_functiondef(oid) AS def FROM pg_proc
WHERE oid IN ('admin.get_characters()'::regprocedure, 'app_core.review_creator_character(uuid,uuid,integer,text,text,text)'::regprocedure);
CREATE OR REPLACE FUNCTION admin.get_characters()
 RETURNS TABLE(id uuid, name text, description text, avatar_url text, tags jsonb, creator text, first_mes text, creator_notes text, enabled boolean, sort_order integer, archived_at timestamp without time zone, created_at timestamp without time zone, updated_at timestamp without time zone)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $function$ BEGIN RETURN QUERY SELECT card.id, card.name, card.description, card.avatar_url, card.tags, card.creator,
  card.first_mes, card.creator_notes, card.enabled, card.sort_order, card.archived_at, card.created_at, card.updated_at
  FROM app_core.characters AS card; END; $function$;
SQL
expect_fail "expand over a changed admin.get_characters" "differs from the version" <"$expand"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN EXECUTE (SELECT def FROM test_fixture.saved_defs WHERE fn = 'admin.get_characters()'); END $$;
DO $$ DECLARE v text := (SELECT def FROM test_fixture.saved_defs WHERE fn LIKE 'app_core.review_creator_character%');
BEGIN EXECUTE replace(v, 'ELSE last_listed_at END,updated_at=now()', 'ELSE last_listed_at END, updated_at=now()'); END $$;
SQL
expect_fail "expand over a changed creator review sentence" "expected exactly one match, found 0" <"$expand"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN EXECUTE (SELECT def FROM test_fixture.saved_defs WHERE fn LIKE 'app_core.review_creator_character%'); END $$;
CREATE TABLE test_fixture.saved_cron AS SELECT jobid, command FROM cron.job;
UPDATE cron.job SET command = command || ' LIMIT 10' WHERE jobid = 5;
SQL
expect_fail "expand over a changed position snapshot cron command" "differs from the expected card position snapshot command" <"$expand"
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE cron.job j SET command = s.command FROM test_fixture.saved_cron s WHERE s.jobid = j.jobid;
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'admin.get_characters()'::regprocedure) <> '4f07ba1b25c8f7d33e1665df218d3288'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'app_core.review_creator_character(uuid,uuid,integer,text,text,text)'::regprocedure)
        <> '6a07e09bab6e15b11c78cf7e1161287c'
     OR to_regclass('app_core.character_listings') IS NOT NULL THEN
    RAISE EXCEPTION 'assert: refused expand left changes behind';
  END IF;
END $$;
SQL

# Expand ------------------------------------------------------------------------------------------------------
"${admin_psql[@]}" >/dev/null <"$expand"
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE TABLE test_fixture.fn_after_expand AS
SELECT p.oid::regprocedure::text AS fn, md5(p.prosrc) AS md5sum FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('admin', 'app_core');
SQL
"${admin_psql[@]}" >/dev/null <"$expand"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT p.oid::regprocedure::text AS fn, md5(p.prosrc) AS md5sum FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('admin', 'app_core')
    EXCEPT SELECT fn, md5sum FROM test_fixture.fn_after_expand) d;
  IF v_n <> 0 THEN RAISE EXCEPTION 'assert: re-running expand changed % functions', v_n; END IF;

  -- Backfill equals the card columns; updated_at is the card's, as an instant.
  SELECT count(*) INTO v_n FROM app_core.characters c LEFT JOIN app_core.character_listings l ON l.character_id = c.id
  WHERE l.character_id IS NULL
     OR (c.enabled, c.sort_order, c.archived_at, c.last_listed_at, c.updated_at AT TIME ZONE 'Asia/Shanghai')
        IS DISTINCT FROM (l.enabled, l.sort_order, l.archived_at, l.last_listed_at, l.updated_at);
  IF v_n <> 0 OR (SELECT count(*) FROM app_core.character_listings) <> (SELECT count(*) FROM app_core.characters) THEN
    RAISE EXCEPTION 'assert: backfill differs on % cards', v_n;
  END IF;

  IF to_regprocedure('admin.archive_character(uuid)') IS NOT NULL
     OR to_regprocedure('admin.set_character_enabled(uuid,boolean)') IS NOT NULL
     OR to_regprocedure('admin.reorder_characters(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'assert: 0-call operator functions still exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'app_core.characters'::regclass AND tgname = 'trg_characters_track_listing') THEN
    RAISE EXCEPTION 'assert: card-side listing trigger still exists';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'app_core' AND table_name = 'characters' AND column_name = 'enabled') <> 'false' THEN
    RAISE EXCEPTION 'assert: characters.enabled default is not false';
  END IF;

  -- Grants: listing table service_role read + update only; create_character not for anon/PUBLIC; view grant kept.
  IF NOT has_table_privilege('service_role', 'app_core.character_listings', 'SELECT')
     OR NOT has_table_privilege('service_role', 'app_core.character_listings', 'UPDATE')
     OR has_table_privilege('service_role', 'app_core.character_listings', 'INSERT')
     OR has_table_privilege('service_role', 'app_core.character_listings', 'DELETE')
     OR has_table_privilege('anon', 'app_core.character_listings', 'SELECT')
     OR has_table_privilege('authenticated', 'app_core.character_listings', 'SELECT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'app_core.character_listings'::regclass) THEN
    RAISE EXCEPTION 'assert: character_listings grants/RLS wrong';
  END IF;
  IF has_function_privilege('anon', 'admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)', 'EXECUTE')
     OR (SELECT prorettype FROM pg_proc WHERE oid = 'admin.create_character(text,text,text,jsonb,text,text,text,text,text,text,text)'::regprocedure) <> 'jsonb'::regtype THEN
    RAISE EXCEPTION 'assert: create_character grants/return type wrong';
  END IF;
  IF NOT has_table_privilege('cs_persona_reader', 'miniapp_analytics.v_card_quality_session', 'SELECT') THEN
    RAISE EXCEPTION 'assert: analytics view lost its grant';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('app_core.mutate_creator_character(uuid,uuid,text,integer,jsonb)'::regprocedure,
               'app_core.review_creator_character(uuid,uuid,integer,text,text,text)'::regprocedure)
             AND (prosrc ~ 'last_listed_at=CASE' OR prosrc ~ 'enabled,sort_order\)')) THEN
    RAISE EXCEPTION 'assert: creator functions still write card listing columns';
  END IF;
  IF (SELECT command FROM cron.job WHERE jobid = 5) NOT LIKE '%JOIN app_core.character_listings l%' THEN
    RAISE EXCEPTION 'assert: position snapshot cron job not rewritten';
  END IF;
END $$;
SQL
echo "ok: expand applied twice (idempotent), backfill, drops, grants"

scenario >"$work_dir/after_expand.json"
if ! diff -u "$work_dir/before.json" "$work_dir/after_expand.json" >"$work_dir/expand.diff"; then
  echo "FAIL: scenario differs after expand"; head -80 "$work_dir/expand.diff"; exit 1
fi
echo "ok: scenario identical after expand (layout, create, creator publish/review, readers, view, audit)"

# Release window: mirror + guards (all rolled back) -----------------------------------------------------------------
"${admin_psql[@]}" >/dev/null <<'SQL'
BEGIN;
SELECT test_fixture.run_scenario();
DO $$
DECLARE v_l record; v_c record;
BEGIN
  IF EXISTS (SELECT 1 FROM app_core.characters c JOIN app_core.character_listings l ON l.character_id = c.id
             WHERE (c.enabled, c.sort_order, c.archived_at, c.last_listed_at)
                   IS DISTINCT FROM (l.enabled, l.sort_order, l.archived_at, l.last_listed_at)) THEN
    RAISE EXCEPTION 'assert: mirror diverged after scenario';
  END IF;

  -- Old-style insert (old import script): listing takes the card values; listing time set; mirrored back.
  INSERT INTO app_core.characters (id, name, enabled, sort_order, card_hash) VALUES (test_fixture.id('e1'), '导入旧', true, 42, 'imp-1');
  SELECT * INTO v_l FROM app_core.character_listings WHERE character_id = test_fixture.id('e1');
  SELECT * INTO v_c FROM app_core.characters WHERE id = test_fixture.id('e1');
  IF NOT v_l.enabled OR v_l.sort_order <> 42 OR v_l.last_listed_at <> now() OR v_c.last_listed_at IS DISTINCT FROM v_l.last_listed_at THEN
    RAISE EXCEPTION 'assert: old-style insert listing wrong';
  END IF;

  -- New-style insert: card content, then listing update; mirror keeps card columns equal.
  INSERT INTO app_core.characters (id, name, card_hash) VALUES (test_fixture.id('e2'), '导入新', 'imp-2');
  SELECT * INTO v_l FROM app_core.character_listings WHERE character_id = test_fixture.id('e2');
  IF v_l.enabled OR v_l.sort_order <> 0 OR v_l.last_listed_at IS NULL THEN
    RAISE EXCEPTION 'assert: new-style insert default listing wrong';
  END IF;
  UPDATE app_core.character_listings SET enabled = true, sort_order = 7 WHERE character_id = test_fixture.id('e2');
  SELECT * INTO v_c FROM app_core.characters WHERE id = test_fixture.id('e2');
  IF NOT v_c.enabled OR v_c.sort_order <> 7 OR v_c.last_listed_at <> now() THEN
    RAISE EXCEPTION 'assert: listing update not mirrored to card';
  END IF;

  -- Test cards: may be inserted delisted; can never be listed; listed cards cannot become test cards.
  INSERT INTO app_core.characters (id, name, is_test, card_hash) VALUES (test_fixture.id('e3'), '测试新', true, 'imp-3');
  BEGIN
    UPDATE app_core.character_listings SET enabled = true WHERE character_id = test_fixture.id('e3');
    RAISE EXCEPTION 'assert: test card was listed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE app_core.characters SET is_test = true WHERE id = test_fixture.id('e2');
    RAISE EXCEPTION 'assert: listed card became a test card';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO app_core.characters (id, name, is_test) VALUES (test_fixture.id('e4'), '无哈希', true);
    RAISE EXCEPTION 'assert: test card without hash accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  DELETE FROM app_core.characters WHERE id = test_fixture.id('e1');
  IF EXISTS (SELECT 1 FROM app_core.character_listings WHERE character_id = test_fixture.id('e1')) THEN
    RAISE EXCEPTION 'assert: listing not deleted with its card';
  END IF;
END $$;
ROLLBACK;
SQL
echo "ok: release window mirror, old/new-style inserts, test-card guards, cascade"

# Contract guards -----------------------------------------------------------------------------------------------
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION test_fixture.rogue() RETURNS integer LANGUAGE sql AS
  $$ SELECT count(*)::integer FROM app_core.characters WHERE enabled $$;
SQL
expect_fail "contract with a function reading characters.enabled" "functions still read listing columns of app_core.characters: test_fixture.rogue()"$'\n' <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
DROP FUNCTION test_fixture.rogue();
CREATE VIEW test_fixture.rogue_v AS SELECT id, sort_order FROM app_core.characters;
SQL
expect_fail "contract with a view on characters.sort_order" "views still depend on listing columns" <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
DROP VIEW test_fixture.rogue_v;
INSERT INTO cron.job VALUES (9, 'rogue_listing_job', '*/5 * * * *', 'SELECT count(*) FROM app_core.characters WHERE enabled');
SQL
expect_fail "contract with a cron job reading characters.enabled" "cron jobs still read listing columns of app_core.characters: 9 rogue_listing_job" <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
DELETE FROM cron.job WHERE jobid = 9;
UPDATE app_core.characters SET sort_order = 999 WHERE id = test_fixture.id('1');
SQL
expect_fail "contract with a card written directly" "differ from their listing row" <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
UPDATE app_core.characters c SET sort_order = l.sort_order FROM app_core.character_listings l
WHERE l.character_id = c.id AND c.id = test_fixture.id('1');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'character_listings_mirror')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app_core' AND table_name = 'characters'
                    AND column_name = 'enabled') THEN
    RAISE EXCEPTION 'assert: refused contract left changes behind';
  END IF;
END $$;
SQL

# Contract ----------------------------------------------------------------------------------------------------------
"${admin_psql[@]}" >/dev/null <"$contract"
"${admin_psql[@]}" >/dev/null <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app_core' AND table_name = 'characters'
             AND column_name IN ('enabled', 'sort_order', 'archived_at', 'last_listed_at')) THEN
    RAISE EXCEPTION 'assert: listing columns still on characters';
  END IF;
  IF to_regclass('app_core.idx_characters_active_order') IS NOT NULL OR to_regclass('app_core.idx_characters_enabled_sort') IS NOT NULL
     OR to_regclass('app_core.idx_characters_last_listed_at') IS NOT NULL
     OR to_regprocedure('app_core.tf_track_character_listing()') IS NOT NULL
     OR to_regprocedure('app_core.tf_character_listings_mirror()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'characters_test_cards_disabled')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'characters_test_cards_have_hash') THEN
    RAISE EXCEPTION 'assert: old objects left or new CHECK missing';
  END IF;
END $$;
SQL
echo "ok: contract applied twice (idempotent), old columns/indexes/CHECK/trigger function dropped"

scenario >"$work_dir/after_contract.json"
if ! diff -u "$work_dir/before.json" "$work_dir/after_contract.json" >"$work_dir/contract.diff"; then
  echo "FAIL: scenario differs after contract"; head -80 "$work_dir/contract.diff"; exit 1
fi
echo "ok: scenario identical after contract"

"${admin_psql[@]}" >/dev/null <<'SQL'
BEGIN;
DO $$
DECLARE v_l record;
BEGIN
  INSERT INTO app_core.characters (id, name, card_hash, created_at) VALUES (test_fixture.id('e5'), '收缩后新卡', 'imp-5', timestamp '2026-11-18 12:00');
  SELECT * INTO v_l FROM app_core.character_listings WHERE character_id = test_fixture.id('e5');
  IF v_l.enabled OR v_l.sort_order <> 0 OR v_l.archived_at IS NOT NULL
     OR v_l.last_listed_at <> timestamp '2026-11-18 12:00' AT TIME ZONE 'Asia/Shanghai' THEN
    RAISE EXCEPTION 'assert: default listing row wrong after contract: %', row_to_json(v_l);
  END IF;
  UPDATE app_core.character_listings SET enabled = true WHERE character_id = test_fixture.id('e5');
  BEGIN
    UPDATE app_core.characters SET is_test = true WHERE id = test_fixture.id('e5');
    RAISE EXCEPTION 'assert: listed card became a test card after contract';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE app_core.characters SET is_test = true WHERE id = test_fixture.id('7');
  BEGIN
    UPDATE app_core.character_listings SET enabled = true WHERE character_id = test_fixture.id('7');
    RAISE EXCEPTION 'assert: test card was listed after contract';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
SQL
echo "ok: after contract new cards get a default listing row; test-card guards hold"
echo "PASS: p3c character listings migration"
