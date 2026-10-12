-- 20261012: 图片广场与独立图片创作 V2。
-- domain: experience + miniapp_features + billing + app_core + admin
--
-- 仅为 migration 草案：一次只在确认目标环境后手工执行，先 test 后 production。
-- 发布顺序：本文件 + Storage bucket -> Backend -> Frontend/Admin -> 发布配置 -> 开入口。
-- 回滚：先发布 image_plaza_enabled=false 并停止 worker；账务、attempt、作品不删除，结构缺陷 forward-fix。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('app_core.users') IS NULL
     OR to_regclass('app_core.runtime_config') IS NULL
     OR to_regclass('app_core.miniapp_user_settings') IS NULL
     OR to_regclass('billing.user_wallets') IS NULL
     OR to_regclass('billing.wallet_ledger') IS NULL
     OR to_regclass('admin.config_drafts') IS NULL
     OR to_regclass('admin.config_releases') IS NULL THEN
    RAISE EXCEPTION 'image plaza migration requires schema split and managed-config baseline';
  END IF;
END;
$$;

ALTER TABLE app_core.miniapp_user_settings
  ADD COLUMN IF NOT EXISTS image_plaza_first_share_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN app_core.miniapp_user_settings.image_plaza_first_share_completed_at IS
  '账号首次成功分享图片广场作品的时间；只能由图片广场分享事务从 NULL 写为时间。';

CREATE TABLE experience.image_plaza_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 80),
  source_work_id UUID,
  snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experience.image_plaza_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES experience.image_plaza_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '' CHECK (char_length(content) <= 600),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experience.image_plaza_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('t2i', 'i2i', 'edit')),
  aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('1:1','2:3','3:2','3:4','4:3','4:5','9:16','16:9','21:9')),
  resolution TEXT NOT NULL CHECK (resolution IN ('1K','2K','fixed')),
  credits NUMERIC(14,1) NOT NULL CHECK (credits > 0),
  catalog_version INTEGER NOT NULL CHECK (catalog_version >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experience.image_plaza_reference_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/webp', 'image/png', 'image/jpeg')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experience.image_plaza_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES experience.image_plaza_conversations(id) ON DELETE CASCADE,
  user_message_id UUID NOT NULL REFERENCES experience.image_plaza_messages(id) ON DELETE RESTRICT,
  assistant_message_id UUID NOT NULL REFERENCES experience.image_plaza_messages(id) ON DELETE RESTRICT,
  quote_id UUID NOT NULL REFERENCES experience.image_plaza_quotes(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  prompt TEXT NOT NULL CHECK (char_length(trim(prompt)) BETWEEN 1 AND 600),
  model_id TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('t2i', 'i2i', 'edit')),
  aspect_ratio TEXT NOT NULL CHECK (aspect_ratio IN ('1:1','2:3','3:2','3:4','4:3','4:5','9:16','16:9','21:9')),
  resolution TEXT NOT NULL CHECK (resolution IN ('1K','2K','fixed')),
  reasoning BOOLEAN NOT NULL DEFAULT false,
  auto_optimize BOOLEAN NOT NULL DEFAULT true,
  reference_artifact_id UUID REFERENCES experience.image_plaza_reference_assets(id) ON DELETE RESTRICT,
  quote_credits NUMERIC(14,1) NOT NULL CHECK (quote_credits > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'generating', 'storing', 'ready', 'failed', 'failed_unknown')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  provider_request_id TEXT,
  error_code TEXT,
  debit_ledger_id UUID REFERENCES billing.wallet_ledger(id) ON DELETE RESTRICT,
  credits_charged NUMERIC(14,1) NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
  charged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT image_plaza_attempts_user_idempotency_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT image_plaza_attempts_ready_charged CHECK (
    status <> 'ready' OR (debit_ledger_id IS NOT NULL AND credits_charged = quote_credits)
  )
);

CREATE TABLE experience.image_plaza_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES experience.image_plaza_attempts(id) ON DELETE RESTRICT,
  position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 2),
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/webp', 'image/png', 'image/jpeg')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT image_plaza_artifacts_attempt_position_unique UNIQUE (attempt_id, position)
);

CREATE TABLE experience.image_plaza_works (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES experience.image_plaza_attempts(id) ON DELETE RESTRICT,
  artifact_id UUID NOT NULL REFERENCES experience.image_plaza_artifacts(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 80),
  model_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  tags TEXT[] NOT NULL DEFAULT '{}',
  snapshot JSONB NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT image_plaza_works_artifact_unique UNIQUE (artifact_id)
);

