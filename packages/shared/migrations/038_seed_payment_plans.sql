-- Move recharge plans from backend memory into runtime_config.
-- This is intentionally insert-only: rerunning the migration must never
-- overwrite plans subsequently published by the operations platform.

BEGIN;

INSERT INTO miniapp.runtime_config (
  key,
  value,
  description,
  version,
  updated_at,
  text_value
) VALUES (
  'miniapp_payment_plans',
  '[
    {
      "id": "plan-entry-6",
      "price_cents": 600,
      "original_price_cents": null,
      "credits_amount": 600,
      "bonus_credits": 0,
      "variant": "entry",
      "badge_text": null,
      "sub_copy": "初次邂逅",
      "highlight_text": null
    },
    {
      "id": "plan-standard-28",
      "price_cents": 2800,
      "original_price_cents": 3300,
      "credits_amount": 3000,
      "bonus_credits": 0,
      "variant": "standard",
      "badge_text": "入门首选",
      "sub_copy": "沉浸式体验",
      "highlight_text": null
    },
    {
      "id": "plan-recommended-98",
      "price_cents": 9800,
      "original_price_cents": 11800,
      "credits_amount": 9800,
      "bonus_credits": 2000,
      "variant": "recommended",
      "badge_text": "75% 用户的选择",
      "sub_copy": "立省¥20 · 低至 0.04元/次调用",
      "highlight_text": "🔥 免费送 2,000"
    },
    {
      "id": "plan-premium-328",
      "price_cents": 32800,
      "original_price_cents": 42800,
      "credits_amount": 32800,
      "bonus_credits": 10000,
      "variant": "premium",
      "badge_text": "大户专享",
      "sub_copy": "≈ 3600次旗舰模型 · 历史最低单价",
      "highlight_text": "狂送 10,000"
    }
  ]'::JSONB,
  '星尘商店展示并用于下单校验的正式套餐；后续仅通过运营平台发布调整。',
  1,
  now(),
  NULL
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION admin.validate_payment_plan_ids(p_value JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF (
    SELECT count(*) <> count(DISTINCT plan ->> 'id')
    FROM jsonb_array_elements(p_value) AS plan
  ) THEN
    RAISE EXCEPTION 'miniapp_payment_plans plan ids must be unique'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin.validate_payment_plans_draft_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.config_key = 'miniapp_payment_plans' THEN
    PERFORM admin.validate_payment_plan_ids(NEW.value);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS config_drafts_validate_payment_plan_ids ON admin.config_drafts;
CREATE TRIGGER config_drafts_validate_payment_plan_ids
  BEFORE INSERT OR UPDATE OF value ON admin.config_drafts
  FOR EACH ROW
  EXECUTE FUNCTION admin.validate_payment_plans_draft_trigger();

REVOKE ALL ON FUNCTION admin.validate_payment_plan_ids(JSONB)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION admin.validate_payment_plans_draft_trigger()
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_value JSONB;
BEGIN
  SELECT value INTO v_value
  FROM miniapp.runtime_config
  WHERE key = 'miniapp_payment_plans';

  PERFORM admin.validate_managed_config_value('miniapp_payment_plans', v_value, NULL);
  PERFORM admin.validate_payment_plan_ids(v_value);
END;
$$;

COMMIT;
