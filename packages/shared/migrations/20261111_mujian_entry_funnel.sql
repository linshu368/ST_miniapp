-- migration-domain: miniapp_traffic
-- Entry facts belong to channel attribution, not analytics. Backend is the sole writer.
-- Dependencies: app_core.users identity, experience.chat_history historical evidence,
-- miniapp_traffic.botlinks / increment_click for compatible first-source attribution.
-- No backfill or remote execution. Rollback: roll back applications, retain facts; forward-fix data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO miniapp_traffic.botlinks (source_id, source_name, bot_link)
SELECT 'mujian_dzmm', '幕间 dzmm', 'https://t.me/MIJINGAI_bot/mujian?startapp=mujian_dzmm'
WHERE NOT EXISTS (SELECT 1 FROM miniapp_traffic.botlinks WHERE source_id = 'mujian_dzmm');

CREATE TABLE miniapp_traffic.app_entry_facts (
  user_id uuid NOT NULL,
  surface text NOT NULL,
  source_key text NOT NULL DEFAULT '',
  launched_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  eligibility text NOT NULL,
  eligibility_basis jsonb NOT NULL,
  converted_at timestamptz,
  CONSTRAINT app_entry_facts_pk PRIMARY KEY (user_id, surface, source_key),
  CONSTRAINT app_entry_facts_user_fk FOREIGN KEY (user_id) REFERENCES app_core.users(id) ON DELETE CASCADE,
  CONSTRAINT app_entry_facts_surface_ck CHECK (surface IN ('mujian','mijing')),
  CONSTRAINT app_entry_facts_source_ck CHECK (source_key = '' OR source_key ~ '^[A-Za-z0-9_-]{3,64}$'),
  CONSTRAINT app_entry_facts_eligibility_ck CHECK (eligibility IN ('new','existing','unknown')),
  CONSTRAINT app_entry_facts_conversion_ck CHECK (converted_at IS NULL OR (surface = 'mujian' AND eligibility = 'new' AND source_key <> '' AND converted_at >= launched_at))
);
COMMENT ON TABLE miniapp_traffic.app_entry_facts IS 'First signed launch per account/surface/source; empty source is organic. Mujian eligibility is frozen across later Mijing use. No attribution expiry.';
COMMENT ON COLUMN miniapp_traffic.app_entry_facts.launched_at IS 'Verified Telegram auth_date, second precision; not a client clock or link click.';
COMMENT ON COLUMN miniapp_traffic.app_entry_facts.eligibility_basis IS 'Non-content evidence snapshot, no initData, signed URL or Telegram profile.';
ALTER TABLE miniapp_traffic.app_entry_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp_traffic.app_entry_facts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON miniapp_traffic.app_entry_facts TO service_role;

