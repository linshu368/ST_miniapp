-- Domain: app_core. Persistent creator-owned cover identity shared by lobby/chat/creator.
-- Execute before 20261030_creator_characters.sql. No production execution is implicit.
-- Rollback: disable creation/upload entry; keep referenced assets. Never delete live covers.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS app_core.character_cover_assets (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE RESTRICT,
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app_core.character_cover_assets IS 'Immutable creator cover assets; temporary signed URLs are never stored.';
CREATE INDEX IF NOT EXISTS character_cover_assets_owner_idx ON app_core.character_cover_assets(owner_user_id,created_at DESC);
ALTER TABLE app_core.character_cover_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_core.character_cover_assets FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON app_core.character_cover_assets TO service_role;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('character-covers','character-covers',false,20971520,ARRAY['image/png','image/jpeg','image/webp'])
ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
COMMIT;
