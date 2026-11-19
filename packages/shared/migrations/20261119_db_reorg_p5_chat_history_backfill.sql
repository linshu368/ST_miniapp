-- Domain: experience（对话轮次 chat_history）——数据库重组阶段 5a 回填。
-- 计划见 .trellis/tasks/11-19-db-reorg-p5-chat-history/design.md；在 20261119_db_reorg_p5_chat_history_expand.sql 之后执行。
--
--   1. 展示投影：有会话标识、history 非空、还没有 v1 投影的存量轮次（生产约 26 万行；扩展后的新轮次 history 为 NULL，
--      缺投影与解析 NULL 结果相同，不需要），每 100 个 id 调一次既有的
--      experience.backfill_chat_history_display（锁本批的行、跳过正被写的行）。完成后会话轮次的展示不再解析 history。
--   2. chat_generation_requests.first_token_preview ← chat_history.first_token_preview（生产约 6.1 万行）。
--   3. chat_history.drive_mode ← rich_reply_metadata->>'drive_mode'（生产约 1.8 万行）。
--   4. 校验扩展时 NOT VALID 的两个 CHECK（SHARE UPDATE EXCLUSIVE，不挡读写）。
--
-- 执行方式（经 Supavisor 事务池也成立，不依赖会话状态）：本文件不包事务；建一个持久过程，按剩余量用 \gexec 生成若干次
-- CALL，每次 CALL 最多工作约 50 秒、每批单独 COMMIT（单批只持本批的行锁，lock_timeout 每个事务各设一次）；
-- 最后核对投影与预览，未做完就报错（认领失败，重跑本文件从剩余处继续）。后端发布前旧后端仍把 drive_mode 写进 jsonb，收缩时在锁内再补一次。
--
-- Verify: bash scripts/test-db-reorg-p5-migration.sh；执行日志里的 NOTICE 给出每次 CALL 的进度与最终剩余数。
-- Release: TEST -> Production（扩展之后）。
-- Recovery: 只写新列与投影表，旧读写路径不受影响；无需回退。

CREATE OR REPLACE PROCEDURE experience.p5_chat_history_backfill_step()
LANGUAGE plpgsql AS $proc$
DECLARE
  v_zero CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
  v_deadline CONSTANT timestamptz := clock_timestamp() + interval '50 seconds';
  v_last uuid := v_zero;
  v_hi uuid;
  v_ids uuid[];
  v_part uuid[];
  v_done bigint := 0;
  v_skipped bigint := 0;
  v_rows bigint;
  v_total bigint := 0;
  v_n integer;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  -- 1. Display projection, keyset over the primary key (done ranges are only probed).
  LOOP
    IF clock_timestamp() > v_deadline THEN
      RAISE NOTICE 'p5 backfill: display projection written % rows, skipped (locked) %, time budget used', v_done, v_skipped;
      RETURN;
    END IF;
    SELECT array_agg(id ORDER BY id) INTO v_ids
    FROM (SELECT h.id FROM experience.chat_history h WHERE h.id > v_last ORDER BY h.id LIMIT 1000) s;
    EXIT WHEN v_ids IS NULL;
    v_last := v_ids[cardinality(v_ids)];
    SELECT array_agg(h.id ORDER BY h.id) INTO v_ids
    FROM experience.chat_history h
    WHERE h.id = ANY (v_ids) AND h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
    AND h.history IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata m
                      WHERE m.history_id = h.id AND m.projection_version = 1);
    IF v_ids IS NOT NULL THEN
      FOR i IN 0 .. (cardinality(v_ids) - 1) / 100 LOOP
        v_part := v_ids[i * 100 + 1 : i * 100 + 100];
        v_n := experience.backfill_chat_history_display(v_part);
        v_done := v_done + v_n;
        v_skipped := v_skipped + cardinality(v_part) - v_n;
      END LOOP;
    END IF;
    COMMIT;
    PERFORM set_config('lock_timeout', '5s', true);
  END LOOP;
  RAISE NOTICE 'p5 backfill: display projection written % rows, skipped (locked) %', v_done, v_skipped;

  -- 2. First-token preview into the delivery-state table.
  v_last := v_zero;
  LOOP
    -- No max(uuid) before PG18: take the last key of the next keyset page.
    SELECT s.chat_history_id INTO v_hi
    FROM (SELECT r.chat_history_id FROM experience.chat_generation_requests r
          WHERE r.chat_history_id > v_last ORDER BY r.chat_history_id LIMIT 2000) s
    ORDER BY s.chat_history_id DESC LIMIT 1;
    EXIT WHEN v_hi IS NULL;
    UPDATE experience.chat_generation_requests r SET first_token_preview = h.first_token_preview
    FROM experience.chat_history h
    WHERE r.chat_history_id > v_last AND r.chat_history_id <= v_hi AND h.id = r.chat_history_id
      AND h.first_token_preview IS NOT NULL AND r.first_token_preview IS DISTINCT FROM h.first_token_preview;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;
    v_last := v_hi;
    COMMIT;
    PERFORM set_config('lock_timeout', '5s', true);
  END LOOP;
  RAISE NOTICE 'p5 backfill: first_token_preview copied % rows', v_total;

  -- 3. drive_mode out of rich_reply_metadata (the key first appeared in November).
  v_total := 0;
  LOOP
    UPDATE experience.chat_history h SET drive_mode = h.rich_reply_metadata->>'drive_mode'
    WHERE h.id IN (
      SELECT c.id FROM experience.chat_history c
      WHERE c.created_at >= '2026-11-01' AND c.rich_reply_metadata ? 'drive_mode'
        AND c.drive_mode IS DISTINCT FROM c.rich_reply_metadata->>'drive_mode'
      LIMIT 1000 FOR UPDATE SKIP LOCKED);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    COMMIT;
    PERFORM set_config('lock_timeout', '5s', true);
    EXIT WHEN v_rows = 0;
    v_total := v_total + v_rows;
  END LOOP;
  RAISE NOTICE 'p5 backfill: drive_mode copied % rows', v_total;
