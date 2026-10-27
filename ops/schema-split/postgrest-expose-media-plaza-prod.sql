-- PRODUCTION post-M1 prerequisite for deploying the media_plaza backend.
-- Run only after 20261027_media_plaza_schema_move.sql creates the schema.
-- Production is externally mutable: first copy the live REST hint and role GUC
-- into the release record. A NULL role GUC is valid when Supabase's platform
-- configuration owns the list; this script then establishes the reviewed
-- explicit override. Any unknown non-NULL value still fails shut.
BEGIN;
DO $$
DECLARE
  v_current TEXT;
  v_setting_count INTEGER;
  v_baseline CONSTANT TEXT :=
    'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing';
  v_target CONSTANT TEXT :=
    'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing, media_plaza';
BEGIN
  IF to_regnamespace('media_plaza') IS NULL THEN
    RAISE EXCEPTION 'media_plaza schema is absent; run 20261027_media_plaza_schema_move.sql first';
  END IF;

  SELECT
    count(*),
    max(substring(setting FROM length('pgrst.db_schemas=') + 1))
  INTO v_setting_count, v_current
  FROM pg_db_role_setting AS role_setting
  JOIN pg_roles AS role ON role.oid = role_setting.setrole
  CROSS JOIN LATERAL unnest(role_setting.setconfig) AS item(setting)
  WHERE role.rolname = 'authenticator' AND setting LIKE 'pgrst.db_schemas=%';

  IF v_setting_count > 1 THEN
    RAISE EXCEPTION 'multiple production pgrst.db_schemas role settings found; review role/database precedence';
  END IF;

  IF v_current IS NOT NULL AND v_current NOT IN (v_baseline, v_target) THEN
    RAISE EXCEPTION 'unexpected production pgrst.db_schemas: %', v_current;
  END IF;
END;
$$;
ALTER ROLE authenticator SET pgrst.db_schemas =
  'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing, media_plaza';
COMMIT;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

-- M1-only rollback must restore the recorded preflight ownership/state and is
-- forbidden after video data exists. If the preflight role GUC was NULL, use:
-- ALTER ROLE authenticator RESET pgrst.db_schemas;
-- If it was the explicit production baseline, restore that exact baseline with
-- ALTER ROLE authenticator SET pgrst.db_schemas = '...';
-- Never copy TEST settings. Reload both PostgREST config and schema afterward.
