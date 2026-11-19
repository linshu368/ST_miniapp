-- domain: experience（会话长期记忆：任务重试）
--
-- 问题（11-19 23:30 前后）：某个会话的压缩一直失败时，用户每发一轮新消息，
-- advance_story_memory_window 都会把 attempts 清零、next_attempt_at 设为现在，
-- 失败任务永远走不到 failed，退避也不生效：活跃会话每一轮都立刻重试一次（每次最多 3 次模型调用），
-- 每次都刷一条错误日志和告警。两个卡住的会话 2.5 小时内跑了 50 多次失败任务。
--
-- 修法：只有上一轮成功（last_error IS NULL）时，新目标才把任务重新拉起并清零；
-- 已有失败记录的任务保留 attempts 和 next_attempt_at，按已有退避（2、4、8、16 分钟，之后继续翻倍）重试。
-- failed 状态收到更高目标时转 pending 但不清零 attempts：next_attempt_at 在最后一次失败时已经设成
-- 失败时间 + 退避，所以一个卡住的会话最多按退避间隔重试一次，不会被新消息催着连续重试。
-- 其余行为不变：同一目标重发不改任务；运行中收到更高目标，当前任务结束时自行接着跑。
--
-- 只重写 advance_story_memory_window 一个函数；签名、owner、授权不变（CREATE OR REPLACE 保留）。
-- 守卫：函数体 md5 必须是 20261110_story_memory.sql 里的原文（已是新版本则跳过），漂移则拒绝。
-- 原文 md5 由 20261110 文件中的函数体计算，上线前应在目标库核对 pg_proc.prosrc 的 md5 一致。
-- 不准备回滚迁移；问题用 forward-fix。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE oid = 'experience.advance_story_memory_window(uuid,integer,integer,integer)'::regprocedure;
  IF v_md5 = '998d73009e83cb0de87811a99c8284b2' THEN
    RAISE NOTICE 'story memory retry guard already applied, skipping';
    RETURN;
  END IF;
  IF v_md5 <> '3307a5722e6534666d49d429ae81032e' THEN
    RAISE EXCEPTION 'advance_story_memory_window drifted (md5 %), refusing', v_md5;
  END IF;

  CREATE OR REPLACE FUNCTION experience.advance_story_memory_window(
    p_session_id uuid, p_from_start integer, p_to_start integer, p_target_end integer
  ) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  SET lock_timeout = '2s' SET statement_timeout = '5s'
  AS $fn$
DECLARE
  v_updated integer;
BEGIN
  IF p_session_id IS NULL OR p_from_start IS NULL OR p_to_start IS NULL OR p_target_end IS NULL
     OR p_from_start < 1 OR p_to_start < p_from_start OR p_target_end < 0 THEN
    RAISE EXCEPTION 'invalid story memory window advance' USING ERRCODE = '22023';
  END IF;

  -- p_to_start = p_from_start only requests compression; the window stays put.
  IF p_to_start > p_from_start THEN
    -- CAS on the observed start: the window only moves forward, and a lost race
    -- simply means another request already advanced it.
    UPDATE experience.chat_sessions
    SET context_window_start_turn = p_to_start
    WHERE id = p_session_id AND deleted_at IS NULL AND context_window_start_turn = p_from_start;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN RETURN false; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM experience.chat_sessions WHERE id = p_session_id AND deleted_at IS NULL) THEN
    RETURN false;
  END IF;

  -- Only a higher target re-arms the job. Re-sending the same target while waiting
  -- must not reset the failure backoff, and a running job picks up a raised target
  -- when it finishes. A job with a failure streak (last_error set) keeps its attempts
  -- and next_attempt_at even for a higher target: otherwise every new user turn on a
  -- session whose compression keeps failing would retry immediately and never reach
  -- the backoff or the failed state. A failed job turns pending again but keeps
  -- attempts, so it is retried at most once per backoff interval.
  INSERT INTO experience.story_memory_jobs (session_id, status, attempts, target_end, next_attempt_at)
  VALUES (p_session_id, 'pending', 0, p_target_end, now())
  ON CONFLICT (session_id) DO UPDATE SET
    status = CASE
      WHEN story_memory_jobs.status = 'running' THEN 'running'
      WHEN EXCLUDED.target_end > story_memory_jobs.target_end THEN 'pending'
      ELSE story_memory_jobs.status END,
    attempts = CASE
      WHEN story_memory_jobs.status <> 'running' AND EXCLUDED.target_end > story_memory_jobs.target_end
        AND story_memory_jobs.last_error IS NULL
      THEN 0 ELSE story_memory_jobs.attempts END,
    next_attempt_at = CASE
      WHEN story_memory_jobs.status <> 'running' AND EXCLUDED.target_end > story_memory_jobs.target_end
        AND story_memory_jobs.last_error IS NULL
      THEN now() ELSE story_memory_jobs.next_attempt_at END,
    target_end = GREATEST(story_memory_jobs.target_end, EXCLUDED.target_end),
    updated_at = now();
  RETURN true;
END;
$fn$;
END
$guard$;

COMMIT;
