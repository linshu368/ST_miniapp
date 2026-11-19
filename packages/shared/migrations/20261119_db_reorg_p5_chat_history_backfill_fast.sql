-- Domain: experience（对话轮次 chat_history）——数据库重组阶段 5a 回填的提速补充。
-- 计划见 .trellis/tasks/11-19-db-reorg-p5-chat-history/design.md。
--
-- 背景：20261119_db_reorg_p5_chat_history_backfill.sql 在生产每次 CALL 都按主键从头重走 keyset，已完成的部分越多，
--   重走（随机读主表）占掉的时间越多，吞吐从每次约 1 万行掉到约 1800 行；按 UUID 顺序处理也让 TOAST 读成随机读。
--   原文件在生产有失败认领（生产不能 abandon_claim），不改原文件；本文件做完剩余部分后，重跑原文件即可闭合认领（剩余为 0）。
-- 做法：每次 CALL 先做量小的两项（首字预览、drive_mode），再一次扫出全部待补投影的 id，按 created_at 顺序
--   （≈TOAST 写入顺序）每 100 个调用既有的 backfill_chat_history_display，每 1000 个提交一次；约 50 秒后返回。
--   与原文件相同：不包事务、不依赖会话状态（经 Supavisor 事务池执行），投影或预览没做完就报错，重跑本文件继续。
--
-- Verify: bash scripts/test-db-reorg-p5-migration.sh
-- Release: TEST（空操作）-> Production -> 重跑 20261119_db_reorg_p5_chat_history_backfill.sql 闭合认领。
-- Recovery: 只写新列与投影表；无需回退。

CREATE OR REPLACE PROCEDURE experience.p5_chat_history_backfill_fast_step()
LANGUAGE plpgsql AS $proc$
DECLARE
  v_deadline CONSTANT timestamptz := clock_timestamp() + interval '50 seconds';
  v_todo uuid[];
  v_part uuid[];
  v_done bigint := 0;
  v_skipped bigint := 0;
  v_rows bigint;
  v_total bigint := 0;
  v_n integer;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  -- 1. First-token preview into the delivery-state table (small rows; one pass).
  SELECT array_agg(r.chat_history_id) INTO v_todo
  FROM experience.chat_generation_requests r JOIN experience.chat_history h ON h.id = r.chat_history_id
  WHERE h.first_token_preview IS NOT NULL AND r.first_token_preview IS DISTINCT FROM h.first_token_preview;
  IF v_todo IS NOT NULL THEN
    FOR i IN 0 .. (cardinality(v_todo) - 1) / 2000 LOOP
      UPDATE experience.chat_generation_requests r SET first_token_preview = h.first_token_preview
      FROM experience.chat_history h
      WHERE r.chat_history_id = ANY (v_todo[i * 2000 + 1 : i * 2000 + 2000]) AND h.id = r.chat_history_id
        AND h.first_token_preview IS NOT NULL AND r.first_token_preview IS DISTINCT FROM h.first_token_preview;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_total := v_total + v_rows;
      COMMIT;
      PERFORM set_config('lock_timeout', '5s', true);
    END LOOP;
  END IF;
  RAISE NOTICE 'p5 backfill fast: first_token_preview copied % rows', v_total;

  -- 2. drive_mode out of rich_reply_metadata.
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
  RAISE NOTICE 'p5 backfill fast: drive_mode copied % rows', v_total;

  -- 3. Display projection: all remaining ids in one scan (null bitmap only, no detoast), in write order.
  SELECT array_agg(h.id ORDER BY h.created_at, h.id) INTO v_todo
  FROM experience.chat_history h
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
    AND h.history IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata m
                    WHERE m.history_id = h.id AND m.projection_version = 1);
  IF v_todo IS NOT NULL THEN
    FOR i IN 0 .. (cardinality(v_todo) - 1) / 100 LOOP
      IF clock_timestamp() > v_deadline THEN
        COMMIT;
        RAISE NOTICE 'p5 backfill fast: display projection written % rows, skipped (locked) %, % left, time budget used',
          v_done, v_skipped, cardinality(v_todo) - i * 100;
        RETURN;
      END IF;
      v_part := v_todo[i * 100 + 1 : i * 100 + 100];
      v_n := experience.backfill_chat_history_display(v_part);
      v_done := v_done + v_n;
      v_skipped := v_skipped + cardinality(v_part) - v_n;
      IF i % 10 = 9 THEN
        COMMIT;
        PERFORM set_config('lock_timeout', '5s', true);
      END IF;
    END LOOP;
    COMMIT;
  END IF;
  RAISE NOTICE 'p5 backfill fast: display projection written % rows, skipped (locked) %', v_done, v_skipped;
END
$proc$;
REVOKE ALL ON PROCEDURE experience.p5_chat_history_backfill_fast_step() FROM PUBLIC, anon, authenticated, service_role;

-- Roughly one CALL per 10k rows still to project, plus a few for rows skipped under a lock.
SELECT 'CALL experience.p5_chat_history_backfill_fast_step()'
FROM generate_series(1, 3 + (
  SELECT count(*) FROM experience.chat_history h
  WHERE h.session_id IS NOT NULL AND h.turn_index IS NOT NULL AND h.revision IS NOT NULL
    AND h.history IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM experience.chat_history_display_metadata m
                    WHERE m.history_id = h.id AND m.projection_version = 1))::integer / 10000)
\gexec

DROP PROCEDURE experience.p5_chat_history_backfill_fast_step();

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
  RAISE NOTICE 'p5 backfill fast remaining: projection % / preview % / drive_mode %', v_projection, v_preview, v_drive;
  IF v_projection > 0 OR v_preview > 0 THEN
    RAISE EXCEPTION 'p5 backfill incomplete; rerun this file to continue';
  END IF;
END
$report$;
