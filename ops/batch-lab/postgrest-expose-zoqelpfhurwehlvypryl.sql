-- Target: test branch zoqelpfhurwehlvypryl only.
-- Do not reuse for production. Run only after same-day preflight and explicit approval.
-- Rollback value is the exact ten-schema baseline in v_expected.
DO $$
DECLARE
  v_current text;
  v_expected constant text :=
    'public, graphql_public, miniapp, miniapp_traffic, admin, cs_platform, app_core, miniapp_features, experience, billing';
BEGIN
  SELECT replace(config, 'pgrst.db_schemas=', '')
    INTO v_current
  FROM pg_catalog.pg_db_role_setting s
  JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
  CROSS JOIN LATERAL unnest(s.setconfig) AS setting(config)
  WHERE r.rolname = 'authenticator'
    AND config LIKE 'pgrst.db_schemas=%';

  IF v_current IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'PostgREST schema baseline drifted; expected %, got %', v_expected, v_current;
  END IF;
  IF to_regnamespace('batch_lab') IS NULL THEN
    RAISE EXCEPTION 'batch_lab schema is missing';
  END IF;

  EXECUTE format(
    'ALTER ROLE authenticator SET pgrst.db_schemas = %L',
    v_expected || ', batch_lab'
  );
END $$;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';

-- Rollback (separate explicit action):
-- ALTER ROLE authenticator SET pgrst.db_schemas =
--   'public, graphql_public, miniapp, miniapp_traffic, admin, cs_platform, app_core, miniapp_features, experience, billing';
-- NOTIFY pgrst, 'reload config';
-- NOTIFY pgrst, 'reload schema';