-- Civitai 初始作品中的少量原图超过 20 MiB；仅放宽离线 seed 转存所需的
-- artifact / 私有 bucket / service-role RPC 容量。普通用户上传仍由 Backend 限制为 20 MiB。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  v_definition TEXT;
  v_old_fragment CONSTANT TEXT := 'p_byte_size NOT BETWEEN 1 AND 20971520';
  v_new_fragment CONSTANT TEXT := 'p_byte_size NOT BETWEEN 1 AND 52428800';
BEGIN
  IF to_regclass('experience.image_plaza_artifacts') IS NULL
     OR to_regprocedure(
       'experience.import_image_plaza_seed_work(text,text,integer,text,text,integer,integer,integer,text,text,text,jsonb,timestamp with time zone)'
     ) IS NULL THEN
    RAISE EXCEPTION 'image plaza seed catalog migration must be applied first';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'image-plaza') THEN
    RAISE EXCEPTION 'image-plaza storage bucket must exist first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM experience.image_plaza_artifacts WHERE byte_size > 52428800
  ) THEN
    RAISE EXCEPTION 'existing image plaza artifact exceeds 50 MiB';
  END IF;

  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'experience'
    AND p.proname = 'import_image_plaza_seed_work'
    AND pg_get_function_identity_arguments(p.oid) =
      'p_source_image_id text, p_source_image_url text, p_source_heat integer, p_storage_path text, p_mime_type text, p_byte_size integer, p_width integer, p_height integer, p_title text, p_model_id text, p_model_name text, p_snapshot jsonb, p_published_at timestamp with time zone';

  IF v_definition IS NULL OR strpos(v_definition, v_old_fragment) = 0 THEN
    RAISE EXCEPTION 'unexpected image plaza seed import function definition';
  END IF;
  IF strpos(replace(v_definition, v_old_fragment, ''), v_old_fragment) > 0 THEN
    RAISE EXCEPTION 'ambiguous image plaza seed byte limit definition';
  END IF;

  EXECUTE replace(v_definition, v_old_fragment, v_new_fragment);
END;
$$;

ALTER TABLE experience.image_plaza_artifacts
  DROP CONSTRAINT IF EXISTS image_plaza_artifacts_byte_size_check,
  ADD CONSTRAINT image_plaza_artifacts_byte_size_check
    CHECK (byte_size BETWEEN 1 AND 52428800);

UPDATE storage.buckets
SET file_size_limit = GREATEST(COALESCE(file_size_limit, 0), 52428800),
    updated_at = now()
WHERE id = 'image-plaza';

DO $$
DECLARE
  v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'experience'
    AND p.proname = 'import_image_plaza_seed_work';

  IF v_definition IS NULL
     OR strpos(v_definition, 'p_byte_size NOT BETWEEN 1 AND 52428800') = 0 THEN
    RAISE EXCEPTION 'image plaza seed import 50 MiB self-check failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'experience.image_plaza_artifacts'::regclass
      AND conname = 'image_plaza_artifacts_byte_size_check'
      AND pg_get_constraintdef(oid) LIKE '%<= 52428800%'
  ) THEN
    RAISE EXCEPTION 'image plaza artifact 50 MiB self-check failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'image-plaza' AND file_size_limit >= 52428800
  ) THEN
    RAISE EXCEPTION 'image plaza bucket 50 MiB self-check failed';
  END IF;
END;
$$;

COMMIT;

-- 回滚 / forward-fix：先停止 seed importer；确认不存在 byte_size > 20 MiB 的 artifact
-- 及其 Storage 对象后，才可把约束、bucket 和 RPC 上限恢复为 20 MiB。
