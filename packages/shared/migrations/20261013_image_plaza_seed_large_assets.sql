-- Civitai 初始作品中的少量原图超过 20 MiB；仅放宽离线 seed 转存所需的
-- artifact / 私有 bucket / service-role RPC 容量。普通用户上传仍由 Backend 限制为 20 MiB。

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  v_definition TEXT;
  v_function_oid OID;
  v_old_occurrences INTEGER;
  v_old_fragment CONSTANT TEXT := 'p_byte_size NOT BETWEEN 1 AND 20971520';
  v_new_fragment CONSTANT TEXT := 'p_byte_size NOT BETWEEN 1 AND 52428800';
BEGIN
  v_function_oid := to_regprocedure(
    'experience.import_image_plaza_seed_work(text,text,integer,text,text,integer,integer,integer,text,text,text,jsonb,timestamp with time zone)'
  )::OID;

  IF to_regclass('experience.image_plaza_artifacts') IS NULL
     OR v_function_oid IS NULL THEN
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

  SELECT pg_get_functiondef(v_function_oid)
  INTO v_definition
  WHERE v_function_oid IS NOT NULL;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'unexpected image plaza seed import function definition';
  END IF;

  IF strpos(v_definition, v_new_fragment) > 0 THEN
    IF strpos(v_definition, v_old_fragment) > 0 THEN
      RAISE EXCEPTION 'ambiguous image plaza seed byte limit definition';
    END IF;
  ELSIF strpos(v_definition, v_old_fragment) > 0 THEN
    v_old_occurrences := (
      char_length(v_definition) - char_length(replace(v_definition, v_old_fragment, ''))
    ) / char_length(v_old_fragment);

    IF v_old_occurrences <> 1 THEN
      RAISE EXCEPTION 'ambiguous image plaza seed byte limit definition';
    END IF;

    EXECUTE replace(v_definition, v_old_fragment, v_new_fragment);
  ELSE
    RAISE EXCEPTION 'unexpected image plaza seed import byte limit definition';
  END IF;
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
  SELECT pg_get_functiondef(
    to_regprocedure(
      'experience.import_image_plaza_seed_work(text,text,integer,text,text,integer,integer,integer,text,text,text,jsonb,timestamp with time zone)'
    )::OID
  )
  INTO v_definition
  WHERE to_regprocedure(
    'experience.import_image_plaza_seed_work(text,text,integer,text,text,integer,integer,integer,text,text,text,jsonb,timestamp with time zone)'
  ) IS NOT NULL;

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
