-- Local T5 voice/basic_image integration scenarios. Throwaway database only.

CREATE SCHEMA IF NOT EXISTS vip_t5_test;

CREATE OR REPLACE FUNCTION vip_t5_test.assert(p_ok BOOLEAN, p_msg TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT COALESCE(p_ok, false) THEN
    RAISE EXCEPTION 'T5 scenario failed: %', p_msg;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t5_test.set_limits(p_voice INTEGER, p_image INTEGER)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE app_core.runtime_config
  SET value = jsonb_build_object('voice', p_voice, 'basic_image', p_image)
  WHERE key = 'feature_free_trial_limits';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'T5 scenario failed: feature_free_trial_limits row missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION vip_t5_test.run()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  u_iso UUID := '00000000-0000-4000-8000-000000000501';
  u_zero UUID := '00000000-0000-4000-8000-000000000502';
  u_raise UUID := '00000000-0000-4000-8000-000000000503';
  u_lower UUID := '00000000-0000-4000-8000-000000000504';
  u_cap UUID := '00000000-0000-4000-8000-000000000505';
  u_bad UUID := '00000000-0000-4000-8000-000000000506';
  u_replay UUID := '00000000-0000-4000-8000-000000000507';
  u_expire UUID := '00000000-0000-4000-8000-000000000508';
  v_json JSONB;
  v_count INTEGER;
  v_ordinal INTEGER;
  v_i INTEGER;
  v_saved JSONB;
BEGIN
  INSERT INTO app_core.users (id)
  VALUES (u_iso), (u_zero), (u_raise), (u_lower), (u_cap), (u_bad), (u_replay), (u_expire)
  ON CONFLICT (id) DO NOTHING;

  SELECT value INTO v_saved
  FROM app_core.runtime_config
  WHERE key = 'feature_free_trial_limits';

  PERFORM vip_t5_test.set_limits(1, 2);
  v_json := billing.reserve_feature_free_trial(u_iso, 'voice', 't5-iso-voice');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'voice first reserve');
  v_json := billing.reserve_feature_free_trial(u_iso, 'basic_image', 't5-iso-image-1');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'image first reserve');
  SELECT count(*) INTO v_count
  FROM billing.feature_free_trials
  WHERE user_id = u_iso AND feature = 'voice' AND status = 'reserved';
  PERFORM vip_t5_test.assert(v_count = 1, 'voice count stays 1 after image use');
  SELECT count(*) INTO v_count
  FROM billing.feature_free_trials
  WHERE user_id = u_iso AND feature = 'basic_image' AND status = 'reserved';
  PERFORM vip_t5_test.assert(v_count = 1, 'image count stays 1 after voice use');
  v_json := billing.reserve_feature_free_trial(u_iso, 'voice', 't5-iso-voice-2');
  PERFORM vip_t5_test.assert(
    v_json->>'ok' = 'false' AND v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED',
    'voice stops at its own limit'
  );
  v_json := billing.reserve_feature_free_trial(u_iso, 'basic_image', 't5-iso-image-2');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'image still has its second slot');
  v_json := billing.reserve_feature_free_trial(u_iso, 'basic_image', 't5-iso-image-3');
  PERFORM vip_t5_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'image stops at 2');

  PERFORM vip_t5_test.set_limits(0, 1);
  v_json := billing.reserve_feature_free_trial(u_zero, 'voice', 't5-zero-voice');
  PERFORM vip_t5_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'voice 0 allocates nothing');
  SELECT count(*) INTO v_count FROM billing.feature_free_trials WHERE user_id = u_zero AND feature = 'voice';
  PERFORM vip_t5_test.assert(v_count = 0, 'voice 0 leaves no fact');
  v_json := billing.reserve_feature_free_trial(u_zero, 'basic_image', 't5-zero-image');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'image remains open when voice is closed');

  PERFORM vip_t5_test.set_limits(1, 0);
  v_json := billing.reserve_feature_free_trial(u_zero, 'basic_image', 't5-zero-image-closed');
  PERFORM vip_t5_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'image 0 allocates nothing');
  v_json := billing.reserve_feature_free_trial(u_zero, 'voice', 't5-zero-voice-open');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'voice remains open when image is closed');

  PERFORM vip_t5_test.set_limits(3, 3);
  FOR v_i IN 1..3 LOOP
    v_json := billing.reserve_feature_free_trial(u_raise, 'voice', 't5-raise-' || v_i);
    PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'raise setup reserve ' || v_i);
  END LOOP;
  PERFORM vip_t5_test.set_limits(4, 3);
  v_json := billing.reserve_feature_free_trial(u_raise, 'voice', 't5-raise-4');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'raised limit grants another ordinal');
  v_ordinal := (v_json->'fact'->>'ordinal')::integer;
  PERFORM vip_t5_test.assert(v_ordinal = 4, 'raised limit uses the next free ordinal');

  PERFORM vip_t5_test.set_limits(3, 3);
  FOR v_i IN 1..3 LOOP
    v_json := billing.reserve_feature_free_trial(u_lower, 'basic_image', 't5-lower-' || v_i);
    PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'lower setup reserve ' || v_i);
  END LOOP;
  UPDATE billing.feature_free_trials
  SET status = 'consumed', consumed_at = now()
  WHERE user_id = u_lower AND feature = 'basic_image';
  PERFORM vip_t5_test.set_limits(3, 1);
  v_json := billing.reserve_feature_free_trial(u_lower, 'basic_image', 't5-lower-new');
  PERFORM vip_t5_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'lowered limit stops new grants');
  SELECT count(*) INTO v_count
  FROM billing.feature_free_trials
  WHERE user_id = u_lower AND feature = 'basic_image' AND status = 'consumed';
  PERFORM vip_t5_test.assert(v_count = 3, 'lowered limit keeps historical consumed rows');

  PERFORM vip_t5_test.set_limits(20, 0);
  FOR v_i IN 1..20 LOOP
    v_json := billing.reserve_feature_free_trial(u_cap, 'voice', 't5-cap-' || v_i);
    PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'cap reserve ' || v_i);
  END LOOP;
  v_json := billing.reserve_feature_free_trial(u_cap, 'voice', 't5-cap-21');
  PERFORM vip_t5_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'cap 20 rejects the 21st');

  UPDATE app_core.runtime_config
  SET value = '99'::jsonb
  WHERE key = 'feature_free_trial_limits';
  FOR v_i IN 1..3 LOOP
    v_json := billing.reserve_feature_free_trial(u_bad, 'voice', 't5-bad-' || v_i);
    PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'damaged config falls back to 3');
  END LOOP;
  v_json := billing.reserve_feature_free_trial(u_bad, 'voice', 't5-bad-4');
  PERFORM vip_t5_test.assert(v_json->>'code' = 'FEATURE_FREE_TRIAL_EXHAUSTED', 'damaged config does not exceed 3');

  PERFORM vip_t5_test.set_limits(3, 3);
  v_json := billing.reserve_feature_free_trial(u_replay, 'voice', 't5-replay');
  PERFORM vip_t5_test.assert(v_json->>'status' = 'reserved', 'replay first reserve');
  v_json := billing.reserve_feature_free_trial(u_replay, 'voice', 't5-replay');
  PERFORM vip_t5_test.assert(v_json->>'status' = 'already_reserved', 'replay does not take a second ordinal');
  SELECT count(*) INTO v_count
  FROM billing.feature_free_trials
  WHERE user_id = u_replay AND feature = 'voice' AND status IN ('reserved', 'consumed');
  PERFORM vip_t5_test.assert(v_count = 1, 'replay keeps a single fact');

  PERFORM vip_t5_test.set_limits(1, 1);
  v_json := billing.reserve_feature_free_trial(u_expire, 'voice', 't5-expire-old');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'expire setup');
  UPDATE billing.feature_free_trials
  SET reserved_until = now() - interval '1 minute'
  WHERE user_id = u_expire AND reference_id = 't5-expire-old';
  v_json := billing.reserve_feature_free_trial(u_expire, 'voice', 't5-expire-new');
  PERFORM vip_t5_test.assert(v_json->>'ok' = 'true', 'expired reservation can be replaced');
  SELECT count(*) INTO v_count
  FROM billing.feature_free_trials
  WHERE user_id = u_expire AND feature = 'voice' AND status = 'reserved';
  PERFORM vip_t5_test.assert(v_count = 1, 'expired row no longer occupies the only slot');

  IF to_regclass('experience.chat_message_audio') IS NOT NULL THEN
    INSERT INTO experience.chat_message_audio (id, free_trial_ordinal)
    VALUES ('00000000-0000-4000-8000-0000000005a1', 4);
    BEGIN
      INSERT INTO experience.chat_message_audio (id, free_trial_ordinal)
      VALUES ('00000000-0000-4000-8000-0000000005a2', 21);
      RAISE EXCEPTION 'T5 scenario failed: audio ordinal 21 was accepted';
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END IF;

  UPDATE app_core.runtime_config
  SET value = v_saved
  WHERE key = 'feature_free_trial_limits';

  RETURN 'ok';
END;
$$;

SELECT vip_t5_test.run();
