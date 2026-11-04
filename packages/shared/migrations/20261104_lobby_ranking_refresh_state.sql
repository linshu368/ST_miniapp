-- domain: miniapp_features. One backend-only completion marker, committed with the scores.
-- Apply before the new backend; older versions ignore it. Roll back the app and retain the row.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS miniapp_features.lobby_ranking_refresh_state (
  singleton boolean DEFAULT true CONSTRAINT lobby_ranking_refresh_state_pkey PRIMARY KEY
    CONSTRAINT lobby_ranking_refresh_state_singleton_check CHECK (singleton),
  scoring_rules jsonb NOT NULL CONSTRAINT lobby_ranking_refresh_state_rules_check CHECK (jsonb_typeof(scoring_rules) = 'object'),
  completed_at timestamptz NOT NULL
);
ALTER TABLE miniapp_features.lobby_ranking_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_features.lobby_ranking_refresh_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON miniapp_features.lobby_ranking_refresh_state TO service_role;
COMMIT;
