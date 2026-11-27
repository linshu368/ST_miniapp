-- domain: experience（会话长期记忆：回退 1 个被程序删了条目的档案版本）
--
-- 背景：#1244（北京 15:49–16:22 在线）的超长兜底在模型精简失败后，会由程序删掉主线里最早的剧情条目。
-- 用户随后定了「不删条目，早期剧情只合并简化」（#1247，16:22 上线，已去掉删条目）。
-- 在此之前，会话 fab618c5-435f-4438-8f99-e41e9bca946b 在北京 16:11:19 被删了 6 条最早的剧情条目
-- （档案 9699 → 6974 字，伏笔、承诺、·用户 条目没删；这次任务从 16:08:38 开始）。
--
-- 修法同 20261127_story_memory_rollback_wrong_section.sql：删掉这次任务开始之后提交的全部档案版本，
-- 回到之前的正常版本；任务清零、马上重跑，由当前代码（超长时逐板块轻压、不删条目）重新并入。
-- 档案是派生数据，章节从 chat_history 重读，不丢剧情。幂等。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $fix$
DECLARE
  v_session uuid := 'fab618c5-435f-4438-8f99-e41e9bca946b';
  v_since timestamptz := '2026-11-27 08:08:30+00';
  v_deleted integer;
BEGIN
  PERFORM 1 FROM experience.story_memory_jobs WHERE session_id = v_session FOR UPDATE;
  DELETE FROM experience.story_memories WHERE session_id = v_session AND created_at >= v_since;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  UPDATE experience.story_memory_jobs
  SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
  WHERE session_id = v_session AND status <> 'running';
  RAISE NOTICE 'story memory session % rolled back % version(s)', v_session, v_deleted;
END
$fix$;

DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM experience.story_memories
    WHERE session_id = 'fab618c5-435f-4438-8f99-e41e9bca946b' AND created_at >= '2026-11-27 08:08:30+00'
  ) THEN
    RAISE EXCEPTION 'postflight: trimmed story memory version remains';
  END IF;
END
$post$;
COMMIT;