CREATE FUNCTION miniapp_traffic.record_app_entry(p_tg_id text, p_surface text, p_source text, p_launch timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
AS $$
DECLARE
  u app_core.users%ROWTYPE;
  prior miniapp_traffic.app_entry_facts%ROWTYPE;
  v_new boolean;
  v_eligibility text;
  v_reason text;
  v_history timestamptz;
  v_entered timestamptz;
  v_bot timestamptz;
  v_initialized timestamptz;
  v_rounds bigint;
  v_reordered boolean := false;
  v_prior_entry boolean := false;
  v_basis jsonb;
  v_source text := COALESCE(p_source, '');
  v_changed integer;
  v_converted boolean;
BEGIN
  IF p_tg_id !~ '^[1-9][0-9]*$' OR p_surface NOT IN ('mujian','mijing') OR p_launch IS NULL
    OR p_launch > clock_timestamp() + interval '30 seconds'
    OR p_launch < clock_timestamp() - interval '24 hours'
    OR (v_source <> '' AND v_source !~ '^[A-Za-z0-9_-]{3,64}$') THEN
    RAISE EXCEPTION 'invalid verified entry';
  END IF;
  -- Serialize both apps, including first-account creation. Existing user writers also respect the row lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('app-entry:' || p_tg_id, 0));
  INSERT INTO app_core.users (tg_id, miniapp_entered_at) VALUES (p_tg_id, NULL)
    ON CONFLICT (tg_id) DO NOTHING;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  v_new := v_changed = 1;
  SELECT * INTO STRICT u FROM app_core.users WHERE tg_id = p_tg_id FOR UPDATE;

  SELECT * INTO prior FROM miniapp_traffic.app_entry_facts
    WHERE user_id = u.id AND surface = 'mujian' ORDER BY received_at LIMIT 1;
  IF FOUND THEN
    v_eligibility := prior.eligibility;
    v_basis := prior.eligibility_basis;
  ELSE
    SELECT min(created_at) INTO v_history FROM experience.chat_history WHERE user_id = u.id;
    v_entered := u.miniapp_entered_at; v_bot := u.bot_entered_at; v_rounds := u.total_round;
    -- Production may still retain this legacy usage marker; TEST has already dropped it.
    v_initialized := (to_jsonb(u)->>'st_initialized_at')::timestamptz;
    -- Reconstruct a delayed Mujian report using the snapshot taken BEFORE the first Mijing entry.
    -- Compare the snapshot's evidence to Mujian's launch, not Mijing's later launch.
    SELECT * INTO prior FROM miniapp_traffic.app_entry_facts
      WHERE user_id = u.id AND surface = 'mijing' ORDER BY launched_at, received_at LIMIT 1;
    v_prior_entry := FOUND AND prior.launched_at <= p_launch;
    IF p_surface = 'mujian' AND FOUND AND prior.launched_at > p_launch THEN
      v_entered := (prior.eligibility_basis->>'miniapp_entered_at')::timestamptz;
      v_bot := (prior.eligibility_basis->>'bot_entered_at')::timestamptz;
      v_initialized := (prior.eligibility_basis->>'st_initialized_at')::timestamptz;
      v_history := (prior.eligibility_basis->>'first_chat_at')::timestamptz;
      v_rounds := (prior.eligibility_basis->>'total_round')::bigint;
      v_new := (prior.eligibility_basis->>'created_by_entry')::boolean;
      v_reordered := true;
    END IF;
    IF v_prior_entry OR (v_entered IS NOT NULL AND v_entered < p_launch)
      OR (v_initialized IS NOT NULL AND v_initialized < p_launch)
      OR (v_history IS NOT NULL AND v_history < p_launch) THEN
      v_eligibility := 'existing'; v_reason := 'prior_entry_or_usage';
    ELSIF COALESCE(v_rounds, 0) > 0 OR v_history IS NOT NULL OR v_initialized IS NOT NULL THEN
      v_eligibility := 'unknown'; v_reason := 'usage_order_uncertain';
    ELSIF v_new THEN
      v_eligibility := 'new'; v_reason := 'created_without_mijing_entry';
    ELSIF v_entered IS NULL AND v_bot IS NOT NULL THEN
      v_eligibility := 'new'; v_reason := 'bot_only_no_mijing_entry_or_usage';
    ELSIF v_entered >= p_launch + interval '1 second' THEN
      -- Other authenticated Mijing APIs may already have set the first-entry marker for this launch.
      v_eligibility := 'new'; v_reason := 'first_entry_after_signed_launch';
    ELSE
      v_eligibility := 'unknown'; v_reason := 'history_not_proven';
    END IF;
    v_basis := jsonb_build_object('version',1,'reason',v_reason,'miniapp_entered_at',v_entered,
      'bot_entered_at',v_bot,'st_initialized_at',v_initialized,'total_round',v_rounds,'first_chat_at',v_history,
      'created_by_entry',v_new,'reordered',v_reordered);
  END IF;

  INSERT INTO miniapp_traffic.app_entry_facts(user_id,surface,source_key,launched_at,eligibility,eligibility_basis)
    VALUES(u.id,p_surface,v_source,p_launch,v_eligibility,v_basis)
    ON CONFLICT (user_id,surface,source_key) DO UPDATE
      SET launched_at = LEAST(miniapp_traffic.app_entry_facts.launched_at, EXCLUDED.launched_at);

  IF p_surface = 'mijing' THEN
    UPDATE app_core.users SET miniapp_entered_at = COALESCE(miniapp_entered_at,clock_timestamp()), updated_at = clock_timestamp()
      WHERE id = u.id AND miniapp_entered_at IS NULL;
  END IF;
  IF v_source <> '' AND EXISTS(SELECT 1 FROM miniapp_traffic.botlinks WHERE source_id = v_source) THEN
    UPDATE app_core.users SET source_id = v_source, updated_at = clock_timestamp() WHERE id = u.id AND source_id IS NULL;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed > 0 THEN PERFORM miniapp_traffic.increment_click(v_source); END IF;
  END IF;

  -- A late report of an actual PRE-Mujian entry is historical evidence, not a subsequent conversion.
  -- Preserve the original decision snapshot; never invalidate because of an entry after first Mujian.
  UPDATE miniapp_traffic.app_entry_facts m
    SET eligibility_basis = m.eligibility_basis || jsonb_build_object(
      'initial_eligibility',m.eligibility,'historical_entry_before_mujian',e.launched_at), eligibility='existing', converted_at=NULL
    FROM (SELECT min(launched_at) AS launched_at FROM miniapp_traffic.app_entry_facts
      WHERE user_id=u.id AND surface='mijing') e
    WHERE m.user_id=u.id AND m.surface='mujian' AND m.eligibility <> 'existing'
      AND e.launched_at < (SELECT min(launched_at) FROM miniapp_traffic.app_entry_facts WHERE user_id=u.id AND surface='mujian');
  SELECT eligibility INTO v_eligibility FROM miniapp_traffic.app_entry_facts
    WHERE user_id=u.id AND surface=p_surface AND source_key=v_source;

  -- Reconcile on either arrival. Only the user's first Mijing launch can convert, and it must share source.
  -- Same-second launches count only if Mujian had already persisted before Mijing arrived.
  -- A delayed earlier Mijing launch can invalidate a tentative attribution from a later launch.
  UPDATE miniapp_traffic.app_entry_facts SET converted_at = NULL WHERE user_id=u.id AND surface='mujian';
  UPDATE miniapp_traffic.app_entry_facts m SET converted_at = e.launched_at
    FROM miniapp_traffic.app_entry_facts e
    WHERE m.user_id = u.id AND m.surface = 'mujian' AND m.eligibility = 'new'
      AND m.source_key <> '' AND m.converted_at IS NULL
      AND e.user_id = m.user_id AND e.surface = 'mijing' AND e.source_key = m.source_key
      AND (e.launched_at > m.launched_at OR (e.launched_at = m.launched_at AND e.received_at > m.received_at))
      AND NOT EXISTS (SELECT 1 FROM miniapp_traffic.app_entry_facts earlier
        WHERE earlier.user_id = u.id AND earlier.surface = 'mijing'
          AND (earlier.launched_at,earlier.received_at) < (e.launched_at,e.received_at));
  SELECT EXISTS(SELECT 1 FROM miniapp_traffic.app_entry_facts WHERE user_id=u.id AND surface='mujian'
    AND source_key=v_source AND converted_at IS NOT NULL) INTO v_converted;
  RETURN jsonb_build_object('recorded',true,'source_id',NULLIF(v_source,''),'eligibility',v_eligibility,'converted',v_converted);
END;
$$;
REVOKE ALL ON FUNCTION miniapp_traffic.record_app_entry(text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp_traffic.record_app_entry(text,text,text,timestamptz) TO service_role;
COMMIT;
