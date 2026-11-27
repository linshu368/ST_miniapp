-- domain: experience（会话长期记忆：回退 2 个被错误精简的档案版本）
--
-- 背景：#1238 的超长兜底按位置取「第一个板块」精简。生产 prompt v2 的第一个板块是「一、亲密关系与进度」
-- （prompt 规定只能合并措辞、不得删除），主线在第七个。#1244 已改为按标题找主线板块（北京 15:49 部署）。
-- 在此之前，生产日志里有 2 次「只精简第一个板块」成功并提交（北京时间）：
--   3470594c-eb9d-4852-a529-47020866a937：15:42:29，亲密板块 3541 字 → 目标 732 字（任务从 15:41:38 开始）
--   d753f3d0-6534-4f81-a685-d585b0fa67f4：15:49:03，亲密板块 1656 字 → 目标 116 字（任务从 15:48:17 开始）
--
-- 修法：删掉这 2 个会话在出错任务开始之后提交的全部档案版本（出错版本，以及之后基于它并入的版本），
-- 回到之前最后一个正常版本；任务清零、马上重跑，由已修复的代码从正常版本重新并入这些章节
-- （章节从 chat_history 重读，不丢剧情）。档案是派生数据，删除的版本可以重新生成。
-- 窗口起点不动：重跑完成前，这 2 个会话会有几分钟用较早的档案。
-- running 的任务不改状态：它提交时按 covered_end 做 CAS，会因档案已回退而失败并按退避重跑。
-- 重跑是幂等的：已回退的会话再执行一次删 0 行。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $fix$
DECLARE
  r record;
  v_deleted integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('3470594c-eb9d-4852-a529-47020866a937'::uuid, '2026-11-27 07:41:38+00'::timestamptz),
      ('d753f3d0-6534-4f81-a685-d585b0fa67f4'::uuid, '2026-11-27 07:48:17+00'::timestamptz)
    ) AS t(session_id, since)
  LOOP
    PERFORM 1 FROM experience.story_memory_jobs WHERE session_id = r.session_id FOR UPDATE;
    DELETE FROM experience.story_memories
    WHERE session_id = r.session_id AND created_at >= r.since;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    UPDATE experience.story_memory_jobs
    SET status = 'pending', attempts = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
    WHERE session_id = r.session_id AND status <> 'running';
    RAISE NOTICE 'story memory session % rolled back % version(s)', r.session_id, v_deleted;
  END LOOP;
END
$fix$;

-- 收尾校验：这 2 个会话不再有出错任务开始之后的版本。
DO $post$
BEGIN
  IF EXISTS (
    SELECT 1 FROM experience.story_memories
    WHERE (session_id = '3470594c-eb9d-4852-a529-47020866a937' AND created_at >= '2026-11-27 07:41:38+00')
       OR (session_id = 'd753f3d0-6534-4f81-a685-d585b0fa67f4' AND created_at >= '2026-11-27 07:48:17+00')
  ) THEN
    RAISE EXCEPTION 'postflight: damaged story memory versions remain';
  END IF;
END
$post$;
COMMIT;
