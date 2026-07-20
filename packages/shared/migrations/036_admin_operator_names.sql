-- Record the operator-provided display name on every admin mutation.
-- The name is intentionally not identity-verified; Supabase Auth and admin role checks remain authoritative.

BEGIN;

ALTER TABLE admin.admin_users
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE admin.audit_logs
  ADD COLUMN IF NOT EXISTS actor_name TEXT;

ALTER TABLE admin.config_releases
  ADD COLUMN IF NOT EXISTS released_by_name TEXT;

CREATE OR REPLACE FUNCTION admin.set_operator_name(p_display_name TEXT)
RETURNS admin.admin_users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_name  TEXT;
  v_actor admin.admin_users%ROWTYPE;
BEGIN
  v_name := trim(COALESCE(p_display_name, ''));
  IF char_length(v_name) = 0 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'operator name must contain 1 to 80 characters'
      USING ERRCODE = '22023';
  END IF;

  UPDATE admin.admin_users
  SET display_name = v_name, updated_at = now()
  WHERE user_id = auth.uid()
  RETURNING * INTO v_actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registered admin required'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_actor;
END;
$$;

CREATE OR REPLACE FUNCTION admin.snapshot_operator_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_name TEXT;
BEGIN
  IF TG_TABLE_NAME = 'audit_logs' THEN
    SELECT au.display_name
    INTO v_name
    FROM admin.admin_users AS au
    WHERE au.user_id = NEW.actor_user_id;

    IF COALESCE(char_length(trim(v_name)), 0) = 0 THEN
      RAISE EXCEPTION 'operator name is required; sign in again'
        USING ERRCODE = '42501';
    END IF;

    NEW.actor_name := v_name;
  ELSIF TG_TABLE_NAME = 'config_releases' THEN
    SELECT au.display_name
    INTO v_name
    FROM admin.admin_users AS au
    WHERE au.user_id = NEW.released_by;

    IF COALESCE(char_length(trim(v_name)), 0) = 0 THEN
      RAISE EXCEPTION 'operator name is required; sign in again'
        USING ERRCODE = '42501';
    END IF;

    NEW.released_by_name := v_name;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_snapshot_operator_name ON admin.audit_logs;
CREATE TRIGGER audit_logs_snapshot_operator_name
  BEFORE INSERT ON admin.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION admin.snapshot_operator_name();

DROP TRIGGER IF EXISTS config_releases_snapshot_operator_name ON admin.config_releases;
CREATE TRIGGER config_releases_snapshot_operator_name
  BEFORE INSERT ON admin.config_releases
  FOR EACH ROW
  EXECUTE FUNCTION admin.snapshot_operator_name();

REVOKE ALL ON FUNCTION admin.set_operator_name(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin.set_operator_name(TEXT)
  TO authenticated, service_role, postgres;

REVOKE ALL ON FUNCTION admin.snapshot_operator_name()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN admin.admin_users.display_name IS
  'Unverified operator name supplied at login and used for subsequent audit snapshots.';
COMMENT ON COLUMN admin.audit_logs.actor_name IS
  'Operator name snapshot captured when the audited mutation occurs.';
COMMENT ON COLUMN admin.config_releases.released_by_name IS
  'Operator name snapshot captured when the release is created.';

COMMIT;