END
$proc$;
REVOKE ALL ON PROCEDURE experience.p5_chat_history_backfill_step() FROM PUBLIC, anon, authenticated, service_role;

-- Roughly one CALL per 20k rows still to project, plus a few for the small phases and rows skipped under a lock.
SELECT 'CALL experience.p5_chat_history_backfill_step()'
FROM generate_series(1, 3 + (
  SELECT count(*) FROM experience.chat_history h
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
    AND h.history IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata m
                    WHERE m.history_id = h.id AND m.projection_version = 1))::integer / 20000)
\gexec

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
ALTER TABLE experience.chat_generation_requests VALIDATE CONSTRAINT chat_generation_requests_first_token_preview_check;
ALTER TABLE experience.chat_history VALIDATE CONSTRAINT chat_history_drive_mode_check;
COMMIT;

DROP PROCEDURE experience.p5_chat_history_backfill_step();

DO $report$
DECLARE
  v_projection bigint;
  v_preview bigint;
  v_drive bigint;
BEGIN
  SELECT count(*) INTO v_projection FROM experience.chat_history h
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
    AND h.history IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata m
                    WHERE m.history_id = h.id AND m.projection_version = 1);
  SELECT count(*) INTO v_preview FROM experience.chat_generation_requests r JOIN experience.chat_history h ON h.id = r.chat_history_id
  WHERE h.first_token_preview IS NOT NULL AND r.first_token_preview IS DISTINCT FROM h.first_token_preview;
  SELECT count(*) INTO v_drive FROM experience.chat_history c
  WHERE c.created_at >= '2026-11-01' AND c.rich_reply_metadata ? 'drive_mode'
    AND c.drive_mode IS DISTINCT FROM c.rich_reply_metadata->>'drive_mode';
  RAISE NOTICE 'p5 backfill remaining: projection % / preview % / drive_mode %', v_projection, v_preview, v_drive;
  -- drive_mode keeps arriving in jsonb from the old backend until the release; contract re-syncs it under lock.
  IF v_projection > 0 OR v_preview > 0 THEN
    RAISE EXCEPTION 'p5 backfill incomplete; rerun this file to continue';
  END IF;
END
$report$;
