-- domain: experience（会话长期记忆：任务退避封顶 + 重新排队卡住的任务）
--
-- 背景（2026-11-27 生产日志，约 22 小时）：
--   档案写满 8000 字后，模型并入新章节必然超长、精简又几乎原样返回，压缩任务每次重试都失败（too_long）。
--   退避按 2·2^(n-1) 分钟无上限翻倍，失败 8 次后两次重试相隔约 4 小时；被强制截断的章节一直补不进档案。
--   同一发布里后端改成「只精简第一个板块 → 仍超就删最早条目」，并换到 Surplus。
--
-- 本迁移两件事：
--   1. finish_story_memory_job 的退避封顶 60 分钟（2、4、8、16、32、60、60…）。
--      其余行为不变：成功清零；连续 5 次后 failed；failed 收到更高目标转 pending 但保留 attempts 与退避（20261120 守卫）。
--      顺带修掉潜在溢出：attempts 到 31 以上时 power 结果超出 integer、收尾会报错。
--   2. 把当前失败中的任务（pending / failed 且 last_error 不为空、会话未删除）重新排到马上执行：
--      attempts 清零、last_error 清空、next_attempt_at = now()。running 的行不动。
--      只能在新后端部署成功之后执行；先于部署执行也无害，只是旧代码会再失败一次，按新封顶退避。
--
-- 守卫：finish_story_memory_job 函数体 md5 必须是 20261110 原文（a0a861f9fdcbd857daca832c51aadfe9）；已是本版本（cef89781bbb0a29e8efd48a8c496845d）则跳过替换。
-- 回滚：不准备回滚迁移；退避上限要改回，用 forward-fix 再替换一次函数体。重新排队是一次性数据修正，无需回滚
--      （最坏情况是多跑一轮压缩）。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5
  FROM pg_proc
  WHERE oid = 'experience.finish_story_memory_job(uuid,text,text,integer,integer)'::regprocedure;
  IF v_md5 = 'cef89781bbb0a29e8efd48a8c496845d' THEN
    RAISE NOTICE 'story memory backoff cap already applied, skipping function replacement';
    RETURN;
  END IF;
  IF v_md5 <> 'a0a861f9fdcbd857daca832c51aadfe9' THEN
    RAISE EXCEPTION 'finish_story_memory_job drifted (md5 %), refusing', v_md5;
  END IF;
  CREATE OR REPLACE FUNCTION experience.finish_story_memory_job(
  p_session_id uuid, p_worker text, p_error_code text,
  p_range_start integer DEFAULT NULL, p_range_end integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
SET lock_timeout = '2s' SET statement_timeout = '5s'
AS $fn$
DECLARE
  v_job experience.story_memory_jobs%ROWTYPE;
  v_deleted boolean;
  v_covered integer;
  v_status text;
  v_attempts integer;
BEGIN
  IF p_session_id IS NULL OR p_worker IS NULL THEN
    RAISE EXCEPTION 'invalid story memory finish' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM experience.story_memory_jobs WHERE session_id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'running' OR v_job.lease_owner IS DISTINCT FROM p_worker THEN
    RETURN jsonb_build_object('status', 'lease_lost', 'attempts', COALESCE(v_job.attempts, 0));
  END IF;

  SELECT deleted_at IS NOT NULL INTO v_deleted
  FROM experience.chat_sessions WHERE id = p_session_id;
  SELECT covered_end_turn INTO v_covered FROM experience.story_memories
  WHERE session_id = p_session_id ORDER BY version DESC LIMIT 1;

  IF p_error_code IS NULL THEN
    v_attempts := 0;
    -- The target may have been raised while this job ran; keep going without waiting.
    v_status := CASE WHEN NOT v_deleted AND COALESCE(v_covered, 0) < v_job.target_end
      THEN 'pending' ELSE 'idle' END;
    UPDATE experience.story_memory_jobs
    SET status = v_status, attempts = 0, next_attempt_at = now(), last_error = NULL,
        lease_owner = NULL, lease_until = NULL,
        range_start = COALESCE(p_range_start, range_start), range_end = COALESCE(p_range_end, range_end),
        updated_at = now()
    WHERE session_id = p_session_id;
  ELSE
    v_attempts := v_job.attempts + 1;
    v_status := CASE WHEN v_deleted THEN 'idle' WHEN v_attempts >= 5 THEN 'failed' ELSE 'pending' END;
    UPDATE experience.story_memory_jobs
    SET status = v_status, attempts = v_attempts,
        -- 2、4、8、16、32 分钟，之后封顶 60 分钟：失败原因修好后，卡住的会话最多一小时内恢复。
        -- power 的指数先截到 6，attempts 再大也不会溢出 integer。
        next_attempt_at = now() + make_interval(mins => LEAST(60, 2 * power(2, LEAST(v_attempts, 6) - 1))::integer),
        last_error = left(p_error_code, 200), lease_owner = NULL, lease_until = NULL,
        range_start = COALESCE(p_range_start, range_start), range_end = COALESCE(p_range_end, range_end),
        updated_at = now()
    WHERE session_id = p_session_id;
  END IF;
  RETURN jsonb_build_object('status', v_status, 'attempts', v_attempts);
END;
$fn$;
END
$guard$;

DO $rearm$
DECLARE
  v_count integer;
BEGIN
  UPDATE experience.story_memory_jobs j
  SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
  FROM experience.chat_sessions s
  WHERE s.id = j.session_id
    AND s.deleted_at IS NULL
    AND j.status IN ('pending', 'failed')
    AND j.last_error IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'story memory jobs re-armed: %', v_count;
END
$rearm$;

-- 收尾校验：函数已是封顶版本；本事务开始前就有的失败记录都已重新排队（running 的除外）。
DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'experience.finish_story_memory_job(uuid,text,text,integer,integer)'::regprocedure)
     <> 'cef89781bbb0a29e8efd48a8c496845d' THEN
    RAISE EXCEPTION 'postflight: finish_story_memory_job is not the capped version';
  END IF;
  IF EXISTS (
    SELECT 1 FROM experience.story_memory_jobs j
    JOIN experience.chat_sessions s ON s.id = j.session_id
    WHERE s.deleted_at IS NULL AND j.status IN ('pending', 'failed') AND j.last_error IS NOT NULL
      -- worker 在本事务执行期间新记下的失败（updated_at 晚于本事务开始）不算漏改
      AND j.updated_at < now()
  ) THEN
    RAISE EXCEPTION 'postflight: failed story memory jobs remain';
  END IF;
END
$post$;
COMMIT;
