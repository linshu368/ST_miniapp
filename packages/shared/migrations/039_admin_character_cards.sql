-- Admin character card read model and explicit draft discard operation.

BEGIN;

CREATE OR REPLACE FUNCTION admin.discard_config_draft(p_draft_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_draft admin.config_drafts%ROWTYPE;
BEGIN
  SELECT admin_user.* INTO v_actor
  FROM admin.admin_users AS admin_user
  WHERE admin_user.user_id = auth.uid();

  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator') THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT draft.* INTO v_draft
  FROM admin.config_drafts AS draft
  WHERE draft.id = p_draft_id
    AND draft.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active draft not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.environment <> admin.current_environment()
     OR (v_draft.environment = 'test' AND NOT v_actor.can_access_test)
     OR (v_draft.environment = 'production' AND NOT v_actor.can_access_prod) THEN
    RAISE EXCEPTION 'admin is not permitted to access requested environment'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM admin.config_drafts
  WHERE id = v_draft.id;

  INSERT INTO admin.audit_logs (
    actor_user_id,
    actor_email,
    environment,
    action,
    schema_name,
    table_name,
    record_id,
    before_value,
    after_value
  ) VALUES (
    v_actor.user_id,
    v_actor.email,
    v_draft.environment,
    'config.draft.discard',
    'admin',
    'config_drafts',
    v_draft.id::TEXT,
    to_jsonb(v_draft),
    NULL
  );

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION admin.get_characters()
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  avatar_url TEXT,
  tags JSONB,
  creator TEXT,
  first_mes TEXT,
  creator_notes TEXT,
  enabled BOOLEAN,
  sort_order INTEGER,
  created_at TIMESTAMP WITHOUT TIME ZONE,
  updated_at TIMESTAMP WITHOUT TIME ZONE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_environment TEXT;
BEGIN
  v_environment := admin.current_environment();

  IF NOT admin.can_access_environment(v_environment) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    card.id,
    card.name,
    card.description,
    card.avatar_url,
    card.tags,
    card.creator,
    card.first_mes,
    card.creator_notes,
    card.enabled,
    card.sort_order,
    card.created_at,
    card.updated_at
  FROM miniapp.characters AS card
  ORDER BY card.sort_order ASC, card.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION admin.discard_config_draft(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.get_characters()
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.discard_config_draft(UUID)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.get_characters()
  TO authenticated, service_role, postgres;

COMMIT;