ALTER TABLE experience.image_plaza_conversations
  ADD CONSTRAINT image_plaza_conversations_source_work_fkey
  FOREIGN KEY (source_work_id) REFERENCES experience.image_plaza_works(id) ON DELETE SET NULL;

CREATE TABLE miniapp_features.image_plaza_likes (
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  work_id UUID NOT NULL REFERENCES experience.image_plaza_works(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT image_plaza_likes_pkey PRIMARY KEY (user_id, work_id)
);

CREATE TABLE billing.image_plaza_share_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_core.users(id) ON DELETE RESTRICT,
  work_id UUID NOT NULL REFERENCES experience.image_plaza_works(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES experience.image_plaza_attempts(id) ON DELETE RESTRICT,
  debit_ledger_id UUID NOT NULL REFERENCES billing.wallet_ledger(id) ON DELETE RESTRICT,
  reward_ledger_id UUID REFERENCES billing.wallet_ledger(id) ON DELETE RESTRICT,
  rebate_rate NUMERIC(7,6) NOT NULL CHECK (rebate_rate >= 0 AND rebate_rate <= 1),
  debit_credits NUMERIC(14,1) NOT NULL CHECK (debit_credits > 0),
  reward_credits NUMERIC(14,1) NOT NULL CHECK (reward_credits >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT image_plaza_share_rewards_work_unique UNIQUE (work_id),
  CONSTRAINT image_plaza_share_rewards_debit_unique UNIQUE (debit_ledger_id)
);

CREATE INDEX image_plaza_conversations_user_updated_idx
  ON experience.image_plaza_conversations(user_id, updated_at DESC, id DESC);
CREATE INDEX image_plaza_messages_conversation_idx
  ON experience.image_plaza_messages(conversation_id, created_at, id);
CREATE INDEX image_plaza_attempts_claim_idx
  ON experience.image_plaza_attempts(created_at, id)
  WHERE status IN ('pending', 'leased');
CREATE INDEX image_plaza_works_feed_idx
  ON experience.image_plaza_works(published_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX image_plaza_works_tags_idx
  ON experience.image_plaza_works USING GIN(tags)
  WHERE deleted_at IS NULL;
CREATE INDEX image_plaza_likes_work_idx
  ON miniapp_features.image_plaza_likes(work_id);

ALTER TABLE experience.image_plaza_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.image_plaza_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.image_plaza_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.image_plaza_reference_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.image_plaza_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.image_plaza_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience.image_plaza_works ENABLE ROW LEVEL SECURITY;
ALTER TABLE miniapp_features.image_plaza_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.image_plaza_share_rewards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON experience.image_plaza_conversations, experience.image_plaza_messages,
  experience.image_plaza_quotes, experience.image_plaza_reference_assets, experience.image_plaza_attempts,
  experience.image_plaza_artifacts, experience.image_plaza_works,
  miniapp_features.image_plaza_likes, billing.image_plaza_share_rewards
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON experience.image_plaza_conversations, experience.image_plaza_messages,
  experience.image_plaza_quotes, experience.image_plaza_reference_assets, experience.image_plaza_attempts,
  experience.image_plaza_artifacts, experience.image_plaza_works,
  miniapp_features.image_plaza_likes, billing.image_plaza_share_rewards
  TO service_role, postgres;

COMMENT ON TABLE experience.image_plaza_attempts IS
  '图片广场独立生成任务；provider dispatch 后的模糊超时不可自动重投。';
COMMENT ON TABLE experience.image_plaza_works IS
  '用户显式分享后生成的公开作品投影；软删除，不承载账务真相。';
COMMENT ON TABLE billing.image_plaza_share_rewards IS
  '分享返利不可变快照；同一作品和同一生成实扣最多返一次。';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'image-plaza', 'image-plaza', false, 52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION experience.claim_image_plaza_jobs(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 3,
  p_lease_seconds INTEGER DEFAULT 180
) RETURNS SETOF experience.image_plaza_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 3), 1), 10);
  v_lease_seconds INTEGER := LEAST(GREATEST(COALESCE(p_lease_seconds, 180), 30), 900);
