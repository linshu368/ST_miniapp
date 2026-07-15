-- 030: Separate Telegram and user-imported avatars.
--
-- avatar_url previously mixed both concepts and was overwritten on every Telegram
-- profile refresh. Keep it as a legacy column, but move runtime reads to the two
-- explicit sources below. Effective priority is custom > Telegram > platform default.

ALTER TABLE miniapp.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS tg_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS custom_avatar_url TEXT;

UPDATE miniapp.miniapp_user_settings
SET tg_avatar_url = avatar_url
WHERE tg_avatar_url IS NULL
  AND avatar_url IS NOT NULL;

COMMENT ON COLUMN miniapp.miniapp_user_settings.tg_avatar_url IS
  'Latest avatar URL supplied by Telegram initData; refreshed on authenticated requests.';
COMMENT ON COLUMN miniapp.miniapp_user_settings.custom_avatar_url IS
  'User-imported avatar stored in platform-managed Supabase Storage; takes priority over Telegram.';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'miniapp-user-avatars',
  'miniapp-user-avatars',
  true,
  2097152,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;
