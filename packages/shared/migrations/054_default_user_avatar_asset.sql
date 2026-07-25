-- 054: Host the platform default avatar in the migration-managed bucket.
--
-- The default avatar previously lived in an ad-hoc `miniapp-users` bucket that was
-- created by hand in test only, so production had nowhere to serve it from. Reuse
-- `miniapp-user-avatars` (030) instead and raise its ceiling to fit the asset.
-- User-imported avatars stay capped at 2 MiB by MAX_AVATAR_BYTES in the backend,
-- so the wider bucket limit does not widen what users can upload.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'miniapp-user-avatars',
  'miniapp-user-avatars',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
