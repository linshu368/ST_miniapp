-- domain: drama_archive (existing external archive domain; no new schema/table/RPC)
-- TEST only: ST_telegrambot/testdb, ref zoqelpfhurwehlvypryl.
-- Apply via db-migrate.yml, one file, after reviewing this batch and checksum.
-- Baseline 2026-10-26: 577 videos, unique NOT NULL (source_id, message_id),
-- drama-level ai_results already deployed. Refuse changed size/shape; do not force rerun.
--
-- created_at is the first successful upload/display time, written by the external
-- uploader in future. No now() default: insert time is not upload success time.
-- This batch uses synthetic display times, NOT historical upload facts:
-- 2026-10-20 11:00:00+08 + (row_number - 1) * 10 minutes, source/message ASC.
-- Existing non-NULL values must match the same whole-batch sequence; never renumber
-- just the remaining NULL rows. Keep ACL/RLS, metadata and playback readiness unchanged.
--
-- Capacity/recovery: bounded 577-row update, no index/table rewrite or external calls.
-- ACCESS EXCLUSIVE freezes imports before numbering and satisfies ALTER's lock.
-- 5s lock / 60s per-statement budgets. Failure rolls back the column and all updates.
-- Unknown result: inspect repo_migrations/claims/shape before any retry.
-- Application rollback keeps this column/data; wrong committed times require a reviewed
-- targeted forward-fix. Do not DROP/clear the column or rerun against a larger batch.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_column record;
BEGIN
  IF to_regclass('drama_archive.videos') IS NULL
     OR to_regclass('drama_archive.dramas') IS NULL
     OR to_regclass('drama_archive.ai_results') IS NULL THEN
    RAISE EXCEPTION 'drama timestamp preflight: required archive tables missing';
  END IF;
  FOR v_column IN
    SELECT * FROM (VALUES
      ('videos', 'id', 'uuid'), ('videos', 'source_id', 'bigint'),
      ('videos', 'message_id', 'bigint'), ('videos', 'drama_id', 'uuid'),
      ('dramas', 'tags', 'text[]'), ('dramas', 'description', 'text'),
      ('ai_results', 'drama_id', 'uuid'), ('ai_results', 'title', 'text'),
      ('ai_results', 'tags', 'text[]'), ('ai_results', 'description', 'text')
    ) AS expected(table_name, column_name, type_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass('drama_archive.' || v_column.table_name)
        AND a.attname = v_column.column_name AND NOT a.attisdropped
        AND format_type(a.atttypid, a.atttypmod) = v_column.type_name
        AND (v_column.table_name <> 'videos' OR a.attnotnull)
    ) THEN
      RAISE EXCEPTION 'drama timestamp preflight: unexpected column shape';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'drama_archive.videos'::regclass AND contype = 'u' AND convalidated
      AND pg_get_constraintdef(oid) = 'UNIQUE (source_id, message_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'drama_archive.ai_results'::regclass AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (drama_id)'
  ) THEN
    RAISE EXCEPTION 'drama timestamp preflight: expected batch key or drama AI key missing';
  END IF;
END
$preflight$;

LOCK TABLE drama_archive.videos IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE drama_video_acl_before ON COMMIT DROP AS
SELECT relacl, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid = 'drama_archive.videos'::regclass;

DO $shape$
BEGIN
  IF (SELECT count(*) FROM drama_archive.videos) <> 577 THEN
    RAISE EXCEPTION 'drama timestamp preflight: batch size changed; review before retry';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'drama_archive.videos'::regclass AND attname = 'created_at'
      AND NOT attisdropped
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'drama_archive.videos'::regclass AND attname = 'created_at'
        AND NOT attisdropped AND atttypid = 'timestamptz'::regtype
        AND NOT attnotnull AND NOT atthasdef AND attgenerated = ''
    ) THEN
      RAISE EXCEPTION 'drama timestamp preflight: created_at must be nullable timestamptz without default';
    END IF;
  ELSE
    ALTER TABLE drama_archive.videos ADD COLUMN created_at timestamptz;
  END IF;
END
$shape$;

CREATE TEMP TABLE drama_video_time_batch ON COMMIT DROP AS
SELECT id,
       created_at AS original_created_at,
       timestamptz '2026-10-20 11:00:00+08'
         + (row_number() OVER (ORDER BY source_id, message_id) - 1) * interval '10 minutes'
         AS expected_created_at,
       md5((to_jsonb(v) - 'created_at')::text) AS original_metadata_hash
FROM drama_archive.videos v;

DO $conflicts$
BEGIN
  IF EXISTS (
    SELECT 1 FROM drama_video_time_batch
    WHERE original_created_at IS NOT NULL AND original_created_at <> expected_created_at
  ) THEN
    RAISE EXCEPTION 'drama timestamp preflight: existing time conflicts with batch; refusing overwrite';
  END IF;
END
$conflicts$;

UPDATE drama_archive.videos v
SET created_at = b.expected_created_at
FROM drama_video_time_batch b
WHERE v.id = b.id AND v.created_at IS NULL;

COMMENT ON COLUMN drama_archive.videos.created_at IS
  'First successful upload/display time, set once by uploader; NULL until known, no default. 20261026 TEST batch uses synthetic 2026-10-20 11:00+08 plus 10 minutes per source_id/message_id order, not historical upload time.';

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM drama_video_time_batch b
    LEFT JOIN drama_archive.videos v ON v.id = b.id
    WHERE v.id IS NULL OR v.created_at IS DISTINCT FROM b.expected_created_at
      OR md5((to_jsonb(v) - 'created_at')::text) IS DISTINCT FROM b.original_metadata_hash
      OR (b.original_created_at IS NOT NULL AND v.created_at <> b.original_created_at)
  ) OR (SELECT count(*) FROM drama_archive.videos) <> 577 THEN
    RAISE EXCEPTION 'drama timestamp postflight: batch coverage or original metadata changed';
  END IF;
  IF (SELECT min(created_at) FROM drama_archive.videos)
        IS DISTINCT FROM timestamptz '2026-10-20 03:00:00Z'
     OR EXISTS (
       SELECT 1 FROM (
         SELECT created_at - lag(created_at) OVER (ORDER BY source_id, message_id) AS gap
         FROM drama_archive.videos
       ) steps WHERE gap IS NOT NULL AND gap <> interval '600 seconds'
     ) THEN
    RAISE EXCEPTION 'drama timestamp postflight: origin or interval differs';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c CROSS JOIN drama_video_acl_before b
    WHERE c.oid = 'drama_archive.videos'::regclass
      AND (c.relacl IS DISTINCT FROM b.relacl OR c.relrowsecurity <> b.relrowsecurity
           OR c.relforcerowsecurity <> b.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'drama timestamp postflight: ACL/RLS changed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';
COMMIT;
