-- 数据库重组：停掉每小时卡片位次快照任务并删表（用户 11-19 确认）。
-- miniapp_analytics.card_position_snapshot 只由 pg_cron 任务 card_position_hourly_snapshot（生产 jobid 5）写入，
-- 无视图 / 函数依赖、无代码读者（11-18、11-19 两次核对：pg_stat 只有 Studio 浏览；客服只读账号是整 schema 统一授权）。
-- TEST 没有 pg_cron，只删表。整个文件一个 DO 块：停任务与删表同进同退；重跑只打印已完成。
DO $drop_snapshot$
DECLARE
  v_jobs integer := 0;
BEGIN
  SET LOCAL lock_timeout = '5s';

  IF to_regclass('cron.job') IS NOT NULL THEN
    SELECT count(*) INTO v_jobs
    FROM cron.job
    WHERE jobname = 'card_position_hourly_snapshot' OR command ILIKE '%card_position_snapshot%';

    IF EXISTS (
      SELECT 1 FROM cron.job
      WHERE command ILIKE '%card_position_snapshot%' AND jobname IS DISTINCT FROM 'card_position_hourly_snapshot'
    ) THEN
      RAISE EXCEPTION 'card_position_snapshot: another cron job writes the table, refusing';
    END IF;

    PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
    WHERE j.jobname = 'card_position_hourly_snapshot';
  END IF;

  IF to_regclass('miniapp_analytics.card_position_snapshot') IS NULL THEN
    RAISE NOTICE 'card_position_snapshot: already dropped (cron jobs removed: %)', v_jobs;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.refobjid = 'miniapp_analytics.card_position_snapshot'::regclass
      AND d.classid = 'pg_rewrite'::regclass
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.prosrc ILIKE '%card_position_snapshot%'
  ) THEN
    RAISE EXCEPTION 'card_position_snapshot: a view or function still reads the table, refusing';
  END IF;

  DROP TABLE miniapp_analytics.card_position_snapshot;
  RAISE NOTICE 'card_position_snapshot: cron jobs removed %, table dropped', v_jobs;
END
$drop_snapshot$;