BEGIN
  IF trim(COALESCE(p_worker_id, '')) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT attempt.id
    FROM experience.image_plaza_attempts AS attempt
    WHERE attempt.status = 'pending'
       OR (attempt.status = 'leased' AND attempt.lease_expires_at < now())
    ORDER BY attempt.created_at, attempt.id
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE experience.image_plaza_attempts AS attempt
  SET status = 'leased',
      lease_owner = left(p_worker_id, 128),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      updated_at = now()
  FROM candidates
  WHERE attempt.id = candidates.id
  RETURNING attempt.*;
END;
$$;

REVOKE ALL ON FUNCTION experience.claim_image_plaza_jobs(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.claim_image_plaza_jobs(TEXT, INTEGER, INTEGER)
  TO service_role, postgres;

-- 账本取值为已部署集合的向后兼容超集；reference_type 使用图片广场专用命名空间。
ALTER TABLE billing.wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_entry_type_check;
ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (entry_type IN (
  'recharge', 'chat_debit', 'refund', 'adjustment', 'checkin_bonus', 'wish_reward',
  'invite_reward', 'community_reward', 'image_generation', 'vip_bonus',
  'image_plaza_generation', 'image_plaza_share_reward'
));

CREATE UNIQUE INDEX image_plaza_generation_ledger_unique
  ON billing.wallet_ledger(reference_type, reference_id)
  WHERE reference_type = 'image_plaza_generation';
CREATE UNIQUE INDEX image_plaza_share_reward_ledger_unique
  ON billing.wallet_ledger(reference_type, reference_id)
  WHERE reference_type = 'image_plaza_share_reward';

CREATE OR REPLACE FUNCTION billing.settle_image_plaza_generation(
  p_attempt_id UUID,
  p_user_id UUID,
  p_artifacts JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_attempt experience.image_plaza_attempts%ROWTYPE;
  v_wallet billing.user_wallets%ROWTYPE;
  v_item JSONB;
  v_bonus NUMERIC(14,1);
  v_main NUMERIC(14,1);
  v_ledger UUID;
BEGIN
  SELECT * INTO v_attempt
  FROM experience.image_plaza_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR v_attempt.user_id <> p_user_id THEN
    RAISE EXCEPTION 'attempt not found or owner mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_attempt.debit_ledger_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_settled', 'ledger_id', v_attempt.debit_ledger_id);
  END IF;
  IF v_attempt.status NOT IN ('leased', 'generating', 'storing') THEN
    RAISE EXCEPTION 'attempt is not settleable' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_artifacts) <> 'array' OR jsonb_array_length(p_artifacts) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'one to three stored artifacts are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO billing.user_wallets(user_id) VALUES (p_user_id) ON CONFLICT(user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_wallet.main_credits + v_wallet.bonus_credits < v_attempt.quote_credits THEN
    UPDATE experience.image_plaza_attempts
    SET status = 'failed', error_code = 'image_plaza_insufficient_balance', completed_at = now(), updated_at = now()
    WHERE id = p_attempt_id;
    RETURN jsonb_build_object('status', 'insufficient_balance');
  END IF;

  v_bonus := LEAST(v_wallet.bonus_credits, v_attempt.quote_credits);
  v_main := v_attempt.quote_credits - v_bonus;
  UPDATE billing.user_wallets
  SET bonus_credits = bonus_credits - v_bonus,
      main_credits = main_credits - v_main,
      updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_wallet;

  INSERT INTO billing.wallet_ledger(
    user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
    reference_type, reference_id, metadata
  ) VALUES (
    p_user_id, 'image_plaza_generation', -v_attempt.quote_credits, -v_main, -v_bonus,
    v_wallet.main_credits, v_wallet.bonus_credits,
    'image_plaza_generation', p_attempt_id::TEXT,
    jsonb_build_object('conversation_id', v_attempt.conversation_id, 'model_id', v_attempt.model_id,
      'mode', v_attempt.mode, 'aspect_ratio', v_attempt.aspect_ratio,
      'resolution', v_attempt.resolution, 'reasoning', v_attempt.reasoning,
      'auto_optimize', v_attempt.auto_optimize)
  ) RETURNING id INTO v_ledger;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_artifacts)
  LOOP
    INSERT INTO experience.image_plaza_artifacts(
      attempt_id, position, storage_path, mime_type, byte_size, width, height
    ) VALUES (
      p_attempt_id, (v_item->>'position')::SMALLINT, v_item->>'storage_path',
      v_item->>'mime_type', (v_item->>'byte_size')::INTEGER,
      (v_item->>'width')::INTEGER, (v_item->>'height')::INTEGER
    );
  END LOOP;

  UPDATE experience.image_plaza_attempts
  SET status = 'ready', debit_ledger_id = v_ledger, credits_charged = quote_credits,
      charged_at = now(), completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
      error_code = NULL, updated_at = now()
  WHERE id = p_attempt_id;

  UPDATE experience.image_plaza_messages
  SET content = '生成完成'
  WHERE id = v_attempt.assistant_message_id;
  UPDATE experience.image_plaza_conversations
  SET updated_at = now() WHERE id = v_attempt.conversation_id;
  RETURN jsonb_build_object('status', 'settled', 'ledger_id', v_ledger);
