-- 20260928_vip_media_discount_snapshots.sql
-- domain: experience
-- 目的：媒体任务在受理时冻结 VIP 折扣报价，异步生成/结算不重新读取会员或运营配置。
-- 前置：20260922_media_feature_free_trials.sql；20260923_vip_strategy_config.sql。
-- 权威写入方：backend 的 voice/images routes 通过 experience schema repository 写入。
-- 消费者：媒体任务展示、结算审计与消费流水；不新增表、RPC、RLS policy 或 grant。
-- 回滚：字段为可空增量，旧应用可忽略；如需回退业务，先回退应用，再另建 migration 删除无引用字段。

ALTER TABLE experience.chat_message_audio
  ADD COLUMN IF NOT EXISTS original_price_credits NUMERIC(14, 1),
  ADD COLUMN IF NOT EXISTS vip_discount_rate NUMERIC(8, 6),
  ADD COLUMN IF NOT EXISTS vip_discounted_exact NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS vip_valid_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vip_discount_config_version INTEGER;

ALTER TABLE experience.chat_message_images
  ADD COLUMN IF NOT EXISTS original_price_credits NUMERIC(14, 1),
  ADD COLUMN IF NOT EXISTS vip_discount_rate NUMERIC(8, 6),
  ADD COLUMN IF NOT EXISTS vip_discounted_exact NUMERIC(14, 4),
  ADD COLUMN IF NOT EXISTS vip_discount_config_version INTEGER;

ALTER TABLE experience.chat_message_audio
  DROP CONSTRAINT IF EXISTS chat_message_audio_vip_discount_rate_check,
  ADD CONSTRAINT chat_message_audio_vip_discount_rate_check
    CHECK (vip_discount_rate IS NULL OR (vip_discount_rate > 0 AND vip_discount_rate <= 1)) NOT VALID;

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_vip_discount_rate_check,
  ADD CONSTRAINT chat_message_images_vip_discount_rate_check
    CHECK (vip_discount_rate IS NULL OR (vip_discount_rate > 0 AND vip_discount_rate <= 1)) NOT VALID;

COMMENT ON COLUMN experience.chat_message_audio.original_price_credits IS
  '受理时运营配置原价；旧行为空。';
COMMENT ON COLUMN experience.chat_message_audio.vip_discount_rate IS
  '受理时有效 VIP 的媒体折扣率；免费体验和非会员为空。';
COMMENT ON COLUMN experience.chat_message_audio.vip_discounted_exact IS
  '原价乘折扣后的精确值；实扣见 price_credits。';
COMMENT ON COLUMN experience.chat_message_images.original_price_credits IS
  '受理时运营配置原价；旧行为空。';
COMMENT ON COLUMN experience.chat_message_images.vip_discount_rate IS
  '受理时有效 VIP 的媒体折扣率；免费体验和非会员为空。';
COMMENT ON COLUMN experience.chat_message_images.vip_discounted_exact IS
  '原价乘折扣后的精确值；实扣见 price_credits。';

UPDATE app_core.runtime_config
SET description = '有效 VIP 的文本、语音和图片付费生成折扣率，范围 (0, 1]。生成受理时固化到当次快照。'
WHERE key = 'vip_text_discount_rate';
