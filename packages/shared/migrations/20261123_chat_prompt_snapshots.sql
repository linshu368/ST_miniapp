-- Domain: ops（每轮发给模型的 prompt 快照，开发与产品排查用，非业务数据）
-- 任务：.trellis/tasks/11-23-chat-prompt-snapshots/prd.md（用户 11-23：恢复保存，只留最近 7 天，完全异步、不影响耗时）。
--
-- 1. ops.chat_prompt_snapshots：每轮一行（history_id 软引用 experience.chat_history.id，不建外键），messages_snapshot 是发给模型的
--    messages 原样。产品请求路径、看板不读，开发与产品经 SQL 按轮次 id 查。
-- 2. experience.record_chat_prompt_snapshot(轮次, messages)：后端在开轮放行之后异步调用（不 await），同一轮重放时覆盖。
--    SECURITY DEFINER，只授 service_role（ops 不暴露给 PostgREST，沿用 record_llm_call_metadata 的写法）。
-- 3. ops.cleanup_chat_prompt_snapshots(保留期, 每批行数, 最多批数)：按 created_at 分批删超期快照。
--    生产 pg_cron chat_prompt_snapshots_retention 每天 20:17 UTC（北京 04:17）执行、保留 7 天；TEST 没有 pg_cron，只建函数。
-- 体积：近 7 天每天约 6500 轮、平均 prompt 约 4 万 token，稳定后约 5–6GB（用户已知并选择 7 天）。
--
-- Verify: bash scripts/test-chat-prompt-snapshots-migration.sh
-- Release: TEST -> Production -> 后端发布（后端调用前 RPC 必须已存在；先执行迁移再发布）。
-- Rollback: SELECT cron.unschedule('chat_prompt_snapshots_retention'); DROP FUNCTION experience.record_chat_prompt_snapshot(uuid, jsonb);
--   DROP FUNCTION ops.cleanup_chat_prompt_snapshots(interval, integer, integer); DROP TABLE ops.chat_prompt_snapshots;
--   （后端写入失败只记 warn，回滚顺序不限。）

CREATE TABLE IF NOT EXISTS ops.chat_prompt_snapshots (
  history_id uuid NOT NULL,
  messages_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_prompt_snapshots_pkey PRIMARY KEY (history_id),
  CONSTRAINT chat_prompt_snapshots_messages_snapshot_check CHECK (jsonb_typeof(messages_snapshot) = 'array')
);
CREATE INDEX IF NOT EXISTS chat_prompt_snapshots_created_at_idx ON ops.chat_prompt_snapshots (created_at);
ALTER TABLE ops.chat_prompt_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ops.chat_prompt_snapshots FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE ops.chat_prompt_snapshots IS
  '每轮发给模型的 messages（O，开发与产品排查用）。后端开轮放行后异步写入；保留 7 天，pg_cron chat_prompt_snapshots_retention 每天清理。产品请求路径不读。';
COMMENT ON COLUMN ops.chat_prompt_snapshots.history_id IS 'soft ref → experience.chat_history.id（ops 不建外键，按保留期删除）';

CREATE OR REPLACE FUNCTION experience.record_chat_prompt_snapshot(p_history_id uuid, p_messages jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF p_history_id IS NULL OR jsonb_typeof(p_messages) IS DISTINCT FROM 'array' OR jsonb_array_length(p_messages) = 0 THEN
    RAISE EXCEPTION 'Invalid prompt snapshot' USING ERRCODE = '22023';
  END IF;
  -- 同一轮重放（放行重试）时以最后一次为准。
  INSERT INTO ops.chat_prompt_snapshots (history_id, messages_snapshot)
  VALUES (p_history_id, p_messages)
  ON CONFLICT (history_id) DO UPDATE SET messages_snapshot = EXCLUDED.messages_snapshot, created_at = now();
END
$fn$;
REVOKE ALL ON FUNCTION experience.record_chat_prompt_snapshot(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION experience.record_chat_prompt_snapshot(uuid, jsonb) TO service_role;
COMMENT ON FUNCTION experience.record_chat_prompt_snapshot(uuid, jsonb) IS
  '后端开轮放行后异步写入本轮 prompt 快照（ops.chat_prompt_snapshots），非业务、失败不影响本轮。';

CREATE OR REPLACE FUNCTION ops.cleanup_chat_prompt_snapshots(
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
    RAISE EXCEPTION 'prompt snapshot retention must be at least 1 day' USING ERRCODE = '22023';
  END IF;
  FOR i IN 1 .. least(greatest(COALESCE(p_max_batches, 20), 1), 1000) LOOP
    DELETE FROM ops.chat_prompt_snapshots
    WHERE history_id IN (
      SELECT s.history_id FROM ops.chat_prompt_snapshots s
      WHERE s.created_at < v_cut
      ORDER BY s.created_at
      LIMIT v_batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
    EXIT WHEN v_n < v_batch;
  END LOOP;
  RETURN v_total;
END
$fn$;
REVOKE ALL ON FUNCTION ops.cleanup_chat_prompt_snapshots(interval, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION ops.cleanup_chat_prompt_snapshots(interval, integer, integer) IS
  '删超过保留期的 prompt 快照（按 created_at，分批），返回删除行数。生产 pg_cron chat_prompt_snapshots_retention 每天调用。';

DO $cron$
BEGIN
  -- 两层 IF：PL/pgSQL 解析整个条件，没装 pg_cron 的库（TEST）不能在同一条件里提到 cron.job。
  IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chat_prompt_snapshots_retention') THEN
      -- 每天约 6500 行（单行约百 KB，含 TOAST），每批 1000、最多 20 批足够；北京 04:17 低峰。
      PERFORM cron.schedule('chat_prompt_snapshots_retention', '17 20 * * *',
        $job$SET statement_timeout = '300s'; SET lock_timeout = '1s'; SELECT ops.cleanup_chat_prompt_snapshots(interval '7 days', 1000, 20);$job$);
    END IF;
  END IF;
END
$cron$;

NOTIFY pgrst, 'reload schema';