END;
$$;

REVOKE ALL ON FUNCTION billing.settle_image_plaza_generation(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.settle_image_plaza_generation(UUID, UUID, JSONB)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION billing.share_image_plaza_artifact(
  p_user_id UUID,
  p_artifact_id UUID,
  p_title TEXT,
  p_model_name TEXT,
  p_tags TEXT[],
  p_rebate_rate NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_artifact experience.image_plaza_artifacts%ROWTYPE;
  v_attempt experience.image_plaza_attempts%ROWTYPE;
  v_work experience.image_plaza_works%ROWTYPE;
  v_wallet billing.user_wallets%ROWTYPE;
  v_reward NUMERIC(14,1);
  v_reward_ledger UUID;
BEGIN
  IF p_rebate_rate IS NULL OR p_rebate_rate < 0 OR p_rebate_rate > 1 THEN
    RAISE EXCEPTION 'invalid image plaza rebate rate' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_artifact FROM experience.image_plaza_artifacts WHERE id = p_artifact_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'artifact not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_attempt FROM experience.image_plaza_attempts WHERE id = v_artifact.attempt_id FOR UPDATE;
  IF v_attempt.user_id <> p_user_id OR v_attempt.status <> 'ready' OR v_attempt.debit_ledger_id IS NULL THEN
    RAISE EXCEPTION 'artifact is not shareable' USING ERRCODE = '42501';
  END IF;
  IF v_attempt.reference_artifact_id IS NOT NULL THEN
    PERFORM 1
    FROM experience.image_plaza_reference_assets
    WHERE id = v_attempt.reference_artifact_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reference artifact not accessible' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO v_work FROM experience.image_plaza_works WHERE artifact_id = p_artifact_id;
  IF FOUND THEN
    SELECT reward_credits INTO v_reward FROM billing.image_plaza_share_rewards WHERE work_id = v_work.id;
    RETURN jsonb_build_object('work_id', v_work.id, 'already_shared', true,
      'reward_credits', COALESCE(v_reward, 0));
  END IF;

  INSERT INTO experience.image_plaza_works(
    user_id, attempt_id, artifact_id, title, model_id, model_name, width, height, tags, snapshot
  ) VALUES (
    p_user_id, v_attempt.id, v_artifact.id, left(trim(p_title), 80),
    v_attempt.model_id, left(trim(p_model_name), 80),
    v_artifact.width, v_artifact.height, COALESCE(p_tags, '{}'),
    jsonb_build_object('prompt', v_attempt.prompt, 'model_id', v_attempt.model_id,
      'aspect_ratio', v_attempt.aspect_ratio, 'resolution', v_attempt.resolution,
      'reasoning', v_attempt.reasoning, 'auto_optimize', v_attempt.auto_optimize,
      'mode', v_attempt.mode, 'reference_artifact_id', v_attempt.reference_artifact_id,
      'style', 'None')
  ) RETURNING * INTO v_work;

  v_reward := round(v_attempt.credits_charged * p_rebate_rate, 1);
  SELECT * INTO v_wallet FROM billing.user_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_reward > 0 THEN
    UPDATE billing.user_wallets
    SET bonus_credits = bonus_credits + v_reward, updated_at = now()
    WHERE user_id = p_user_id RETURNING * INTO v_wallet;
    INSERT INTO billing.wallet_ledger(
      user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
      reference_type, reference_id, metadata
    ) VALUES (
      p_user_id, 'image_plaza_share_reward', v_reward, 0, v_reward,
      v_wallet.main_credits, v_wallet.bonus_credits,
      'image_plaza_share_reward', v_work.id::TEXT,
      jsonb_build_object('attempt_id', v_attempt.id, 'debit_ledger_id', v_attempt.debit_ledger_id,
        'rebate_rate', p_rebate_rate)
    ) RETURNING id INTO v_reward_ledger;
  END IF;
  INSERT INTO billing.image_plaza_share_rewards(
    user_id, work_id, attempt_id, debit_ledger_id, reward_ledger_id,
    rebate_rate, debit_credits, reward_credits
  ) VALUES (
    p_user_id, v_work.id, v_attempt.id, v_attempt.debit_ledger_id, v_reward_ledger,
    p_rebate_rate, v_attempt.credits_charged, v_reward
  );
  INSERT INTO app_core.miniapp_user_settings(user_id, image_plaza_first_share_completed_at)
  VALUES (p_user_id, now())
  ON CONFLICT (user_id) DO UPDATE
  SET image_plaza_first_share_completed_at = COALESCE(
        app_core.miniapp_user_settings.image_plaza_first_share_completed_at,
        EXCLUDED.image_plaza_first_share_completed_at
      ),
      updated_at = now();
  RETURN jsonb_build_object('work_id', v_work.id, 'already_shared', false, 'reward_credits', v_reward);
END;
$$;

REVOKE ALL ON FUNCTION billing.share_image_plaza_artifact(UUID, UUID, TEXT, TEXT, TEXT[], NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.share_image_plaza_artifact(UUID, UUID, TEXT, TEXT, TEXT[], NUMERIC)
  TO service_role, postgres;

-- 在不复制旧校验逻辑的前提下扩展既有 managed-config 发布链。
ALTER FUNCTION admin.is_managed_config_key(TEXT) RENAME TO is_managed_config_key_before_image_plaza;
CREATE FUNCTION admin.is_managed_config_key(p_config_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT p_config_key IN ('image_plaza_enabled', 'image_plaza_model_catalog',
    'image_plaza_share_tip', 'image_plaza_tags')
    OR admin.is_managed_config_key_before_image_plaza(p_config_key)
$$;

ALTER FUNCTION admin.validate_managed_config_value(TEXT, JSONB, TEXT)
  RENAME TO validate_managed_config_value_before_image_plaza;
CREATE FUNCTION admin.validate_managed_config_value(
  p_config_key TEXT, p_value JSONB, p_text_value TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_config_key IN ('image_plaza_enabled', 'image_plaza_model_catalog',
      'image_plaza_share_tip', 'image_plaza_tags') THEN
    IF p_text_value IS NOT NULL THEN
      RAISE EXCEPTION '% must not use text_value', p_config_key USING ERRCODE = '22023';
    END IF;
    IF p_config_key = 'image_plaza_enabled' AND jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'image_plaza_enabled must be boolean' USING ERRCODE = '22023';
    END IF;
    IF p_config_key <> 'image_plaza_enabled' AND jsonb_typeof(p_value) NOT IN ('object', 'array') THEN
      RAISE EXCEPTION '% has invalid shape', p_config_key USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  PERFORM admin.validate_managed_config_value_before_image_plaza(p_config_key, p_value, p_text_value);
END;
$$;

ALTER TABLE admin.config_drafts DROP CONSTRAINT IF EXISTS config_drafts_config_key_check;
ALTER TABLE admin.config_drafts ADD CONSTRAINT config_drafts_config_key_check
  CHECK (admin.is_managed_config_key(config_key));
ALTER TABLE admin.config_releases DROP CONSTRAINT IF EXISTS config_releases_config_key_check;
ALTER TABLE admin.config_releases ADD CONSTRAINT config_releases_config_key_check
  CHECK (admin.is_managed_config_key(config_key));

INSERT INTO app_core.runtime_config(key, value, description)
VALUES
  ('image_plaza_enabled', 'false'::JSONB, '图片广场新受理总开关'),
  ('image_plaza_share_rebate_rate', '0.3'::JSONB, '图片广场分享返利比例；技术配置，不进入 Admin'),
  ('image_plaza_share_tip', '{"enabled":true,"title":"分享返还 {rate}","description":"让更多人看到你的 {model} 作品。","reference_note":"如使用参考图，参考图也会同时公开。","button_label":"分享至广场"}'::JSONB, '图片广场首次分享引导'),
  ('image_plaza_tags', '[{"id":"portrait","label":"人像","enabled":true,"sort_order":0},{"id":"anime","label":"动漫","enabled":true,"sort_order":1},{"id":"poster","label":"海报","enabled":true,"sort_order":2}]'::JSONB, '图片广场内容标签'),
  ('image_plaza_model_catalog', jsonb_build_object(
    'default_model_id', 'seedream-v5-pro',
    'models', jsonb_build_array(
      jsonb_build_object('id','qwen-image-3','provider_model_id','qwen-image-3','name','Qwen Image 3','description','适合海报、信息图与画面内文字','supports_i2i',true,'supports_edit',true,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','1K','label','1K','credits',60),jsonb_build_object('id','2K','label','2K','credits',60)),'enabled',true,'sort_order',0,'internal_tags',jsonb_build_array('uncensored')),
      jsonb_build_object('id','qwen-image-3-pro','provider_model_id','qwen-image-3-pro','name','Qwen Image 3 Pro','description','适合复杂排版、精细文字与高细节成片','supports_i2i',true,'supports_edit',true,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','1K','label','1K','credits',80),jsonb_build_object('id','2K','label','2K','credits',140)),'enabled',true,'sort_order',1,'internal_tags',jsonb_build_array('uncensored')),
      jsonb_build_object('id','seedream-v5-pro','provider_model_id','seedream-v5-pro','name','Seedream V5 Pro','description','适合复杂构图、商业视觉与多语言排版','supports_i2i',true,'supports_edit',true,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','1K','label','1K','credits',90),jsonb_build_object('id','2K','label','2K','credits',170)),'enabled',true,'sort_order',2,'internal_tags',jsonb_build_array('uncensored')),
      jsonb_build_object('id','krea-2-turbo','provider_model_id','krea-2-turbo','name','Krea 2 Turbo','description','适合快速灵感探索与风格化插画','supports_i2i',false,'supports_edit',false,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','1K','label','1K','credits',60),jsonb_build_object('id','2K','label','2K','credits',90)),'enabled',true,'sort_order',3,'internal_tags',jsonb_build_array('uncensored')),
      jsonb_build_object('id','lustify-v8','provider_model_id','lustify-v8','name','Lustify v8','description','适合写实人物与氛围感画面','supports_i2i',false,'supports_edit',false,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','fixed','label','固定','credits',20)),'enabled',true,'sort_order',4,'internal_tags',jsonb_build_array('uncensored')),
      jsonb_build_object('id','seedream-v5-lite','provider_model_id','seedream-v5-lite','name','Seedream V5 Lite','description','适合复杂提示、知识型画面与系列视觉','supports_i2i',true,'supports_edit',true,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','fixed','label','固定','credits',80)),'enabled',true,'sort_order',5,'internal_tags',jsonb_build_array('uncensored')),
      jsonb_build_object('id','chroma','provider_model_id','chroma','name','Chroma','description','适合自然光影与质感人像','supports_i2i',false,'supports_edit',false,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','fixed','label','固定','credits',20)),'enabled',true,'sort_order',6,'internal_tags',jsonb_build_array('review-note')),
      jsonb_build_object('id','lustify-sdxl','provider_model_id','lustify-sdxl','name','Lustify SDXL','description','适合经典 SDXL 风格创作','supports_i2i',false,'supports_edit',false,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','fixed','label','固定','credits',20)),'enabled',true,'sort_order',7,'internal_tags',jsonb_build_array('uncensored')),
      jsonb_build_object('id','anime-wai','provider_model_id','wai-Illustrious','name','Anime (WAI)','description','适合动漫插画与角色立绘','supports_i2i',false,'supports_edit',false,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','fixed','label','固定','credits',20)),'enabled',true,'sort_order',8,'internal_tags',jsonb_build_array('uncensored','anime')),
      jsonb_build_object('id','venice-sd35','provider_model_id','venice-sd35','name','Venice SD35','description','适合写实摄影与真实材质','supports_i2i',false,'supports_edit',false,'aspect_ratios',jsonb_build_array('1:1','2:3','3:2','3:4','4:3','9:16','16:9'),'resolutions',jsonb_build_array(jsonb_build_object('id','fixed','label','固定','credits',20)),'enabled',true,'sort_order',9,'internal_tags',jsonb_build_array('private'))
    )), '图片广场已发布模型目录与上架星尘价')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- 执行后验证（目标环境逐项记录）：
-- 1) 表/RLS/grant/index 与四个 RPC shape；2) Admin 草稿保存/发布/回滚；
-- 3) 余额不足不扣费、成功只扣一次、同 artifact 并发分享只返一次；
-- 4) 关 image_plaza_enabled 后停止新 quote/attempt，已受理任务继续收口。
