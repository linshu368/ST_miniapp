-- 105_voice_billing_atomic.sql
-- 语音生成成功后原子扣费并收口 ready。手工 migration；先在 test 验证，勿直接执行 production。
BEGIN;

ALTER TABLE experience.chat_message_audio
  ADD COLUMN IF NOT EXISTS credits_charged NUMERIC(14,1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS debit_ledger_id UUID,
  ADD COLUMN IF NOT EXISTS charged_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_audio_debit_ledger
  ON experience.chat_message_audio(debit_ledger_id) WHERE debit_ledger_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_message_audio_pending
  ON experience.chat_message_audio(message_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_chat_message_audio_session_all
  ON experience.chat_message_audio(session_id);

CREATE OR REPLACE FUNCTION billing.charge_voice_usage(
  p_charge_key UUID,
  p_user_id UUID,
  p_audio_id UUID,
  p_amount NUMERIC,
  p_metadata JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_audio experience.chat_message_audio;
  v_wallet billing.user_wallets;
  v_amount NUMERIC(14,1) := round(GREATEST(COALESCE(p_amount, 0), 0), 1);
  v_available NUMERIC(14,1);
  v_bonus NUMERIC(14,1);
  v_main NUMERIC(14,1);
  v_ledger UUID;
BEGIN
  IF p_charge_key IS NULL OR p_audio_id IS NULL OR p_charge_key <> p_audio_id
     OR p_user_id IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid voice usage charge input' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_audio FROM experience.chat_message_audio
  WHERE id = p_audio_id FOR UPDATE;
  IF NOT FOUND OR v_audio.user_id <> p_user_id THEN
    RAISE EXCEPTION 'voice attempt not found or owner mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_audio.debit_ledger_id IS NOT NULL THEN
    SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object('charge_status','already_charged','wallet',to_jsonb(v_wallet),
      'ledger_id',v_audio.debit_ledger_id);
  END IF;
  IF v_audio.status <> 'pending' THEN
    RAISE EXCEPTION 'voice attempt is not pending' USING ERRCODE = '55000';
  END IF;

  INSERT INTO billing.user_wallets(user_id) VALUES(p_user_id) ON CONFLICT(user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id FOR UPDATE;
  v_available := v_wallet.main_credits + v_wallet.bonus_credits;
  IF v_available < v_amount THEN
    RETURN jsonb_build_object('charge_status','insufficient_balance','wallet',to_jsonb(v_wallet),
      'required',v_amount,'available',v_available);
  END IF;

  v_bonus := LEAST(v_wallet.bonus_credits, v_amount);
  v_main := v_amount - v_bonus;
  UPDATE billing.user_wallets SET bonus_credits=bonus_credits-v_bonus,
    main_credits=main_credits-v_main, updated_at=now()
  WHERE user_id=p_user_id RETURNING * INTO v_wallet;

  INSERT INTO billing.wallet_ledger(user_id,entry_type,amount,main_delta,bonus_delta,
    balance_main,balance_bonus,reference_type,reference_id,metadata)
  VALUES(p_user_id,'chat_debit',-v_amount,-v_main,-v_bonus,v_wallet.main_credits,
    v_wallet.bonus_credits,'voice_usage',p_audio_id::TEXT,COALESCE(p_metadata,'{}'::JSONB))
  RETURNING id INTO v_ledger;

  UPDATE experience.chat_message_audio SET is_active=false, updated_at=now()
  WHERE message_id=v_audio.message_id AND is_active=true AND id<>p_audio_id;

  UPDATE experience.chat_message_audio SET status='ready', is_active=true,
    spoken_text=p_metadata->>'spoken_text', spoken_chars=char_length(COALESCE(p_metadata->>'spoken_text','')),
    storage_path=p_metadata->>'storage_path', audio_url=p_metadata->>'audio_url',
    duration_ms=NULLIF(p_metadata->>'duration_ms','')::INTEGER,
    latency_ms=NULLIF(p_metadata->>'latency_ms','')::INTEGER, error_code=NULL,
    credits_charged=v_amount, debit_ledger_id=v_ledger, charged_at=now(), updated_at=now()
  WHERE id=p_audio_id;

  RETURN jsonb_build_object('charge_status','charged','wallet',to_jsonb(v_wallet),'ledger_id',v_ledger);
END;
$$;

REVOKE ALL ON FUNCTION billing.charge_voice_usage(UUID,UUID,UUID,NUMERIC,JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.charge_voice_usage(UUID,UUID,UUID,NUMERIC,JSONB)
  TO service_role, postgres;

INSERT INTO app_core.runtime_config(key,value,description,version,updated_at,text_value) VALUES
('voice_billing_enabled','false'::JSONB,'语音计费开关；测试确认后开启',1,now(),NULL),
('voice_generation_credits','15'::JSONB,'每次成功生成语音扣费额',1,now(),NULL),
('voice_max_spoken_chars','300'::JSONB,'送入语音模型的最终文本上限',1,now(),NULL),
('voice_price_label','"15 星尘"'::JSONB,'语音入口价格文案',1,now(),NULL),
('voice_over_limit_hint','"文字处理后的语音文本超过 300 字，请删减或缩改后再生成"'::JSONB,'超限行内提示',1,now(),NULL),
('voice_draft_failed_hint','"本次未生成，请稍后重试"'::JSONB,'文本处理失败提示',1,now(),NULL),
('voice_tts_failed_hint','"语音生成失败，请重试"'::JSONB,'语音模型失败提示',1,now(),NULL)
ON CONFLICT(key) DO NOTHING;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Rollback（关闭 voice_billing_enabled 并停用应用后执行）：
-- DROP FUNCTION IF EXISTS billing.charge_voice_usage(UUID,UUID,UUID,NUMERIC,JSONB);
-- DROP INDEX IF EXISTS experience.uq_chat_message_audio_debit_ledger;
-- DROP INDEX IF EXISTS experience.uq_chat_message_audio_pending;
-- DROP INDEX IF EXISTS experience.idx_chat_message_audio_session_all;
-- ALTER TABLE experience.chat_message_audio DROP COLUMN IF EXISTS charged_at,
--   DROP COLUMN IF EXISTS debit_ledger_id, DROP COLUMN IF EXISTS credits_charged;
-- DELETE FROM app_core.runtime_config WHERE key LIKE 'voice_%';