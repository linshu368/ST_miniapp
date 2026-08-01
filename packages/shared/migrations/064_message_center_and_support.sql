-- MiniApp message center, announcements, and in-app customer support.

BEGIN;

CREATE TABLE IF NOT EXISTS miniapp.notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL CHECK (scope IN ('official', 'personal')),
  category      TEXT NOT NULL CHECK (category IN ('announcement', 'activity', 'system', 'interaction')),
  title         TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 120),
  body          TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 4000),
  user_id       UUID REFERENCES miniapp.users(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_published  BOOLEAN NOT NULL DEFAULT false,
  published_at  TIMESTAMPTZ,
  created_by    UUID REFERENCES admin.admin_users(user_id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  CHECK (
    (scope = 'official' AND user_id IS NULL)
    OR (scope = 'personal' AND user_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS miniapp.notification_reads (
  notification_id UUID NOT NULL REFERENCES miniapp.notifications(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS miniapp.support_conversations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL UNIQUE REFERENCES miniapp.users(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  last_user_message_at   TIMESTAMPTZ,
  last_agent_message_at  TIMESTAMPTZ,
  agent_unread_count     INTEGER NOT NULL DEFAULT 0 CHECK (agent_unread_count >= 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS miniapp.support_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES miniapp.support_conversations(id) ON DELETE CASCADE,
  sender           TEXT NOT NULL CHECK (sender IN ('user', 'agent')),
  body             TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 4000),
  client_msg_id    UUID,
  agent_user_id    UUID REFERENCES admin.admin_users(user_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, client_msg_id),
  CHECK (
    (sender = 'user' AND agent_user_id IS NULL)
    OR sender = 'agent'
  )
);

CREATE INDEX IF NOT EXISTS idx_notifications_official_feed
  ON miniapp.notifications (sort_order ASC, published_at DESC, created_at DESC)
  WHERE scope = 'official' AND is_published AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_personal_feed
  ON miniapp.notifications (user_id, created_at DESC)
  WHERE scope = 'personal' AND is_published AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_reads_user
  ON miniapp.notification_reads (user_id, notification_id);
CREATE INDEX IF NOT EXISTS idx_support_conversations_queue
  ON miniapp.support_conversations (status, last_user_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
  ON miniapp.support_messages (conversation_id, created_at, id);

ALTER TABLE miniapp.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.support_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.notifications, miniapp.notification_reads,
  miniapp.support_conversations, miniapp.support_messages FROM anon, authenticated;
GRANT ALL ON miniapp.notifications, miniapp.notification_reads,
  miniapp.support_conversations, miniapp.support_messages TO service_role, postgres;

CREATE OR REPLACE FUNCTION admin.list_announcements()
RETURNS SETOF miniapp.notifications
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'admin is not permitted to access current environment'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT notification.*
  FROM miniapp.notifications AS notification
  WHERE notification.scope = 'official' AND notification.deleted_at IS NULL
  ORDER BY notification.sort_order, notification.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION admin.create_announcement(
  p_category TEXT,
  p_title TEXT,
  p_body TEXT,
  p_sort_order INTEGER DEFAULT 0,
  p_is_published BOOLEAN DEFAULT false
) RETURNS miniapp.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_created miniapp.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO miniapp.notifications (
    scope, category, title, body, sort_order, is_published, published_at, created_by
  ) VALUES (
    'official', p_category, trim(p_title), trim(p_body), COALESCE(p_sort_order, 0),
    COALESCE(p_is_published, false),
    CASE WHEN COALESCE(p_is_published, false) THEN now() ELSE NULL END,
    v_actor.user_id
  ) RETURNING * INTO v_created;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.create', 'miniapp', 'notifications', v_created.id::TEXT,
    NULL, to_jsonb(v_created)
  );
  RETURN v_created;
END;
$$;

CREATE OR REPLACE FUNCTION admin.update_announcement(
  p_id UUID,
  p_category TEXT,
  p_title TEXT,
  p_body TEXT,
  p_sort_order INTEGER
) RETURNS miniapp.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.notifications%ROWTYPE;
  v_after miniapp.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT notification.* INTO v_before
  FROM miniapp.notifications AS notification
  WHERE notification.id = p_id AND notification.scope = 'official'
    AND notification.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE miniapp.notifications
  SET category = p_category, title = trim(p_title), body = trim(p_body),
      sort_order = p_sort_order, updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.update', 'miniapp', 'notifications', p_id::TEXT,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION admin.set_announcement_published(
  p_id UUID,
  p_is_published BOOLEAN
) RETURNS miniapp.notifications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.notifications%ROWTYPE;
  v_after miniapp.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  SELECT notification.* INTO v_before
  FROM miniapp.notifications AS notification
  WHERE notification.id = p_id AND notification.scope = 'official'
    AND notification.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE miniapp.notifications
  SET is_published = COALESCE(p_is_published, false),
      published_at = CASE
        WHEN COALESCE(p_is_published, false) THEN COALESCE(published_at, now())
        ELSE NULL
      END,
      updated_at = now()
  WHERE id = p_id
  RETURNING * INTO v_after;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    CASE WHEN v_after.is_published THEN 'announcement.publish' ELSE 'announcement.unpublish' END,
    'miniapp', 'notifications', p_id::TEXT, to_jsonb(v_before), to_jsonb(v_after)
  );
  RETURN v_after;
END;
$$;

CREATE OR REPLACE FUNCTION admin.delete_announcement(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor admin.admin_users%ROWTYPE;
  v_before miniapp.notifications%ROWTYPE;
BEGIN
  SELECT actor.* INTO v_actor FROM admin.admin_users AS actor WHERE actor.user_id = auth.uid();
  IF NOT FOUND OR v_actor.role NOT IN ('owner', 'operator')
     OR NOT admin.can_access_environment(admin.current_environment()) THEN
    RAISE EXCEPTION 'operator access required' USING ERRCODE = '42501';
  END IF;

  UPDATE miniapp.notifications
  SET deleted_at = now(), is_published = false, updated_at = now()
  WHERE id = p_id AND scope = 'official' AND deleted_at IS NULL
  RETURNING * INTO v_before;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'announcement not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO admin.audit_logs (
    actor_user_id, actor_email, environment, action, schema_name, table_name,
    record_id, before_value, after_value
  ) VALUES (
    v_actor.user_id, v_actor.email, admin.current_environment(),
    'announcement.delete', 'miniapp', 'notifications', p_id::TEXT,
    to_jsonb(v_before), NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.list_announcements() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.create_announcement(TEXT, TEXT, TEXT, INTEGER, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.update_announcement(UUID, TEXT, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.set_announcement_published(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.delete_announcement(UUID)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION admin.list_announcements() TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.create_announcement(TEXT, TEXT, TEXT, INTEGER, BOOLEAN)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.update_announcement(UUID, TEXT, TEXT, TEXT, INTEGER)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.set_announcement_published(UUID, BOOLEAN)
  TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION admin.delete_announcement(UUID)
  TO authenticated, service_role, postgres;

COMMIT;
