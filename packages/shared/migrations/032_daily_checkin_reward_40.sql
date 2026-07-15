-- 032: Reduce the MiniApp daily check-in reward from 60 to 40 bonus credits.

INSERT INTO miniapp.runtime_config AS config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_daily_checkin_bonus_credits',
  '40'::jsonb,
  'MiniApp 每次签到赠送的 bonus 星尘数，签到间隔为 24 小时。',
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
