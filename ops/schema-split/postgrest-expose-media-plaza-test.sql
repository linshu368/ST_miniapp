-- TEST-only post-M1 prerequisite for deploying the media_plaza backend.
-- Run only after 20261027_media_plaza_schema_move.sql creates the schema.
-- Re-check the live value before applying; this script refuses configuration drift.
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
    'public, graphql_public, miniapp, miniapp_traffic, admin, cs_platform, app_core, miniapp_features, experience, billing' THEN
    RAISE EXCEPTION 'unexpected TEST pgrst.db_schemas: %', v_current;
  END IF;
END;
$$;
ALTER ROLE authenticator SET pgrst.db_schemas =
  'public, graphql_public, miniapp, miniapp_traffic, admin, cs_platform, app_core, miniapp_features, experience, billing, media_plaza';
COMMIT;
NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

-- M1-only rollback value (do not use after video data exists):
-- ALTER ROLE authenticator SET pgrst.db_schemas =
--   'public, graphql_public, miniapp, miniapp_traffic, admin, cs_platform, app_core, miniapp_features, experience, billing';
