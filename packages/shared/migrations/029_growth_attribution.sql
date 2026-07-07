-- 029: Growth attribution for MiniApp channel links and entry tracking.

CREATE SCHEMA IF NOT EXISTS growth;

CREATE TABLE IF NOT EXISTS growth.channel_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name          TEXT NOT NULL CHECK (char_length(trim(source_name)) > 0),
  source_id            TEXT NOT NULL UNIQUE CHECK (source_id ~ '^[A-Za-z0-9_-]{3,64}$'),
  miniapp_link         TEXT NOT NULL,
  tracking_link        TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes                TEXT NOT NULL DEFAULT '',
  created_by           TEXT NOT NULL DEFAULT 'system',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS growth.link_clicks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id            TEXT NOT NULL REFERENCES growth.channel_links(source_id) ON DELETE CASCADE,
  ip_hash              TEXT,
  user_agent           TEXT,
  clicked_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_growth_link_clicks_source_time
  ON growth.link_clicks(source_id, clicked_at DESC);

CREATE TABLE IF NOT EXISTS growth.miniapp_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id            TEXT NOT NULL REFERENCES growth.channel_links(source_id) ON DELETE CASCADE,
  user_id              UUID REFERENCES miniapp.users(id) ON DELETE SET NULL,
  telegram_user_id     TEXT,
  start_param          TEXT NOT NULL,
  entered_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent           TEXT
);

CREATE INDEX IF NOT EXISTS idx_growth_miniapp_entries_source_time
  ON growth.miniapp_entries(source_id, entered_at DESC);

CREATE INDEX IF NOT EXISTS idx_growth_miniapp_entries_user_source
  ON growth.miniapp_entries(user_id, source_id);

CREATE OR REPLACE VIEW growth.channel_link_stats AS
SELECT
  l.id,
  l.source_name,
  l.source_id,
  l.miniapp_link,
  l.tracking_link,
  l.status,
  l.notes,
  l.created_by,
  l.created_at,
  l.updated_at,
  COALESCE(c.click_count, 0)::INTEGER AS click_count,
  COALESCE(e.enter_count, 0)::INTEGER AS enter_count,
  COALESCE(e.unique_enter_count, 0)::INTEGER AS unique_enter_count,
  COALESCE(e.activated_user_count, 0)::INTEGER AS activated_user_count,
  e.last_entered_at
FROM growth.channel_links l
LEFT JOIN (
  SELECT source_id, count(*)::INTEGER AS click_count
  FROM growth.link_clicks
  GROUP BY source_id
) c ON c.source_id = l.source_id
LEFT JOIN (
  SELECT
    entries.source_id,
    count(*)::INTEGER AS enter_count,
    count(DISTINCT entries.user_id)::INTEGER AS unique_enter_count,
    count(DISTINCT entries.user_id) FILTER (WHERE u.total_round > 0)::INTEGER AS activated_user_count,
    max(entries.entered_at) AS last_entered_at
  FROM growth.miniapp_entries entries
  LEFT JOIN miniapp.users u ON u.id = entries.user_id
  GROUP BY entries.source_id
) e ON e.source_id = l.source_id;

ALTER TABLE growth.channel_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.link_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth.miniapp_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA growth FROM anon, authenticated;
GRANT USAGE ON SCHEMA growth TO service_role, postgres;
GRANT ALL ON ALL TABLES IN SCHEMA growth TO service_role, postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA growth TO service_role, postgres;
