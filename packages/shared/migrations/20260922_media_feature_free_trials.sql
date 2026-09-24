-- 20260922：语音/基础图片免费试用，仅限主媒体扣费，以及高级图片快照。
-- 域：体验   计费   应用核心
--
-- 通过已建立的迁移工作流手动执行；在生产前先在测试中验证。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE experience.chat_message_audio
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'legacy_free',
  ADD COLUMN IF NOT EXISTS free_trial_ordinal INTEGER,
  ADD COLUMN IF NOT EXISTS price_credits NUMERIC(14,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_label TEXT NOT NULL DEFAULT '';

ALTER TABLE experience.chat_message_audio
  DROP CONSTRAINT IF EXISTS chat_message_audio_billing_mode_check,
  ADD CONSTRAINT chat_message_audio_billing_mode_check
    CHECK (billing_mode IN ('legacy_free', 'free_trial', 'paid')),
  DROP CONSTRAINT IF EXISTS chat_message_audio_free_trial_ordinal_check,
  ADD CONSTRAINT chat_message_audio_free_trial_ordinal_check
    CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 3),
  DROP CONSTRAINT IF EXISTS chat_message_audio_price_credits_check,
  ADD CONSTRAINT chat_message_audio_price_credits_check
    CHECK (price_credits >= 0);

ALTER TABLE experience.chat_message_images
  ADD COLUMN IF NOT EXISTS image_tier TEXT NOT NULL DEFAULT 'basic',
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS free_trial_ordinal INTEGER,
  ADD COLUMN IF NOT EXISTS wallet_policy TEXT NOT NULL DEFAULT 'main_only',
  ADD COLUMN IF NOT EXISTS vip_valid_until TIMESTAMPTZ;

