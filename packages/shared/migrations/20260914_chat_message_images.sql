-- 20260914: 聊天消息图片生成 attempt、任务租约、成功结算与运行时配置。
-- domain: experience + billing + app_core + admin
--
-- 执行：GitHub Actions → Database Migration，先 test 后 production。
-- 发布顺序：本迁移 + Storage bucket → backend secret/runtime config → backend → frontend → 开关灰度。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('app_core.users') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('experience.chat_sessions') IS NULL
     OR to_regclass('experience.chat_history') IS NULL
     OR to_regclass('billing.user_wallets') IS NULL
     OR to_regclass('billing.wallet_ledger') IS NULL THEN
    RAISE EXCEPTION 'chat image migration requires schema split 099+ objects';
  END IF;

  IF to_regprocedure('admin.validate_managed_config_value_before_payment_prompt(text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'managed config baseline is not 095/104/105 compatible';
  END IF;

  IF to_regprocedure('admin.validate_lobby_pinned_characters(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_payment_prompt_dialog_config(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_invite_reward_rules(jsonb)') IS NULL
     OR to_regprocedure('admin.validate_invite_center_config(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'managed config validators are incomplete; run lobby/payment/invite config migrations first';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS experience.chat_message_images (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  session_id          UUID NOT NULL REFERENCES experience.chat_sessions(id) ON DELETE CASCADE,
  message_id          UUID NOT NULL REFERENCES experience.chat_history(id) ON DELETE CASCADE,
  attempt_no          INTEGER NOT NULL CHECK (attempt_no > 0),

  prompt_cn           TEXT NOT NULL CHECK (char_length(prompt_cn) BETWEEN 1 AND 200),
  prompt_source       TEXT NOT NULL CHECK (prompt_source IN ('generated', 'custom')),
  prompt_en           TEXT,
  provider_prompt     TEXT,

  provider            TEXT NOT NULL DEFAULT 'liaobots_grok',
  model               TEXT NOT NULL,
  base_url_host       TEXT,
  width               INTEGER NOT NULL CHECK (width > 0),
  height              INTEGER NOT NULL CHECK (height > 0),
  output_format       TEXT NOT NULL DEFAULT 'webp'
                      CHECK (output_format IN ('webp', 'png', 'jpeg')),
  price_credits       NUMERIC(14,1) NOT NULL CHECK (price_credits > 0),
  price_label         TEXT NOT NULL CHECK (char_length(trim(price_label)) BETWEEN 1 AND 40),

  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'leased', 'generating', 'storing', 'ready', 'failed', 'failed_unknown')),
  is_current          BOOLEAN NOT NULL DEFAULT false,
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage               TEXT,
  provider_request_id TEXT,

  storage_path        TEXT,
  image_url           TEXT,
  mime_type           TEXT CHECK (mime_type IS NULL OR mime_type IN ('image/webp', 'image/png', 'image/jpeg')),
  byte_size           INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  latency_ms          INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code          TEXT,

  credits_charged     NUMERIC(14,1) NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  debit_ledger_id     UUID REFERENCES billing.wallet_ledger(id),
  charged_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chat_message_images_attempt_unique UNIQUE (message_id, attempt_no),
  CONSTRAINT chat_message_images_ready_requires_storage CHECK (
    status <> 'ready'
    OR (storage_path IS NOT NULL AND image_url IS NOT NULL AND mime_type IS NOT NULL AND byte_size IS NOT NULL)
  ),
  CONSTRAINT chat_message_images_current_requires_charged_ready CHECK (
    NOT is_current
    OR (status = 'ready' AND debit_ledger_id IS NOT NULL AND credits_charged > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_images_current
  ON experience.chat_message_images(message_id)
  WHERE is_current;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_images_inflight
  ON experience.chat_message_images(message_id)
  WHERE status IN ('pending', 'leased', 'generating', 'storing');

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_images_debit_ledger
  ON experience.chat_message_images(debit_ledger_id)
  WHERE debit_ledger_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_image_generation_reference
  ON billing.wallet_ledger(reference_type, reference_id)
  WHERE reference_type = 'image_generation';

CREATE INDEX IF NOT EXISTS idx_chat_message_images_session
  ON experience.chat_message_images(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_message_images_user_created
  ON experience.chat_message_images(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_message_images_claim
  ON experience.chat_message_images(next_attempt_at, created_at)
  WHERE status IN ('pending', 'leased');

COMMENT ON TABLE experience.chat_message_images IS
  '角色回复的图片生成 attempt。每次用户确认创建一行；成功后当前图与钱包扣费在同一事务内收口。';
COMMENT ON COLUMN experience.chat_message_images.prompt_cn IS
  '用户确认的中文短文。默认写稿与自定义路径共用 1~1000 字上限，不静默截断。';
COMMENT ON COLUMN experience.chat_message_images.prompt_en IS
  '内部 DeepSeek 直译英文，仅供 provider 输入和受控排障，不返回前端、不写日志。';
COMMENT ON COLUMN experience.chat_message_images.provider_prompt IS
  '内部最终生图 prompt，含角色锚点、英文场景和健康向控制尾巴；不得返回前端。';
COMMENT ON COLUMN experience.chat_message_images.status IS
  'pending/leased 为数据库任务队列状态；generating 之后模糊超时不得自动重投；ready 才计费展示。';

ALTER TABLE experience.chat_message_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON experience.chat_message_images FROM PUBLIC, anon, authenticated;
GRANT ALL ON experience.chat_message_images TO service_role, postgres;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'miniapp-chat-images',
  'miniapp-chat-images',
  true,
  15728640,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION experience.claim_chat_image_jobs(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 5,
  p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF experience.chat_message_images
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 5), 1), 20);
  v_lease_seconds INTEGER := LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 30), 900);
