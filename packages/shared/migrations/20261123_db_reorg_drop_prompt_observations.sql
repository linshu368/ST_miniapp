-- Domain: ops（工程观测）——删除每轮 prompt 快照 ops.chat_prompt_observations（收缩）。
--
-- 用户 11-23 决定删除：生产 5.7GB（几乎全在 TOAST），只有开轮函数写、每小时清理任务删，没有任何读者——
-- 后端代码、视图、看板、记忆栏 / 状态栏 / 长期记忆的更新都不读它（它们读 experience.session_chat_history）。
--
-- 一个事务：
--   1. experience.begin_chat_generation_observation 只去掉写快照的 IF 块（原文必须恰好出现一次，其余逐字不变；
--      传入的 messages 仍用来派生展示元数据 experience.chat_history_display_metadata）；
--   2. 删每小时清理任务 chat_prompt_observations_retention（没装 pg_cron 的库跳过）；
--   3. 删 ops.cleanup_chat_prompt_observations 与 ops.chat_prompt_observations（不带 CASCADE：还有别的依赖就整体回滚）。
-- 已执行过（表不在、函数不再提它）就跳过。表上的排他锁 lock_timeout 1 秒，拿不到锁整体回滚、原样重跑。
--
-- Verify: bash scripts/test-db-reorg-drop-prompt-observations.sh
-- Release: TEST -> Production。不需要后端发布：后端只调开轮 RPC，不读这张表。
-- Rollback: 表、授权按 20261119_db_reorg_p5_chat_history_expand.sql 重建；函数按
--   fixtures/drop_prompt_observations_begin_original.sql（生产原文，md5 7b94cf83）重建；清理函数与定时任务按
--   20261119_db_reorg_p5b_prompt_retention.sql 重建。已删除的快照不可恢复。

DO $drop_prompt$
DECLARE
  c_fn constant text := 'experience.begin_chat_generation_observation(uuid,jsonb)';
  c_block constant text := $block$      -- chat_prompt_observation_v1: the frozen prompt is an ops observation, never product state.
      IF p_input ? 'snapshot' THEN
        INSERT INTO ops.chat_prompt_observations(history_id,messages_snapshot) VALUES(p_history_id,v_history)
        ON CONFLICT(history_id) DO UPDATE SET messages_snapshot=excluded.messages_snapshot;
      END IF;
$block$;
  v_fn regprocedure;
  v_def text;
  v_new text;
  v_hits int;
  v_list text;
  v_jobs int := 0;
BEGIN
  SET LOCAL lock_timeout = '1s';

  v_fn := to_regprocedure(c_fn);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'drop-prompt-observations: % is missing', c_fn;
  END IF;
  v_def := pg_get_functiondef(v_fn);

  -- 0. 已执行过
  IF to_regclass('ops.chat_prompt_observations') IS NULL AND position('chat_prompt_observations' IN v_def) = 0 THEN
    RAISE NOTICE 'drop-prompt-observations: already dropped; nothing to do';
    RETURN;
  END IF;

  -- 1. 前置检查：锚点恰好一处；除开轮函数和清理函数外没有别的函数提这张表
  v_hits := (length(v_def) - length(replace(v_def, c_block, ''))) / length(c_block);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'drop-prompt-observations: expected the snapshot block exactly once in %, found %', c_fn, v_hits;
  END IF;
  v_new := replace(v_def, c_block, '');
  IF position('chat_prompt_observations' IN v_new) > 0 THEN
    RAISE EXCEPTION 'drop-prompt-observations: % still names the table outside the snapshot block', c_fn;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_list
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND p.prosrc ~ 'chat_prompt_observations'
    AND p.oid <> v_fn
    AND p.oid IS DISTINCT FROM to_regprocedure('ops.cleanup_chat_prompt_observations(interval,integer,integer)');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'drop-prompt-observations: other functions still use the table: %', v_list;
  END IF;

  -- 2. 开轮函数停写（CREATE OR REPLACE 保留所有者、权限与注释）
  EXECUTE v_new;
  IF pg_get_functiondef(v_fn) IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'drop-prompt-observations: rewritten % differs from the intended definition', c_fn;
  END IF;

  -- 3. 清理任务。两层 IF：PL/pgSQL 整体解析条件，没装 pg_cron 时同一条件里的 cron.job 会直接报错
  IF to_regclass('cron.job') IS NOT NULL THEN
    SELECT count(cron.unschedule(j.jobid)) INTO v_jobs FROM cron.job j WHERE j.jobname = 'chat_prompt_observations_retention';
    IF EXISTS (SELECT 1 FROM cron.job WHERE command ~ 'chat_prompt_observations') THEN
      RAISE EXCEPTION 'drop-prompt-observations: another cron job still names the table';
    END IF;
  END IF;

  -- 4. 删清理函数与表
  DROP FUNCTION IF EXISTS ops.cleanup_chat_prompt_observations(interval, integer, integer);
  DROP TABLE IF EXISTS ops.chat_prompt_observations;

  RAISE NOTICE 'drop-prompt-observations: rewrote %, unscheduled % cron job(s), dropped cleanup function and table',
    c_fn, v_jobs;
END
$drop_prompt$;