ALTER TABLE experience.chat_message_images
  DROP CONSTRAINT IF EXISTS chat_message_images_image_tier_check,
  ADD CONSTRAINT chat_message_images_image_tier_check
    CHECK (image_tier IN ('basic', 'advanced')),
  DROP CONSTRAINT IF EXISTS chat_message_images_billing_mode_check,
  ADD CONSTRAINT chat_message_images_billing_mode_check
    CHECK (billing_mode IN ('free_trial', 'paid')),
  DROP CONSTRAINT IF EXISTS chat_message_images_free_trial_ordinal_check,
  ADD CONSTRAINT chat_message_images_free_trial_ordinal_check
    CHECK (free_trial_ordinal IS NULL OR free_trial_ordinal BETWEEN 1 AND 3),
  DROP CONSTRAINT IF EXISTS chat_message_images_wallet_policy_check,
  ADD CONSTRAINT chat_message_images_wallet_policy_check
    CHECK (wallet_policy = 'main_only'),
  DROP CONSTRAINT IF EXISTS chat_message_images_tier_billing_check,
  ADD CONSTRAINT chat_message_images_tier_billing_check
    CHECK (
      (image_tier = 'basic')
      OR (image_tier = 'advanced' AND billing_mode = 'paid' AND free_trial_ordinal IS NULL)
    ),
  DROP CONSTRAINT IF EXISTS chat_message_images_current_requires_charged_ready,
  ADD CONSTRAINT chat_message_images_current_requires_charged_ready CHECK (
    NOT is_current
    OR (
      status = 'ready'
      AND (
        (
          billing_mode = 'free_trial'
          AND image_tier = 'basic'
          AND debit_ledger_id IS NULL
          AND credits_charged = 0
          AND free_trial_ordinal BETWEEN 1 AND 3
        )
        OR (
          billing_mode = 'paid'
          AND debit_ledger_id IS NOT NULL
          AND credits_charged > 0
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION billing.settle_voice_generation(
  p_audio_id UUID,
  p_user_id UUID,
  p_amount NUMERIC,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_audio experience.chat_message_audio%ROWTYPE;
  v_wallet billing.user_wallets%ROWTYPE;
  v_amount NUMERIC(14,1) := round(GREATEST(COALESCE(p_amount, 0), 0), 1);
  v_debit JSONB;
  v_trial JSONB;
  v_ledger UUID;
BEGIN
  IF p_audio_id IS NULL OR p_user_id IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid voice settlement input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_audio
  FROM experience.chat_message_audio
  WHERE id = p_audio_id
  FOR UPDATE;

  IF NOT FOUND OR v_audio.user_id <> p_user_id THEN
    RAISE EXCEPTION 'voice attempt not found or owner mismatch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO billing.user_wallets(user_id)
  VALUES (p_user_id)
  ON CONFLICT(user_id) DO NOTHING;

  IF v_audio.status = 'ready' THEN
    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
    IF v_audio.billing_mode = 'free_trial' THEN
      RETURN jsonb_build_object(
        'charge_status', 'already_free_trial_consumed',
        'wallet', to_jsonb(v_wallet),
        'ledger_id', NULL
      );
    END IF;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', to_jsonb(v_wallet),
      'ledger_id', v_audio.debit_ledger_id
    );
  END IF;

  IF v_audio.status <> 'pending' THEN
    RAISE EXCEPTION 'voice attempt is not pending' USING ERRCODE = '55000';
  END IF;

  IF v_audio.billing_mode = 'free_trial' THEN
    v_trial := billing.consume_feature_free_trial(p_user_id, 'voice', p_audio_id::text);
    IF COALESCE((v_trial ->> 'ok')::boolean, false) IS NOT TRUE THEN
      UPDATE experience.chat_message_audio
      SET status = 'failed',
          error_code = 'voice_free_trial_invalid',
          latency_ms = COALESCE(NULLIF(p_metadata ->> 'latency_ms', '')::integer, latency_ms),
          updated_at = now()
      WHERE id = p_audio_id;
      SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
      RETURN jsonb_build_object(
        'charge_status', 'free_trial_invalid',
        'wallet', to_jsonb(v_wallet)
      );
    END IF;

    UPDATE experience.chat_message_audio
    SET is_active = false,
        updated_at = now()
    WHERE message_id = v_audio.message_id
      AND is_active = true
      AND id <> p_audio_id;

    UPDATE experience.chat_message_audio
    SET status = 'ready',
        is_active = true,
        spoken_text = COALESCE(p_metadata ->> 'spoken_text', spoken_text),
        spoken_chars = char_length(COALESCE(p_metadata ->> 'spoken_text', spoken_text, '')),
        storage_path = COALESCE(p_metadata ->> 'storage_path', storage_path),
        audio_url = COALESCE(p_metadata ->> 'audio_url', audio_url),
        duration_ms = COALESCE(NULLIF(p_metadata ->> 'duration_ms', '')::integer, duration_ms),
        latency_ms = COALESCE(NULLIF(p_metadata ->> 'latency_ms', '')::integer, latency_ms),
        error_code = NULL,
        credits_charged = 0,
        debit_ledger_id = NULL,
        charged_at = NULL,
        updated_at = now()
    WHERE id = p_audio_id;

    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'charge_status',
      CASE WHEN v_trial ->> 'status' = 'already_consumed'
        THEN 'already_free_trial_consumed'
        ELSE 'free_trial_consumed'
      END,
      'wallet', to_jsonb(v_wallet),
      'ledger_id', NULL
    );
  END IF;

  BEGIN
    v_debit := billing.apply_wallet_debit(
      p_user_id,
      p_audio_id::text,
      'main_only',
      v_amount,
      'chat_debit',
      'voice_usage',
      p_audio_id::text,
      COALESCE(p_metadata, '{}'::jsonb)
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'MAIN_CREDITS_INSUFFICIENT' THEN
      SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
      RETURN jsonb_build_object(
        'charge_status', 'insufficient_balance',
        'wallet', to_jsonb(v_wallet),
        'required', v_amount,
        'available', COALESCE(v_wallet.main_credits, 0)
      );
    END IF;
    RAISE;
  END;

  v_ledger := NULLIF(v_debit ->> 'ledger_id', '')::uuid;
  SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;

  UPDATE experience.chat_message_audio
  SET is_active = false,
      updated_at = now()
  WHERE message_id = v_audio.message_id
    AND is_active = true
    AND id <> p_audio_id;

  UPDATE experience.chat_message_audio
  SET status = 'ready',
      is_active = true,
      spoken_text = COALESCE(p_metadata ->> 'spoken_text', spoken_text),
      spoken_chars = char_length(COALESCE(p_metadata ->> 'spoken_text', spoken_text, '')),
      storage_path = COALESCE(p_metadata ->> 'storage_path', storage_path),
      audio_url = COALESCE(p_metadata ->> 'audio_url', audio_url),
      duration_ms = COALESCE(NULLIF(p_metadata ->> 'duration_ms', '')::integer, duration_ms),
      latency_ms = COALESCE(NULLIF(p_metadata ->> 'latency_ms', '')::integer, latency_ms),
      error_code = NULL,
      credits_charged = v_amount,
      debit_ledger_id = v_ledger,
      charged_at = now(),
      updated_at = now()
  WHERE id = p_audio_id;

  RETURN jsonb_build_object(
    'charge_status',
    CASE WHEN v_debit ->> 'status' = 'already_debited'
      THEN 'already_charged'
      ELSE 'charged'
    END,
    'wallet', to_jsonb(v_wallet),
    'ledger_id', v_ledger
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.settle_voice_generation(UUID, UUID, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.settle_voice_generation(UUID, UUID, NUMERIC, JSONB)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION billing.settle_image_generation(
  p_attempt_id UUID,
  p_user_id UUID,
  p_amount NUMERIC,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt experience.chat_message_images%ROWTYPE;
  v_wallet billing.user_wallets%ROWTYPE;
  v_amount NUMERIC(14,1) := round(GREATEST(COALESCE(p_amount, 0), 0), 1);
  v_storage_path TEXT := NULLIF(p_metadata ->> 'storage_path', '');
  v_image_url TEXT := NULLIF(p_metadata ->> 'image_url', '');
  v_mime_type TEXT := NULLIF(p_metadata ->> 'mime_type', '');
  v_byte_size INTEGER := NULLIF(p_metadata ->> 'byte_size', '')::integer;
  v_latency_ms INTEGER := NULLIF(p_metadata ->> 'latency_ms', '')::integer;
  v_debit JSONB;
  v_trial JSONB;
  v_ledger UUID;
BEGIN
  IF p_attempt_id IS NULL OR p_user_id IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid image generation settlement input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_attempt
  FROM experience.chat_message_images
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND OR v_attempt.user_id <> p_user_id THEN
    RAISE EXCEPTION 'image attempt not found or owner mismatch' USING ERRCODE = '42501';
  END IF;

  IF v_attempt.status = 'ready' THEN
    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
    IF v_attempt.billing_mode = 'free_trial' THEN
      RETURN jsonb_build_object(
        'charge_status', 'already_free_trial_consumed',
        'wallet', to_jsonb(v_wallet),
        'ledger_id', NULL
      );
    END IF;
    RETURN jsonb_build_object(
      'charge_status', 'already_charged',
      'wallet', to_jsonb(v_wallet),
      'ledger_id', v_attempt.debit_ledger_id
    );
  END IF;

  IF v_attempt.status IN ('failed', 'failed_unknown') THEN
    RAISE EXCEPTION 'image attempt is already terminal' USING ERRCODE = '55000';
  END IF;

  IF v_amount <> v_attempt.price_credits THEN
    RAISE EXCEPTION 'image charge amount does not match attempt snapshot' USING ERRCODE = '22023';
  END IF;

  IF v_storage_path IS NULL
     OR v_image_url IS NULL
     OR v_mime_type NOT IN ('image/webp', 'image/png', 'image/jpeg')
     OR v_byte_size IS NULL
     OR v_byte_size <= 0 THEN
    RAISE EXCEPTION 'image settlement requires stored image metadata' USING ERRCODE = '22023';
  END IF;

  INSERT INTO billing.user_wallets(user_id)
  VALUES (p_user_id)
  ON CONFLICT(user_id) DO NOTHING;

  IF v_attempt.billing_mode = 'free_trial' THEN
    v_trial := billing.consume_feature_free_trial(p_user_id, 'basic_image', p_attempt_id::text);
    IF COALESCE((v_trial ->> 'ok')::boolean, false) IS NOT TRUE THEN
      UPDATE experience.chat_message_images
      SET status = 'failed',
          error_code = 'image_free_trial_invalid',
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

      SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
      RETURN jsonb_build_object(
        'charge_status', 'free_trial_invalid',
        'wallet', to_jsonb(v_wallet)
      );
    END IF;

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
        credits_charged = 0,
        debit_ledger_id = NULL,
        charged_at = NULL,
        completed_at = now(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = p_attempt_id;

    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'charge_status',
      CASE WHEN v_trial ->> 'status' = 'already_consumed'
        THEN 'already_free_trial_consumed'
        ELSE 'free_trial_consumed'
      END,
      'wallet', to_jsonb(v_wallet),
      'ledger_id', NULL
    );
  END IF;

  BEGIN
    v_debit := billing.apply_wallet_debit(
      p_user_id,
      p_attempt_id::text,
      'main_only',
      v_amount,
      'image_generation',
      'image_generation',
      p_attempt_id::text,
      COALESCE(p_metadata, '{}'::jsonb) ||
      jsonb_build_object(
        'session_id', v_attempt.session_id,
        'message_id', v_attempt.message_id,
        'attempt_no', v_attempt.attempt_no,
        'tier', v_attempt.image_tier,
        'provider', v_attempt.provider,
        'model', v_attempt.model,
        'width', v_attempt.width,
        'height', v_attempt.height
      )
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM = 'MAIN_CREDITS_INSUFFICIENT' THEN
      SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
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
        'available', COALESCE(v_wallet.main_credits, 0)
      );
    END IF;
    RAISE;
  END;

  v_ledger := NULLIF(v_debit ->> 'ledger_id', '')::uuid;
  SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;

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
    'charge_status',
    CASE WHEN v_debit ->> 'status' = 'already_debited'
      THEN 'already_charged'
      ELSE 'charged'
    END,
    'wallet', to_jsonb(v_wallet),
    'ledger_id', v_ledger
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.settle_image_generation(UUID, UUID, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.settle_image_generation(UUID, UUID, NUMERIC, JSONB)
  TO service_role, postgres;

INSERT INTO app_core.runtime_config(key, value, description, version, updated_at, text_value)
VALUES
  ('image_advanced_enabled', 'false'::jsonb, '高级图片入口开关；配置未完整前保持关闭。', 1, now(), NULL),
  ('image_advanced_generation_credits', '120'::jsonb, '高级图片单张成功生成后扣费额，仅扣 main credits。', 1, now(), NULL),
  ('image_advanced_price_label', '"120 星尘"'::jsonb, '高级图片按钮展示价格文案。', 1, now(), NULL),
  ('image_advanced_provider_config', '{}'::jsonb, '高级图片 provider 配置，需包含 provider 与 model；默认空对象表示不可用。', 1, now(), NULL)
ON CONFLICT(key) DO NOTHING;

DO $$
BEGIN
  IF to_regprocedure('billing.settle_voice_generation(uuid,uuid,numeric,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'postflight: settle_voice_generation missing';
  END IF;
  IF to_regprocedure('billing.settle_image_generation(uuid,uuid,numeric,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'postflight: settle_image_generation missing';
  END IF;
END;
$$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Rollback sketch:
--   Deploy code with media billing disabled first.
--   DROP FUNCTION IF EXISTS billing.settle_voice_generation(UUID, UUID, NUMERIC, JSONB);
--   Re-run the previous settle_image_generation definition from 20260914 if needed.
--   ALTER TABLE experience.chat_message_images DROP COLUMN IF EXISTS vip_valid_until,
--     DROP COLUMN IF EXISTS wallet_policy, DROP COLUMN IF EXISTS free_trial_ordinal,
--     DROP COLUMN IF EXISTS billing_mode, DROP COLUMN IF EXISTS image_tier;
--   ALTER TABLE experience.chat_message_audio DROP COLUMN IF EXISTS price_label,
--     DROP COLUMN IF EXISTS price_credits, DROP COLUMN IF EXISTS free_trial_ordinal,
--     DROP COLUMN IF EXISTS billing_mode;
