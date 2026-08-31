-- pg_cron job 5 · production（wbtsfzozlmurljvglhpn）
--
-- 099 的事务外收尾之一。执行时机：099 在生产提交之后，停流量窗口内。
-- 上游文档：docs/schema划分-一阶段执行计划.md §3.3、§五 批次 C
-- 实测基线：ops/schema-split/snapshots/2026-08-25/prod/sections/20_cron_jobs.txt
--
-- ============================ 为什么必须改 ============================
-- job 5 每小时整点把角色卡的位次快照写进 miniapp_analytics.card_position_snapshot，
-- 命令里硬编码了 FROM miniapp.characters。099 把 characters 迁到 app_core 之后，
-- 这条命令会在下一个整点开始报 relation "miniapp.characters" does not exist。
-- cron 命令是纯文本，不随 schema 搬迁跟随，也不在 099 的事务里。
--
-- ============================ 只改 job 5 ============================
-- job 2 / job 3 调用 public.compute_daily_metrics，两者 active = f，
-- 且命令文本里只有 miniapp_analytics.session_metrics_daily（该表在生产并不存在，
-- 2026-08-20 最后一次执行就已经 failed）。这条链路在迁移前就是坏的，
-- 按 Q4 的拍板本阶段不改行为、不清理，因此这两个 job **不动**。
-- job 1 已被删除，只剩运行历史。
--
-- ============================ 时间窗 ============================
-- job 5 的 schedule 是 '0 * * * *'。维护窗口应避开整点；本文件在 step 1 会先
-- 检查有没有正在运行的实例。若正好撞上，等它跑完再改，不要在它运行中改命令。
--
-- test 没有 pg_cron（批次A 差异 C3），这一步无法在 test 演练，
-- 只能在生产窗口内执行并靠 step 4 检查下一次实际执行结果。
--
-- ============================ 执行 ============================
--   psql "$PROD_DIRECT_URL" -X -v ON_ERROR_STOP=1 -f ops/schema-split/cron-job5-prod.sql
-- 连接串取自仓库根 .env.schema-split，不要写进命令行或 shell 历史。

\echo '=== step 0: 记录三个 job 的现状（贴进割接记录） ==='
SELECT jobid, schedule, active, command
FROM cron.job
ORDER BY jobid;

\echo '=== step 1: 确认此刻没有正在运行的 job 5 ==='
SELECT jobid, runid, status, start_time
FROM cron.job_run_details
WHERE jobid = 5 AND status = 'running';
-- 有行就等它结束再继续。

\echo '=== step 2: 断言命令文本与基线一致，然后只替换 schema 限定名 ==='

BEGIN;

DO $guard$
DECLARE
  v_cmd text;
  v_n   int;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobid = 5;

  IF v_cmd IS NULL THEN
    RAISE EXCEPTION 'cron job 5 不存在。先重新盘点 cron.job，再决定怎么改';
  END IF;

  -- 断言起点：必须还引用 miniapp.characters，且不含任何 app_core 字样
  IF v_cmd NOT LIKE '%miniapp.characters%' THEN
    RAISE EXCEPTION 'job 5 的命令没有引用 miniapp.characters，与基线不符：%', v_cmd;
  END IF;
  IF v_cmd LIKE '%app_core%' THEN
    RAISE EXCEPTION 'job 5 的命令已经引用 app_core，可能已经改过：%', v_cmd;
  END IF;

  -- 只允许命中一次，避免正则改写范围超出预期
  SELECT count(*) INTO v_n
  FROM regexp_matches(v_cmd, '\mminiapp\.characters\M', 'g');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'job 5 的命令里 miniapp.characters 出现 % 次（应为 1 次），请人工确认：%', v_n, v_cmd;
  END IF;
END
$guard$;

-- 只改限定名，schedule / active / 其余 SQL 一字不动。
-- 不用 cron.schedule()：它按 jobname 匹配，会新建/顶掉 job 并换掉 jobid。
-- 也不能直接 UPDATE cron.job：Supabase 上该表归 supabase_admin，postgres 只有 SELECT
-- （2026-08-28 生产实测 permission denied）。cron.alter_job 是 pg_cron 的 C 函数，
-- 直接操作 catalog、只校验「必须是 job 所有者」（job 5 的 username = postgres），
-- 按 job_id 原地更新，因此保留 jobid。NULL 参数表示该字段不改。
SELECT cron.alter_job(
  job_id  => 5,
  command => (SELECT regexp_replace(command, '\mminiapp\.characters\M', 'app_core.characters', 'g')
                FROM cron.job WHERE jobid = 5)
);

DO $verify$
DECLARE v_cmd text;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobid = 5;
  IF v_cmd LIKE '%miniapp.characters%' THEN
    RAISE EXCEPTION 'job 5 改写后仍引用 miniapp.characters：%', v_cmd;
  END IF;
  IF v_cmd NOT LIKE '%app_core.characters%' THEN
    RAISE EXCEPTION 'job 5 改写后没有引用 app_core.characters：%', v_cmd;
  END IF;
  -- miniapp_analytics.card_position_snapshot 是写入目标，不在本阶段搬迁范围，必须原样保留
  IF v_cmd NOT LIKE '%miniapp_analytics.card_position_snapshot%' THEN
    RAISE EXCEPTION 'job 5 的写入目标被改坏了：%', v_cmd;
  END IF;
  RAISE NOTICE 'job 5 改写完成：%', v_cmd;
END
$verify$;

COMMIT;

\echo '=== step 3: 复核改写结果 ==='
SELECT jobid, schedule, active, command
FROM cron.job
WHERE jobid = 5;

\echo '=== step 4: 下一个整点之后回来看这一次执行的结果（不要跳过） ==='
-- 期望 status = 'succeeded'；这是 cron 变更唯一的真实验证，test 上演练不了。
--
--   SELECT jobid, runid, status, return_message, start_time, end_time
--     FROM cron.job_run_details
--    WHERE jobid = 5
--    ORDER BY start_time DESC
--    LIMIT 3;
--
-- 顺带确认快照真的写进去了：
--
--   SELECT max(created_at) FROM miniapp_analytics.card_position_snapshot;

-- ===================================================================
-- 回滚（配合 packages/shared/migrations/099_schema_split_phase1_rollback.sql）
-- ===================================================================
-- characters 搬回 miniapp 之后，这条命令必须一起退回去，否则下一个整点报
-- relation "app_core.characters" does not exist。顺序：先跑回滚迁移，再执行下面这段。
--
--   BEGIN;
--   SELECT cron.alter_job(
--     job_id  => 5,
--     command => (SELECT regexp_replace(command, '\mapp_core\.characters\M', 'miniapp.characters', 'g')
--                   FROM cron.job WHERE jobid = 5)
--   );
--   -- 复核：应回到 FROM miniapp.characters，且写入目标仍是 miniapp_analytics.card_position_snapshot
--   SELECT jobid, command FROM cron.job WHERE jobid = 5;
--   COMMIT;
--
-- 同样要在下一个整点之后查 cron.job_run_details 确认 succeeded。
