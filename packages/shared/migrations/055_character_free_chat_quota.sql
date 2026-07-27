-- Per-user, per-character free chat quota with atomic reservations.
-- Existing chat history is intentionally not backfilled: every pair starts at zero.

BEGIN;

CREATE TABLE miniapp.character_free_chat_quotas (
  user_id UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES miniapp.characters(id) ON DELETE CASCADE,
  used_rounds INTEGER NOT NULL DEFAULT 0 CHECK (used_rounds >= 0),
  reserved_rounds INTEGER NOT NULL DEFAULT 0 CHECK (reserved_rounds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, character_id)
);

CREATE TABLE miniapp.character_free_chat_quota_decisions (
  charge_key UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES miniapp.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES miniapp.characters(id) ON DELETE CASCADE,
  granted_free BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released', 'paid')),
  quota_limit INTEGER NOT NULL CHECK (quota_limit > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ
);

CREATE INDEX idx_character_free_chat_quota_decisions_pair
  ON miniapp.character_free_chat_quota_decisions(user_id, character_id, created_at DESC);
CREATE INDEX idx_character_free_chat_quota_decisions_stale
  ON miniapp.character_free_chat_quota_decisions(created_at)
  WHERE status = 'reserved';

ALTER TABLE miniapp.character_free_chat_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp.character_free_chat_quota_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON miniapp.character_free_chat_quotas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON miniapp.character_free_chat_quota_decisions FROM PUBLIC, anon, authenticated;
GRANT ALL ON miniapp.character_free_chat_quotas TO service_role, postgres;
GRANT ALL ON miniapp.character_free_chat_quota_decisions TO service_role, postgres;

CREATE FUNCTION miniapp.reserve_character_free_chat_round(
  p_charge_key UUID,
  p_user_id UUID,
  p_character_id UUID,
  p_quota_limit INTEGER DEFAULT 50
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_quota miniapp.character_free_chat_quotas;
  v_decision miniapp.character_free_chat_quota_decisions;
  v_stale_count INTEGER := 0;
  v_granted_free BOOLEAN;
BEGIN
  IF p_charge_key IS NULL OR p_user_id IS NULL OR p_character_id IS NULL
     OR p_quota_limit <= 0 THEN
    RAISE EXCEPTION 'invalid character free chat reservation input'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_decision
  FROM miniapp.character_free_chat_quota_decisions
  WHERE charge_key = p_charge_key;

  IF FOUND THEN
    SELECT * INTO v_quota
    FROM miniapp.character_free_chat_quotas
    WHERE user_id = v_decision.user_id
      AND character_id = v_decision.character_id;
    RETURN jsonb_build_object(
      'granted_free', v_decision.granted_free,
      'status', v_decision.status,
      'used_rounds', COALESCE(v_quota.used_rounds, 0),
      'remaining_rounds', GREATEST(
        v_decision.quota_limit
          - COALESCE(v_quota.used_rounds, 0)
          - COALESCE(v_quota.reserved_rounds, 0),
        0
      )
    );
  END IF;

  INSERT INTO miniapp.character_free_chat_quotas(user_id, character_id)
  VALUES (p_user_id, p_character_id)
  ON CONFLICT (user_id, character_id) DO NOTHING;

  SELECT * INTO v_quota
  FROM miniapp.character_free_chat_quotas
  WHERE user_id = p_user_id AND character_id = p_character_id
  FOR UPDATE;

  -- Recheck after taking the pair lock so concurrent calls with the same key
  -- return the first decision instead of racing on the primary key insert.
  SELECT * INTO v_decision
  FROM miniapp.character_free_chat_quota_decisions
  WHERE charge_key = p_charge_key
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'granted_free', v_decision.granted_free,
      'status', v_decision.status,
      'used_rounds', v_quota.used_rounds,
      'remaining_rounds', GREATEST(
        v_decision.quota_limit - v_quota.used_rounds - v_quota.reserved_rounds,
        0
      )
    );
  END IF;

  WITH released AS (
    UPDATE miniapp.character_free_chat_quota_decisions
    SET status = 'released', finalized_at = now()
    WHERE user_id = p_user_id
      AND character_id = p_character_id
      AND status = 'reserved'
      AND created_at < now() - interval '1 hour'
    RETURNING 1
  )
  SELECT count(*)::INTEGER INTO v_stale_count FROM released;

  IF v_stale_count > 0 THEN
    UPDATE miniapp.character_free_chat_quotas
    SET reserved_rounds = GREATEST(reserved_rounds - v_stale_count, 0),
        updated_at = now()
    WHERE user_id = p_user_id AND character_id = p_character_id
    RETURNING * INTO v_quota;
  END IF;

  DELETE FROM miniapp.character_free_chat_quota_decisions
  WHERE user_id = p_user_id
    AND character_id = p_character_id
    AND status = 'released'
    AND finalized_at < now() - interval '7 days';

  v_granted_free := v_quota.used_rounds + v_quota.reserved_rounds < p_quota_limit;

  IF v_granted_free THEN
    UPDATE miniapp.character_free_chat_quotas
    SET reserved_rounds = reserved_rounds + 1,
        updated_at = now()
    WHERE user_id = p_user_id AND character_id = p_character_id
    RETURNING * INTO v_quota;

    INSERT INTO miniapp.character_free_chat_quota_decisions(
      charge_key, user_id, character_id, granted_free, status, quota_limit
    ) VALUES (
      p_charge_key, p_user_id, p_character_id, true, 'reserved', p_quota_limit
    );

    RETURN jsonb_build_object(
      'granted_free', true,
      'status', 'reserved',
      'used_rounds', v_quota.used_rounds,
      'remaining_rounds', GREATEST(
        p_quota_limit - v_quota.used_rounds - v_quota.reserved_rounds,
        0
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'granted_free', false,
    'status', 'paid',
    'used_rounds', v_quota.used_rounds,
    'remaining_rounds', 0
  );
END;
$$;

CREATE FUNCTION miniapp.finalize_character_free_chat_round(
  p_charge_key UUID,
  p_success BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_decision miniapp.character_free_chat_quota_decisions;
  v_quota miniapp.character_free_chat_quotas;
  v_just_exhausted BOOLEAN := false;
BEGIN
  SELECT * INTO v_decision
  FROM miniapp.character_free_chat_quota_decisions
  WHERE charge_key = p_charge_key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'character free chat reservation not found: %', p_charge_key
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_quota
  FROM miniapp.character_free_chat_quotas
  WHERE user_id = v_decision.user_id
    AND character_id = v_decision.character_id
  FOR UPDATE;

  SELECT * INTO v_decision
  FROM miniapp.character_free_chat_quota_decisions
  WHERE charge_key = p_charge_key
  FOR UPDATE;

  IF v_decision.status = 'reserved' THEN
    UPDATE miniapp.character_free_chat_quotas
    SET reserved_rounds = GREATEST(reserved_rounds - 1, 0),
        used_rounds = used_rounds + CASE WHEN p_success THEN 1 ELSE 0 END,
        updated_at = now()
    WHERE user_id = v_decision.user_id
      AND character_id = v_decision.character_id
    RETURNING * INTO v_quota;

    UPDATE miniapp.character_free_chat_quota_decisions
    SET status = CASE WHEN p_success THEN 'consumed' ELSE 'released' END,
        finalized_at = now()
    WHERE charge_key = p_charge_key
    RETURNING * INTO v_decision;

    v_just_exhausted := p_success AND v_quota.used_rounds = v_decision.quota_limit;
  END IF;

  RETURN jsonb_build_object(
    'granted_free', v_decision.granted_free,
    'status', v_decision.status,
    'used_rounds', v_quota.used_rounds,
    'remaining_rounds', GREATEST(v_decision.quota_limit - v_quota.used_rounds, 0),
    'just_exhausted', v_just_exhausted
  );
END;
$$;

REVOKE ALL ON FUNCTION miniapp.reserve_character_free_chat_round(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION miniapp.finalize_character_free_chat_round(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miniapp.reserve_character_free_chat_round(UUID, UUID, UUID, INTEGER)
  TO service_role, postgres;
GRANT EXECUTE ON FUNCTION miniapp.finalize_character_free_chat_round(UUID, BOOLEAN)
  TO service_role, postgres;

-- Populate deduct_markup without changing any existing default markup.
DO $$
DECLARE
  v_catalog JSONB;
  v_tier JSONB;
  v_model JSONB;
  v_tiers JSONB := '[]'::JSONB;
  v_models JSONB;
  v_deduct_markup NUMERIC;
BEGIN
  SELECT value INTO v_catalog
  FROM miniapp.runtime_config
  WHERE key = 'llm_model_catalog'
  FOR UPDATE;

  IF v_catalog IS NULL OR jsonb_typeof(v_catalog -> 'tiers') <> 'array' THEN
    RETURN;
  END IF;

  FOR v_tier IN SELECT value FROM jsonb_array_elements(v_catalog -> 'tiers')
  LOOP
    v_models := '[]'::JSONB;
    FOR v_model IN
      SELECT value FROM jsonb_array_elements(COALESCE(v_tier -> 'models', '[]'::JSONB))
    LOOP
      v_deduct_markup := CASE v_model ->> 'openrouter_model_id'
        WHEN 'google/gemini-3.5-flash-lite' THEN 2
        WHEN 'deepseek/deepseek-v4-flash' THEN 2.5
        WHEN 'deepseek/deepseek-v3.2' THEN 3
        ELSE CASE
          WHEN COALESCE((v_model ->> 'markup')::NUMERIC, 0) > 0
            THEN (v_model ->> 'markup')::NUMERIC
          ELSE 2.5
        END
      END;
      v_models := v_models || jsonb_build_array(
        v_model || jsonb_build_object('deduct_markup', v_deduct_markup)
      );
    END LOOP;
    v_tiers := v_tiers || jsonb_build_array(jsonb_set(v_tier, '{models}', v_models));
  END LOOP;

  UPDATE miniapp.runtime_config
  SET value = jsonb_set(v_catalog, '{tiers}', v_tiers),
      version = COALESCE(version, 0) + 1,
      updated_at = now()
  WHERE key = 'llm_model_catalog';
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_model_catalog_prd(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    WHERE trim(tier ->> 'label') = ''
      OR char_length(trim(tier ->> 'label')) > 20
      OR COALESCE(tier ->> 'color', '') !~ '^#[0-9A-Fa-f]{6}$'
      OR COALESCE(char_length(trim(tier ->> 'cost_hint')), 0) NOT BETWEEN 1 AND 30
      OR jsonb_array_length(tier -> 'models') = 0
      OR (tier ->> 'sort_order')::NUMERIC < 0
      OR (tier ->> 'sort_order')::NUMERIC <> trunc((tier ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD tier fields'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
    WHERE COALESCE(model ->> 'id', '') !~ '^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$'
      OR char_length(model ->> 'id') > 64
      OR COALESCE(model ->> 'openrouter_model_id', '') !~ '^[^[:space:]/]+/[^[:space:]/]+$'
      OR char_length(model ->> 'openrouter_model_id') > 200
      OR COALESCE(char_length(trim(model ->> 'display_name')), 0) NOT BETWEEN 1 AND 40
      OR COALESCE(char_length(trim(model ->> 'tagline')), 0) NOT BETWEEN 1 AND 15
      OR (model ->> 'price_input')::NUMERIC * 10
         <> trunc((model ->> 'price_input')::NUMERIC * 10)
      OR (model ->> 'price_output')::NUMERIC * 10
         <> trunc((model ->> 'price_output')::NUMERIC * 10)
      OR jsonb_typeof(model -> 'markup') IS DISTINCT FROM 'number'
      OR (model ->> 'markup')::NUMERIC NOT IN (0, 1, 1.5, 2, 2.5, 3, 3.5, 4)
      OR jsonb_typeof(model -> 'deduct_markup') IS DISTINCT FROM 'number'
      OR (model ->> 'deduct_markup')::NUMERIC NOT IN (1, 1.5, 2, 2.5, 3, 3.5, 4)
      OR (
        (model ->> 'markup')::NUMERIC = 0
        AND (
          (model ->> 'price_input')::NUMERIC <> 0
          OR (model ->> 'price_output')::NUMERIC <> 0
        )
      )
      OR (model ->> 'sort_order')::NUMERIC < 0
      OR (model ->> 'sort_order')::NUMERIC <> trunc((model ->> 'sort_order')::NUMERIC)
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog contains invalid PRD model fields'
      USING ERRCODE = '22023';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT model ->> 'openrouter_model_id')
    FROM jsonb_array_elements(p_value -> 'tiers') AS tier
    CROSS JOIN LATERAL jsonb_array_elements(tier -> 'models') AS model
  ) THEN
    RAISE EXCEPTION 'llm_model_catalog OpenRouter mappings must be unique'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

COMMENT ON TABLE miniapp.character_free_chat_quotas IS
  'Successful free-model rounds counted per user and character after migration 055.';
COMMENT ON TABLE miniapp.character_free_chat_quota_decisions IS
  'Idempotent reservation and finalization decisions for the 50-round free quota.';

NOTIFY pgrst, 'reload schema';

COMMIT;
