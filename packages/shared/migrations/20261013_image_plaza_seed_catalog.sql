-- 图片广场初始作品目录：支持无用户、无生成任务的 Civitai seed 作品，
-- 并将图片广场提示词全链路上限从 600 提升到 2000。
-- 本文件只建立能力，不写入业务数据；导入由 Backend 离线工具在明确环境中执行。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF to_regclass('experience.image_plaza_works') IS NULL
     OR to_regclass('experience.image_plaza_artifacts') IS NULL
     OR to_regclass('experience.image_plaza_attempts') IS NULL
     OR to_regclass('experience.image_plaza_messages') IS NULL THEN
    RAISE EXCEPTION 'image plaza v2 base migration must be applied first';
  END IF;

  IF to_regprocedure(
    'billing.grant_bonus_credits(uuid,numeric,text,text,text,jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION 'billing.grant_bonus_credits must exist before image plaza seed catalog';
  END IF;

  IF EXISTS (
    SELECT 1 FROM experience.image_plaza_messages
    WHERE char_length(trim(content)) > 2000
  ) OR EXISTS (
    SELECT 1 FROM experience.image_plaza_attempts
    WHERE char_length(trim(prompt)) > 2000
  ) THEN
    RAISE EXCEPTION 'existing image plaza prompt exceeds 2000 characters';
  END IF;
END;
$$;

ALTER TABLE experience.image_plaza_messages
  DROP CONSTRAINT IF EXISTS image_plaza_messages_content_check,
  ADD CONSTRAINT image_plaza_messages_content_check
    CHECK (char_length(trim(content)) BETWEEN 1 AND 2000);

ALTER TABLE experience.image_plaza_attempts
  DROP CONSTRAINT IF EXISTS image_plaza_attempts_prompt_check,
  ADD CONSTRAINT image_plaza_attempts_prompt_check
    CHECK (char_length(trim(prompt)) BETWEEN 1 AND 2000);

ALTER TABLE experience.image_plaza_artifacts
  ALTER COLUMN attempt_id DROP NOT NULL,
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated',
  ADD COLUMN source_platform TEXT,
  ADD COLUMN source_image_id TEXT,
  ADD CONSTRAINT image_plaza_artifacts_origin_check
    CHECK (origin IN ('generated', 'civitai_seed')),
  ADD CONSTRAINT image_plaza_artifacts_origin_shape_check CHECK (
    (origin = 'generated'
      AND attempt_id IS NOT NULL
      AND source_platform IS NULL
      AND source_image_id IS NULL)
    OR
    (origin = 'civitai_seed'
      AND attempt_id IS NULL
      AND source_platform = 'civitai'
      AND source_image_id IS NOT NULL
      AND source_image_id ~ '^[0-9]+$')
  );

CREATE UNIQUE INDEX image_plaza_artifacts_seed_source_unique
  ON experience.image_plaza_artifacts(source_platform, source_image_id)
  WHERE origin = 'civitai_seed';

ALTER TABLE experience.image_plaza_works
  ALTER COLUMN user_id DROP NOT NULL,
  ALTER COLUMN attempt_id DROP NOT NULL,
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated',
  ADD COLUMN source_platform TEXT,
  ADD COLUMN source_image_id TEXT,
  ADD COLUMN source_image_url TEXT,
  ADD COLUMN source_heat INTEGER,
  ADD CONSTRAINT image_plaza_works_origin_check
    CHECK (origin IN ('generated', 'civitai_seed')),
  ADD CONSTRAINT image_plaza_works_origin_shape_check CHECK (
    (origin = 'generated'
      AND user_id IS NOT NULL
      AND attempt_id IS NOT NULL
      AND source_platform IS NULL
      AND source_image_id IS NULL
      AND source_image_url IS NULL
      AND source_heat IS NULL)
    OR
    (origin = 'civitai_seed'
      AND user_id IS NULL
      AND attempt_id IS NULL
      AND source_platform = 'civitai'
      AND source_image_id IS NOT NULL
      AND source_image_id ~ '^[0-9]+$'
      AND source_image_url IS NOT NULL
      AND source_image_url ~ '^https://image[.]civitai[.]com/'
      AND source_heat IS NOT NULL
      AND source_heat >= 0)
  );

CREATE UNIQUE INDEX image_plaza_works_seed_source_unique
  ON experience.image_plaza_works(source_platform, source_image_id)
  WHERE origin = 'civitai_seed';

CREATE INDEX image_plaza_works_seed_heat_idx
  ON experience.image_plaza_works(source_heat DESC, source_image_id DESC)
  WHERE origin = 'civitai_seed' AND deleted_at IS NULL;

COMMENT ON COLUMN experience.image_plaza_works.origin IS
  'generated=用户生成后分享；civitai_seed=经离线审核导入的初始目录作品。';
COMMENT ON COLUMN experience.image_plaza_works.source_image_url IS
  '仅供内部追溯和重新转存；公开 API 不得返回。';
COMMENT ON COLUMN experience.image_plaza_works.source_heat IS
  '外部来源热度，仅供初始排序；不得写入本地 like_count。';

-- 统一分享返利的发放出口，并显式拒绝 seed artifact 进入分享返利链路。
-- 这是对已存在 20261012 migration 的 forward-fix；新环境也必须连续应用两份 migration。
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
  v_reward NUMERIC(14,1);
  v_reward_ledger UUID;
  v_grant RECORD;
BEGIN
  IF p_rebate_rate IS NULL OR p_rebate_rate < 0 OR p_rebate_rate > 1 THEN
    RAISE EXCEPTION 'invalid image plaza rebate rate' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_artifact FROM experience.image_plaza_artifacts WHERE id = p_artifact_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'artifact not found' USING ERRCODE = 'P0002'; END IF;
  IF v_artifact.origin <> 'generated' OR v_artifact.attempt_id IS NULL THEN
    RAISE EXCEPTION 'artifact is not shareable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_attempt
  FROM experience.image_plaza_attempts
  WHERE id = v_artifact.attempt_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_attempt.user_id <> p_user_id
     OR v_attempt.status <> 'ready'
     OR v_attempt.debit_ledger_id IS NULL THEN
    RAISE EXCEPTION 'artifact is not shareable' USING ERRCODE = '42501';
  END IF;
  IF v_attempt.reference_artifact_id IS NOT NULL THEN
    PERFORM 1
    FROM experience.image_plaza_reference_assets AS reference
    WHERE reference.id = v_attempt.reference_artifact_id
      AND (
        reference.user_id = p_user_id
        OR EXISTS (
          SELECT 1
          FROM experience.image_plaza_works AS source_work
          WHERE source_work.deleted_at IS NULL
            AND source_work.snapshot->>'reference_artifact_id' = reference.id::TEXT
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reference artifact not accessible' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT * INTO v_work FROM experience.image_plaza_works WHERE artifact_id = p_artifact_id;
  IF FOUND THEN
    SELECT reward_credits INTO v_reward
    FROM billing.image_plaza_share_rewards
    WHERE work_id = v_work.id;
    RETURN jsonb_build_object(
      'work_id', v_work.id,
      'already_shared', true,
      'reward_credits', COALESCE(v_reward, 0)
    );
  END IF;

  INSERT INTO experience.image_plaza_works(
    user_id, attempt_id, artifact_id, title, model_id, model_name, width, height, tags, snapshot
  ) VALUES (
    p_user_id, v_attempt.id, v_artifact.id, left(trim(p_title), 80),
    v_attempt.model_id, left(trim(p_model_name), 80),
    v_artifact.width, v_artifact.height, COALESCE(p_tags, '{}'),
    jsonb_build_object(
      'prompt', v_attempt.prompt,
      'model_id', v_attempt.model_id,
      'aspect_ratio', v_attempt.aspect_ratio,
      'resolution', v_attempt.resolution,
      'reasoning', v_attempt.reasoning,
      'auto_optimize', v_attempt.auto_optimize,
      'mode', v_attempt.mode,
      'reference_artifact_id', v_attempt.reference_artifact_id,
      'style', 'None'
    )
  ) RETURNING * INTO v_work;

  v_reward := round(v_attempt.credits_charged * p_rebate_rate, 1);
  IF v_reward > 0 THEN
    SELECT * INTO v_grant
    FROM billing.grant_bonus_credits(
      p_user_id,
      v_reward,
      'image_plaza_share_reward',
      'image_plaza_share_reward',
      v_work.id::TEXT,
      jsonb_build_object(
        'attempt_id', v_attempt.id,
        'debit_ledger_id', v_attempt.debit_ledger_id,
        'rebate_rate', p_rebate_rate
      )
    );
    v_reward_ledger := v_grant.o_ledger_id;
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
  RETURN jsonb_build_object(
    'work_id', v_work.id,
    'already_shared', false,
    'reward_credits', v_reward
  );
END;
$$;

REVOKE ALL ON FUNCTION billing.share_image_plaza_artifact(UUID, UUID, TEXT, TEXT, TEXT[], NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.share_image_plaza_artifact(UUID, UUID, TEXT, TEXT, TEXT[], NUMERIC)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION experience.import_image_plaza_seed_work(
  p_source_image_id TEXT,
  p_source_image_url TEXT,
  p_source_heat INTEGER,
  p_storage_path TEXT,
  p_mime_type TEXT,
  p_byte_size INTEGER,
  p_width INTEGER,
  p_height INTEGER,
  p_title TEXT,
  p_model_id TEXT,
  p_model_name TEXT,
  p_snapshot JSONB,
  p_published_at TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_artifact experience.image_plaza_artifacts%ROWTYPE;
  v_work experience.image_plaza_works%ROWTYPE;
BEGIN
  IF p_source_image_id IS NULL OR p_source_image_id !~ '^[0-9]+$'
     OR p_source_image_url IS NULL
     OR p_source_image_url !~ '^https://image[.]civitai[.]com/'
     OR p_source_heat IS NULL OR p_source_heat < 0
     OR p_storage_path IS NULL
     OR p_storage_path !~ '^image-plaza/imports/civitai/[0-9]+[.](png|jpg|webp)$'
     OR p_mime_type NOT IN ('image/png', 'image/jpeg', 'image/webp')
     OR p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 20971520
     OR p_width IS NULL OR p_width NOT BETWEEN 1 AND 8192
     OR p_height IS NULL OR p_height NOT BETWEEN 1 AND 8192
     OR char_length(trim(COALESCE(p_title, ''))) NOT BETWEEN 1 AND 80
     OR char_length(trim(COALESCE(p_model_id, ''))) NOT BETWEEN 1 AND 80
     OR char_length(trim(COALESCE(p_model_name, ''))) NOT BETWEEN 1 AND 80
     OR p_snapshot IS NULL
     OR jsonb_typeof(p_snapshot) <> 'object'
     OR char_length(trim(COALESCE(p_snapshot->>'prompt', ''))) NOT BETWEEN 1 AND 2000
     OR p_snapshot->>'model_id' IS DISTINCT FROM p_model_id
     OR p_snapshot->>'mode' IS DISTINCT FROM 't2i'
     OR p_snapshot->>'style' IS DISTINCT FROM 'None'
     OR p_snapshot->>'auto_optimize' IS DISTINCT FROM 'false'
     OR p_snapshot->>'reasoning' IS DISTINCT FROM 'false'
     OR p_snapshot->'reference_artifact_id' IS DISTINCT FROM 'null'::JSONB
     OR p_snapshot->>'aspect_ratio' NOT IN ('1:1','2:3','3:2','3:4','4:3','4:5','9:16','16:9','21:9')
     OR p_snapshot->>'resolution' NOT IN ('1K','2K','fixed')
     OR p_published_at IS NULL THEN
    RAISE EXCEPTION 'invalid image plaza seed work' USING ERRCODE = '22023';
  END IF;

  -- 同一个来源 ID 的并发导入串行化；事务失败不会遗留 artifact/work 半成品。
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('image_plaza:civitai:' || p_source_image_id, 0)
  );

  SELECT work.* INTO v_work
  FROM experience.image_plaza_works AS work
  WHERE work.origin = 'civitai_seed'
    AND work.source_platform = 'civitai'
    AND work.source_image_id = p_source_image_id;

  IF FOUND THEN
    SELECT artifact.* INTO v_artifact
    FROM experience.image_plaza_artifacts AS artifact
    WHERE artifact.id = v_work.artifact_id;

    IF v_work.source_image_url IS DISTINCT FROM p_source_image_url
       OR v_work.model_id IS DISTINCT FROM p_model_id
       OR v_work.snapshot IS DISTINCT FROM p_snapshot
       OR v_artifact.storage_path IS DISTINCT FROM p_storage_path THEN
      RAISE EXCEPTION 'image plaza seed idempotency conflict' USING ERRCODE = '23505';
    END IF;

    RETURN jsonb_build_object(
      'work_id', v_work.id,
      'artifact_id', v_artifact.id,
      'already_imported', true
    );
  END IF;

  INSERT INTO experience.image_plaza_artifacts(
    attempt_id, position, storage_path, mime_type, byte_size, width, height,
    origin, source_platform, source_image_id
  ) VALUES (
    NULL, 0, p_storage_path, p_mime_type, p_byte_size, p_width, p_height,
    'civitai_seed', 'civitai', p_source_image_id
  ) RETURNING * INTO v_artifact;

  INSERT INTO experience.image_plaza_works(
    user_id, attempt_id, artifact_id, title, model_id, model_name,
    width, height, tags, snapshot, like_count, published_at,
    origin, source_platform, source_image_id, source_image_url, source_heat
  ) VALUES (
    NULL, NULL, v_artifact.id, trim(p_title), p_model_id, trim(p_model_name),
    p_width, p_height, '{}', p_snapshot, 0, p_published_at,
    'civitai_seed', 'civitai', p_source_image_id, p_source_image_url, p_source_heat
  ) RETURNING * INTO v_work;

  RETURN jsonb_build_object(
    'work_id', v_work.id,
    'artifact_id', v_artifact.id,
    'already_imported', false
  );
END;
$$;

REVOKE ALL ON FUNCTION experience.import_image_plaza_seed_work(
  TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.import_image_plaza_seed_work(
  TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ
) TO service_role, postgres;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'experience.image_plaza_attempts'::regclass
      AND conname = 'image_plaza_attempts_prompt_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%2000%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'experience.image_plaza_messages'::regclass
      AND conname = 'image_plaza_messages_content_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%2000%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'experience.image_plaza_works'::regclass
      AND attname = 'source_image_id'
      AND NOT attisdropped
  ) OR pg_catalog.pg_get_functiondef(
    'billing.share_image_plaza_artifact(uuid,uuid,text,text,text[],numeric)'::regprocedure
  ) NOT LIKE '%billing.grant_bonus_credits%'
  OR pg_catalog.pg_get_functiondef(
    'billing.share_image_plaza_artifact(uuid,uuid,text,text,text[],numeric)'::regprocedure
  ) LIKE '%UPDATE billing.user_wallets%'
  THEN
    RAISE EXCEPTION 'image plaza seed catalog self-check failed';
  END IF;
END;
$$;

COMMIT;

-- Test 环境验证建议（手动，一次只执行本文件）：
-- 1. 检查新增列、CHECK、partial unique index 和函数权限。
-- 2. 以审核清单中的 1 条数据运行 importer canary，验证 feed/detail/like/用同款。
-- 3. 重跑同一条确认 already_imported=true，且本地 like_count 不受 source_heat 影响。
-- 回滚/恢复：初始数据未导入时可 DROP FUNCTION/INDEX/COLUMN 并恢复 NOT NULL；
-- 已导入后优先 forward-fix 或先删除 origin='civitai_seed' 的 work/artifact 与 Storage 对象。
