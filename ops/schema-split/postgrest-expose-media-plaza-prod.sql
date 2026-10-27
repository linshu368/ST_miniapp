-- PRODUCTION post-M1 prerequisite for deploying the media_plaza backend.
-- Run only after 20261027_media_plaza_schema_move.sql creates the schema.
-- Production is externally mutable: first copy the live REST hint and role GUC
-- into the release record. This guard intentionally stops on any drift.
BEGIN;
DO $$
DECLARE
  v_current TEXT;
BEGIN
  SELECT substring(setting FROM length('pgrst.db_schemas=') + 1) INTO v_current
  FROM pg_db_role_setting AS role_setting
  JOIN pg_roles AS role ON role.oid = role_setting.setrole
  CROSS JOIN LATERAL unnest(role_setting.setconfig) AS item(setting)
  WHERE role.rolname = 'authenticator' AND setting LIKE 'pgrst.db_schemas=%';
  IF v_current IS DISTINCT FROM
    'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing' THEN
    RAISE EXCEPTION 'unexpected production pgrst.db_schemas: %', v_current;
  END IF;
END;
$$;
ALTER ROLE authenticator SET pgrst.db_schemas =
  'graphql_public, miniapp, miniapp_analytics, miniapp_traffic, cs_platform, admin, app_core, miniapp_features, experience, billing, media_plaza';
COMMIT;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

-- M1-only rollback value must be the recorded preflight value. Do not reset or
-- copy TEST settings, and do not roll back after video data exists.
