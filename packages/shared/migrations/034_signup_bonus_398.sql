-- 034: Reduce the MiniApp new-user signup reward from 600 to 398 bonus credits.
-- Existing users who already received signup_bonus are not changed.

INSERT INTO miniapp.runtime_config AS config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_new_user_signup_bonus_credits',
  '398'::jsonb,
  'MiniApp 新用户首次进入时赠送的 bonus 星尘数。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  version = config.version + 1,
  updated_at = now(),
  text_value = NULL;
