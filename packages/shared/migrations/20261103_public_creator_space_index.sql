-- Domain: app_core. Index the public alias on creator ownership rows (including existing works).
-- This index does not grant access; the API checks discoverability on every read.
-- Rollback: DROP INDEX IF EXISTS app_core.character_creations_public_author_idx;
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
CREATE INDEX IF NOT EXISTS character_creations_public_author_idx
  ON app_core.character_creations (((md5('st-public-creator-v1:' || owner_user_id::text))::uuid));
COMMIT;
