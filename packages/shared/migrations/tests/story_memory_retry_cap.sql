-- 20261127_story_memory_retry_cap.sql 执行之后的断言（准备数据在 scripts/test-story-memory-migration.sh 里）。
DO $$
DECLARE
  f jsonb;
  stuck uuid := 'c0000000-0000-4000-8000-000000000001';
  waiting uuid := 'c0000000-0000-4000-8000-000000000002';
  busy uuid := 'c0000000-0000-4000-8000-000000000003';
  gone uuid := 'c0000000-0000-4000-8000-000000000004';
  healthy uuid := 'c0000000-0000-4000-8000-000000000005';
  v_next timestamptz;
BEGIN
  -- 失败中的任务被重新排到马上执行，失败记录清掉。
  IF (SELECT status || attempts || coalesce(last_error, '-') FROM experience.story_memory_jobs WHERE session_id = stuck) <> 'pending0-'
     OR (SELECT next_attempt_at FROM experience.story_memory_jobs WHERE session_id = stuck) > now() THEN
    RAISE EXCEPTION 'failed job not re-armed: %', (SELECT row_to_json(j) FROM experience.story_memory_jobs j WHERE session_id = stuck);
  END IF;
  IF (SELECT status || attempts || coalesce(last_error, '-') FROM experience.story_memory_jobs WHERE session_id = waiting) <> 'pending0-' THEN
    RAISE EXCEPTION 'pending job with a failure streak not re-armed';
  END IF;
  -- running 的行、已删除会话、没有失败记录的行都不动。
  IF (SELECT status || attempts || last_error FROM experience.story_memory_jobs WHERE session_id = busy) <> 'running3too_long' THEN
    RAISE EXCEPTION 'running job was touched';
  END IF;
  IF (SELECT status || attempts || last_error FROM experience.story_memory_jobs WHERE session_id = gone) <> 'failed7too_long' THEN
    RAISE EXCEPTION 'deleted session job was touched';
  END IF;
  IF (SELECT next_attempt_at FROM experience.story_memory_jobs WHERE session_id = healthy) <= now() + interval '9 minutes' THEN
    RAISE EXCEPTION 'healthy job was touched';
  END IF;

  -- 退避：2、4、8、16、32，之后封顶 60 分钟。
  FOR i IN 1..8 LOOP
    UPDATE experience.story_memory_jobs SET status = 'running', lease_owner = 'w-cap', lease_until = now() + interval '10 minutes'
    WHERE session_id = stuck;
    f := experience.finish_story_memory_job(stuck, 'w-cap', 'too_long', NULL, NULL);
    SELECT next_attempt_at INTO v_next FROM experience.story_memory_jobs WHERE session_id = stuck;
    IF v_next <> now() + make_interval(mins => (ARRAY[2, 4, 8, 16, 32, 60, 60, 60])[i]) THEN
      RAISE EXCEPTION 'failure % waits % (expected % min)', i, v_next - now(), (ARRAY[2, 4, 8, 16, 32, 60, 60, 60])[i];
    END IF;
  END LOOP;
  IF f->>'status' <> 'failed' OR (f->>'attempts')::int <> 8 THEN
    RAISE EXCEPTION 'failure streak semantics changed: %', f;
  END IF;

  -- attempts 很大时不再溢出 integer。
  UPDATE experience.story_memory_jobs SET status = 'running', lease_owner = 'w-cap', lease_until = now() + interval '10 minutes', attempts = 40
  WHERE session_id = stuck;
  f := experience.finish_story_memory_job(stuck, 'w-cap', 'too_long', NULL, NULL);
  IF (f->>'attempts')::int <> 41
     OR (SELECT next_attempt_at FROM experience.story_memory_jobs WHERE session_id = stuck) <> now() + interval '60 minutes' THEN
    RAISE EXCEPTION 'large attempts not capped: %', f;
  END IF;

  -- 成功仍然清零。
  UPDATE experience.story_memory_jobs SET status = 'running', lease_owner = 'w-cap', lease_until = now() + interval '10 minutes'
  WHERE session_id = stuck;
  f := experience.finish_story_memory_job(stuck, 'w-cap', NULL, NULL, NULL);
  IF (f->>'attempts')::int <> 0 OR (SELECT last_error FROM experience.story_memory_jobs WHERE session_id = stuck) IS NOT NULL THEN
    RAISE EXCEPTION 'success did not clear the streak: %', f;
  END IF;
END $$;
