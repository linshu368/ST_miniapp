-- Domain: ops（每轮发给模型的 prompt 快照）——数据库重组阶段 5b 第一步：保留 7 天（用户 11-19 确认）。
-- 计划见 .trellis/tasks/11-19-db-reorg-p5-chat-history/design.md（5b）。
--
-- 1. 清理函数 ops.cleanup_chat_prompt_observations(保留期, 每批行数, 最多批数)：按 created_at 删超期快照，返回删除行数。
--    生产用 pg_cron 每小时第 17 分调一次（保留 7 天、每批 1000、最多 20 批）；TEST 没有 pg_cron，只建函数。
-- 2. 把 5a 之前、最近 7 天内的定稿 prompt 从 experience.chat_history.history 复制进 ops.chat_prompt_observations：
--    只复制带计费快照的行（11-19 生产核对：这些行的 history 都在 8KB 以上，是完整 prompt；没有快照的 313 行
--    都在 100 字节以内，只是开轮时的请求标记，新函数也不写这种）；created_at 取轮次创建时间，让保留期按轮次算；
--    已在 ops 的行不动（ON CONFLICT DO NOTHING）。5a 起新轮次不再写 history，复制不和写入竞争。
--    过程按 created_at 顺序（≈ TOAST 写入顺序）每 200 行提交一次，约 50 秒后返回；没复制完就报错，重跑本文件继续。
--    不包事务、不依赖会话状态（经 Supavisor 事务池执行）。
-- 本文件不改 chat_history；删 history 列与释放空间在 5b 第二、三步。
--
-- Verify: bash scripts/test-db-reorg-p5b-retention.sh
-- Release: TEST -> Production（没复制完时按原文件重跑，直到打印 copied all）。
-- Recovery: 只写 ops 与 cron；停清理任务 = SELECT cron.unschedule('chat_prompt_observations_retention')。

CREATE OR REPLACE FUNCTION ops.cleanup_chat_prompt_observations(
  p_keep interval DEFAULT interval '7 days',
  p_batch integer DEFAULT 1000,
  p_max_batches integer DEFAULT 20
) RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_cut CONSTANT timestamptz := now() - p_keep;
  v_batch CONSTANT integer := least(greatest(COALESCE(p_batch, 1000), 1), 10000);
  v_total bigint := 0;
  v_n bigint;
BEGIN
  IF p_keep IS NULL OR p_keep < interval '1 day' THEN
    RAISE EXCEPTION 'prompt retention must be at least 1 day' USING ERRCODE = '22023';
  END IF;
  FOR i IN 1 .. least(greatest(COALESCE(p_max_batches, 20), 1), 1000) LOOP
    DELETE FROM ops.chat_prompt_observations
    WHERE history_id IN (
      SELECT o.history_id FROM ops.chat_prompt_observations o
      WHERE o.created_at < v_cut
      ORDER BY o.created_at
      LIMIT v_batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
    EXIT WHEN v_n < v_batch;
  END LOOP;
  RETURN v_total;
END
$fn$;
REVOKE ALL ON FUNCTION ops.cleanup_chat_prompt_observations(interval, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION ops.cleanup_chat_prompt_observations(interval, integer, integer) IS
  '删超过保留期的 prompt 快照（按 created_at，分批），返回删除行数。生产 pg_cron chat_prompt_observations_retention 每小时调用。';
COMMENT ON TABLE ops.chat_prompt_observations IS
  '每个对话轮次 prompt 定稿时发给模型的 messages（O）。保留 7 天，pg_cron chat_prompt_observations_retention 每小时清理。产品请求路径不读。';

DO $cron$
BEGIN
  -- Nested IF: PL/pgSQL parses an expression as a whole, so cron.job must not appear where pg_cron is absent (TEST).
  IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chat_prompt_observations_retention') THEN
      PERFORM cron.schedule('chat_prompt_observations_retention', '17 * * * *',
        $job$SET statement_timeout = '60s'; SET lock_timeout = '1s'; SELECT ops.cleanup_chat_prompt_observations(interval '7 days', 1000, 20);$job$);
    END IF;
  END IF;
END
$cron$;

CREATE OR REPLACE PROCEDURE ops.p5b_copy_prompt_history_step()
LANGUAGE plpgsql AS $proc$
DECLARE
  v_deadline CONSTANT timestamptz := clock_timestamp() + interval '50 seconds';
  v_since CONSTANT timestamptz := now() - interval '7 days';
  v_todo uuid[];
  v_part uuid[];
  v_n integer;
  v_rows bigint;
  v_copied bigint := 0;
  v_seen integer := 0;
BEGIN
  SELECT COALESCE(array_agg(h.id ORDER BY h.created_at, h.id), '{}') INTO v_todo
  FROM experience.chat_history h
  WHERE h.created_at >= v_since
    AND h.history IS NOT NULL
    AND h.llm_billing_snapshot IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM ops.chat_prompt_observations o WHERE o.history_id = h.id);
  v_n := COALESCE(array_length(v_todo, 1), 0);

  WHILE v_seen < v_n AND clock_timestamp() < v_deadline LOOP
    v_part := v_todo[v_seen + 1 : v_seen + 200];
    INSERT INTO ops.chat_prompt_observations (history_id, messages_snapshot, created_at)
    SELECT h.id, h.history, h.created_at
    FROM experience.chat_history h
    WHERE h.id = ANY (v_part)
      AND h.history IS NOT NULL
      AND h.llm_billing_snapshot IS NOT NULL
    ON CONFLICT (history_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_copied := v_copied + v_rows;
    v_seen := v_seen + COALESCE(array_length(v_part, 1), 0);
    COMMIT;
  END LOOP;

  IF v_seen < v_n THEN
    RAISE EXCEPTION 'p5b: copied % prompt snapshots this run, % turns still to copy; rerun this file', v_copied, v_n - v_seen;
  END IF;
  RAISE NOTICE 'p5b: copied % prompt snapshots this run, copied all', v_copied;
END
$proc$;
REVOKE ALL ON PROCEDURE ops.p5b_copy_prompt_history_step() FROM PUBLIC, anon, authenticated, service_role;

CALL ops.p5b_copy_prompt_history_step();

DROP PROCEDURE ops.p5b_copy_prompt_history_step();