BEGIN
  IF trim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'claim_chat_image_jobs: worker id is required'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT img.id
    FROM experience.chat_message_images AS img
    WHERE img.next_attempt_at <= now()
      AND (
        img.status = 'pending'
        OR (img.status = 'leased' AND img.lease_expires_at < now())
      )
    ORDER BY img.created_at, img.id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE experience.chat_message_images AS img
  SET status = 'leased',
      lease_owner = left(p_worker_id, 128),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      stage = 'leased',
      updated_at = now()
  FROM candidates
  WHERE img.id = candidates.id
  RETURNING img.*;
END;
$$;

REVOKE ALL ON FUNCTION experience.claim_chat_image_jobs(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.claim_chat_image_jobs(TEXT, INTEGER, INTEGER)
  TO service_role, postgres;

COMMENT ON FUNCTION experience.claim_chat_image_jobs(TEXT, INTEGER, INTEGER) IS
  '领取图片生成任务：只重领 pending 和未发 provider 前过期的 leased；不自动重投 generating 模糊区。';

-- CHECK 重建会拿 billing.wallet_ledger 的强锁；lock_timeout=5s 保证高峰期不长期阻塞账务。
-- test/prod 执行记录必须写明锁等待结果。若目标库 ledger 过大或高峰失败，改走维护窗口重试。
ALTER TABLE billing.wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;
ALTER TABLE billing.wallet_ledger
  ADD CONSTRAINT wallet_ledger_entry_type_check
  CHECK (entry_type IN (
    'recharge', 'chat_debit', 'refund', 'adjustment',
    'checkin_bonus', 'wish_reward', 'invite_reward', 'community_reward',
    'image_generation'
  ));

CREATE OR REPLACE FUNCTION billing.settle_image_generation(
  p_attempt_id UUID,
  p_user_id UUID,
  p_amount NUMERIC,
  p_metadata JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt experience.chat_message_images%ROWTYPE;
  v_wallet billing.user_wallets%ROWTYPE;
  v_amount NUMERIC(14,1) := round(GREATEST(COALESCE(p_amount, 0), 0), 1);
  v_available NUMERIC(14,1);
  v_bonus NUMERIC(14,1);
  v_main NUMERIC(14,1);
  v_ledger UUID;
  v_storage_path TEXT := NULLIF(p_metadata ->> 'storage_path', '');
  v_image_url TEXT := NULLIF(p_metadata ->> 'image_url', '');
  v_mime_type TEXT := NULLIF(p_metadata ->> 'mime_type', '');
  v_byte_size INTEGER := NULLIF(p_metadata ->> 'byte_size', '')::INTEGER;
  v_latency_ms INTEGER := NULLIF(p_metadata ->> 'latency_ms', '')::INTEGER;
BEGIN
  IF p_attempt_id IS NULL OR p_user_id IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid image generation settlement input'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_attempt
  FROM experience.chat_message_images
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND OR v_attempt.user_id <> p_user_id THEN
    RAISE EXCEPTION 'image attempt not found or owner mismatch'
      USING ERRCODE = '42501';
  END IF;

  IF v_attempt.debit_ledger_id IS NOT NULL THEN
    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', to_jsonb(v_wallet),
      'ledger_id', v_attempt.debit_ledger_id
    );
  END IF;

  IF v_attempt.status IN ('ready', 'failed', 'failed_unknown') THEN
    RAISE EXCEPTION 'image attempt is already terminal'
      USING ERRCODE = '55000';
  END IF;

  IF v_amount <> v_attempt.price_credits THEN
    RAISE EXCEPTION 'image charge amount does not match attempt snapshot'
      USING ERRCODE = '22023';
  END IF;

  IF v_storage_path IS NULL
     OR v_image_url IS NULL
     OR v_mime_type NOT IN ('image/webp', 'image/png', 'image/jpeg')
     OR v_byte_size IS NULL
     OR v_byte_size <= 0 THEN
    RAISE EXCEPTION 'image settlement requires stored image metadata'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO billing.user_wallets(user_id)
  VALUES (p_user_id)
  ON CONFLICT(user_id) DO NOTHING;

  SELECT * INTO v_wallet
  FROM billing.user_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_available := v_wallet.main_credits + v_wallet.bonus_credits;
  IF v_available < v_amount THEN
    UPDATE experience.chat_message_images
    SET status = 'failed',
        error_code = 'image_settlement_insufficient_balance',
        storage_path = v_storage_path,
        image_url = v_image_url,
        mime_type = v_mime_type,
        byte_size = v_byte_size,
        latency_ms = v_latency_ms,
        lease_owner = NULL,
        lease_expires_at = NULL,
        completed_at = now(),
        updated_at = now()
    WHERE id = p_attempt_id;

    RETURN jsonb_build_object(
      'charge_status', 'insufficient_balance',
      'wallet', to_jsonb(v_wallet),
      'required', v_amount,
      'available', v_available
    );
  END IF;

  v_bonus := LEAST(v_wallet.bonus_credits, v_amount);
  v_main := v_amount - v_bonus;

  UPDATE billing.user_wallets
  SET bonus_credits = bonus_credits - v_bonus,
      main_credits = main_credits - v_main,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_wallet;

  INSERT INTO billing.wallet_ledger(
    user_id, entry_type, amount, main_delta, bonus_delta,
    balance_main, balance_bonus, reference_type, reference_id, metadata
  )
  VALUES (
    p_user_id, 'image_generation', -v_amount, -v_main, -v_bonus,
    v_wallet.main_credits, v_wallet.bonus_credits,
    'image_generation', p_attempt_id::TEXT,
    jsonb_build_object(
      'session_id', v_attempt.session_id,
      'message_id', v_attempt.message_id,
      'attempt_no', v_attempt.attempt_no,
      'provider', v_attempt.provider,
      'model', v_attempt.model,
      'width', v_attempt.width,
      'height', v_attempt.height,
      'mime_type', v_mime_type,
      'byte_size', v_byte_size
    )
  )
  RETURNING id INTO v_ledger;

  UPDATE experience.chat_message_images
  SET is_current = false,
      updated_at = now()
  WHERE message_id = v_attempt.message_id
    AND is_current = true
    AND id <> p_attempt_id;

  UPDATE experience.chat_message_images
  SET status = 'ready',
      is_current = true,
      storage_path = v_storage_path,
      image_url = v_image_url,
      mime_type = v_mime_type,
      byte_size = v_byte_size,
      latency_ms = v_latency_ms,
      error_code = NULL,
      credits_charged = v_amount,
      debit_ledger_id = v_ledger,
      charged_at = now(),
      completed_at = now(),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = now()
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'charge_status', 'charged',
    'wallet', to_jsonb(v_wallet),
    'ledger_id', v_ledger
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.settle_image_generation(UUID, UUID, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.settle_image_generation(UUID, UUID, NUMERIC, JSONB)
  TO service_role, postgres;

COMMENT ON FUNCTION billing.settle_image_generation(UUID, UUID, NUMERIC, JSONB) IS
  '图片生成唯一成功结算入口：校验存储元数据，锁钱包，扣星尘，写 ledger，并把 attempt 原子收口为 current ready。';

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at, text_value)
VALUES
  ('image_generation_enabled', 'false'::JSONB, '图片生成入口总开关。关闭时不受理新 attempt，已受理任务继续收口。', 1, now(), NULL),
  ('image_generation_credits', '60'::JSONB, '单张图片成功生成后扣费额。仅 ready 结算成功才实扣。', 1, now(), NULL),
  ('image_price_label', '"60 星尘"'::JSONB, '图片生成按钮展示价格文案。', 1, now(), NULL),
  ('image_default_art_style', '"精致二次元竖幅插画，柔和光影，健康公开发布"'::JSONB, '默认分镜写稿输入的画风说明。', 1, now(), NULL),
  ('image_width', '1024'::JSONB, '图片生成宽度像素。', 1, now(), NULL),
  ('image_height', '1536'::JSONB, '图片生成高度像素。', 1, now(), NULL),
  ('image_max_prompt_chars', '1000'::JSONB, '用户可见中文短文上限；必须与 shared MAX_IMAGE_PROMPT_CHARS 一致。', 1, now(), NULL),
  ('image_max_output_bytes', '15728640'::JSONB, '后端允许转存的最大图片字节数。', 1, now(), NULL),
  ('image_prompt_policy', '"仅生成健康向、可公开发布的单人/场景竖图，不包含露骨、暴力或未成年人性化内容。"'::JSONB, '图片 prompt 健康向控制策略展示与 provider 尾巴来源。', 1, now(), NULL),
  ('image_prompt_over_limit_hint', '"描述最多 1000 字，请删减后再生成。"'::JSONB, '图片描述超限提示。', 1, now(), NULL),
  ('image_description_failed_hint', '"这次没有写出合适的画面描述，请稍后重试。"'::JSONB, '默认写稿失败提示。', 1, now(), NULL),
  ('image_generation_failed_hint', '"图片生成没有成功，本次不消耗星尘。"'::JSONB, '明确失败提示。', 1, now(), NULL),
  ('image_failed_unknown_hint', '"外部平台没有确认成功，本次不消耗星尘。"'::JSONB, '模糊失败提示。', 1, now(), NULL)
ON CONFLICT(key) DO NOTHING;

CREATE OR REPLACE FUNCTION admin.validate_image_generation_config_value(
  p_config_key TEXT,
  p_value JSONB
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_number NUMERIC;
  v_text TEXT;
  v_max_length INTEGER;
BEGIN
  IF p_config_key = 'image_generation_enabled' THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'image_generation_enabled must be a boolean' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN ('image_generation_credits', 'image_width', 'image_height', 'image_max_prompt_chars', 'image_max_output_bytes') THEN
    v_number := NULLIF(p_value #>> '{}', '')::NUMERIC;
    IF v_number IS NULL OR v_number <> floor(v_number) OR v_number <= 0 THEN
      RAISE EXCEPTION '% must be a positive integer', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_config_key = 'image_max_prompt_chars' AND v_number <> 200 THEN
      RAISE EXCEPTION 'image_max_prompt_chars must stay aligned with shared MAX_IMAGE_PROMPT_CHARS=200'
        USING ERRCODE = '22023';
    END IF;
    IF p_config_key IN ('image_width', 'image_height') AND (v_number < 256 OR v_number > 4096) THEN
      RAISE EXCEPTION '% must be between 256 and 4096', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_config_key = 'image_max_output_bytes' AND (v_number < 1048576 OR v_number > 52428800) THEN
      RAISE EXCEPTION 'image_max_output_bytes must be between 1MB and 50MB' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN (
    'image_price_label',
    'image_default_art_style',
    'image_prompt_policy',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ) THEN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION '% must be a string', p_config_key USING ERRCODE = '22023';
    END IF;
    v_text := trim(p_value #>> '{}');
    IF v_text = '' THEN
      RAISE EXCEPTION '% must not be empty', p_config_key USING ERRCODE = '22023';
    END IF;
    v_max_length := 200;
    IF p_config_key IN ('image_default_art_style', 'image_prompt_policy') THEN
      v_max_length := 1000;
    END IF;
    IF char_length(v_text) > v_max_length THEN
      RAISE EXCEPTION '% is too long', p_config_key USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'unknown image generation config key: %', p_config_key
    USING ERRCODE = '22023';
END;
$$;

COMMENT ON FUNCTION admin.validate_image_generation_config_value(TEXT, JSONB) IS
  'Validate image_generation runtime config values; secrets such as Liaobots auth are intentionally not managed here.';

ALTER TABLE admin.config_drafts
  DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts
  ADD CONSTRAINT config_drafts_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled',
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_default_art_style',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_policy',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ));

ALTER TABLE admin.config_releases
  DROP CONSTRAINT IF EXISTS config_releases_config_key_check;
ALTER TABLE admin.config_releases
  ADD CONSTRAINT config_releases_config_key_check CHECK (config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled',
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_default_art_style',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_policy',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ));

CREATE OR REPLACE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p_config_key IN (
    'miniapp_new_user_signup_bonus_credits',
    'miniapp_daily_checkin_bonus_credits',
    'miniapp_character_free_chat_quota_limit',
    'miniapp_payment_plans',
    'miniapp_recharge_page_config',
    'miniapp_payment_prompt_dialog_config',
    'miniapp_free_quota_exhausted_dialog_config',
    'llm_model_catalog',
    'llm_pricing_config',
    'system_fallback_character_id',
    'system_instructions',
    'pref_word_count_tiers',
    'lobby_ranking_params',
    'lobby_pinned_characters',
    'miniapp_invite_reward_rules',
    'miniapp_invite_center_config',
    'miniapp_invite_entry_enabled',
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_default_art_style',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_policy',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  );
$$;

CREATE OR REPLACE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT,
  p_value JSONB,
  p_text_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_config_key = 'lobby_pinned_characters' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'lobby_pinned_characters must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_lobby_pinned_characters(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_payment_prompt_dialog_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_payment_prompt_dialog_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_payment_prompt_dialog_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_reward_rules' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_reward_rules must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_reward_rules(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_center_config' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_center_config must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_invite_center_config(p_value);
    RETURN;
  END IF;

  IF p_config_key = 'miniapp_invite_entry_enabled' THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must not use text_value'
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'miniapp_invite_entry_enabled must be a boolean'
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  IF p_config_key IN (
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_default_art_style',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_policy',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ) THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key
        USING ERRCODE = '22023';
    END IF;
    PERFORM admin.validate_image_generation_config_value(p_config_key, p_value);
    RETURN;
  END IF;

  PERFORM admin.validate_managed_config_value_before_payment_prompt(
    p_config_key,
    p_value,
    p_text_value
  );
END;
$$;

REVOKE ALL ON FUNCTION admin.validate_image_generation_config_value(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.is_managed_config_key(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_key TEXT;
  v_def TEXT;
  v_raised BOOLEAN;
BEGIN
  IF to_regclass('experience.chat_message_images') IS NULL THEN
    RAISE EXCEPTION 'self-check failed: chat_message_images missing';
  END IF;
  IF to_regprocedure('experience.claim_chat_image_jobs(text,integer,integer)') IS NULL
     OR to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'self-check failed: image RPC missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'miniapp-chat-images'
      AND public = true
      AND file_size_limit = 15728640
  ) THEN
    RAISE EXCEPTION 'self-check failed: miniapp-chat-images bucket missing';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'billing.wallet_ledger'::regclass
    AND conname = 'wallet_ledger_entry_type_check';
  IF v_def IS NULL
     OR position('image_generation' IN v_def) = 0
     OR position('community_reward' IN v_def) = 0
     OR position('invite_reward' IN v_def) = 0 THEN
    RAISE EXCEPTION 'self-check failed: wallet_ledger entry_type CHECK incomplete -> %', COALESCE(v_def, 'NULL');
  END IF;

  FOREACH v_key IN ARRAY ARRAY[
    'image_generation_enabled',
    'image_generation_credits',
    'image_price_label',
    'image_default_art_style',
    'image_width',
    'image_height',
    'image_max_prompt_chars',
    'image_max_output_bytes',
    'image_prompt_policy',
    'image_prompt_over_limit_hint',
    'image_description_failed_hint',
    'image_generation_failed_hint',
    'image_failed_unknown_hint'
  ] LOOP
    IF NOT admin.is_managed_config_key(v_key) THEN
      RAISE EXCEPTION 'self-check failed: image key % is not managed', v_key;
    END IF;

    v_raised := FALSE;
    BEGIN
      PERFORM admin.validate_managed_config_value(v_key, '"probe"'::jsonb, 'probe');
    EXCEPTION WHEN OTHERS THEN
      v_raised := TRUE;
      IF position('must not use text_value' IN SQLERRM) = 0 THEN
        RAISE EXCEPTION 'self-check failed: % did not enter image branch, actual error: %', v_key, SQLERRM;
      END IF;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'self-check failed: % silently accepted text_value', v_key;
    END IF;
  END LOOP;

  PERFORM admin.validate_managed_config_value('image_max_prompt_chars', '200'::jsonb, NULL);
  v_raised := FALSE;
  BEGIN
    PERFORM admin.validate_managed_config_value('image_max_prompt_chars', '201'::jsonb, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_raised := TRUE;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'self-check failed: image_max_prompt_chars accepted 201';
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Test 验证建议：
--   SELECT to_regclass('experience.chat_message_images');
--   SELECT to_regprocedure('experience.claim_chat_image_jobs(text,integer,integer)');
--   SELECT to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)');
--   SELECT admin.is_managed_config_key('image_generation_enabled'); -- true
--   SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'miniapp-chat-images';
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid = 'billing.wallet_ledger'::regclass AND conname = 'wallet_ledger_entry_type_check';
