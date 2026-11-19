-- 数据库重组 6a-2b：生成结算回捞的候选只认"交付调用"的身份（只新增一个只读函数，不改表、不改既有函数）。
--
-- 之前回捞任务（backend features/generation/sync-job.ts）经 PostgREST 外键嵌入三张供应商明细表
-- （openrouter / venice / surplusintelligence_chat_history）判断"这一轮由谁交付、generation_id 是什么"。
-- 这份身份早已在 chat_generation_requests.delivery_attempt_id → chat_generation_attempts（provider, generation_id）
-- 里唯一确定；生产 11-19 近 7 天 47674 个有报价的轮次两种来源逐行一致，只差 21 个没被交付的 Surplus 落败调用
-- （新来源不再把落败调用的 generation_id 挂到这一轮上；这些轮次全部未成功、未扣费）。
-- 明细表从此只存用量元数据（O），6a-2c 迁 ops.llm_calls。
--
-- 扫描（与旧后端语义一致，每种各自最多 50 条，按 created_at 升序）：
--   openrouter / venice：已结束、交付调用属该供应商且有 generation_id；
--   surplus：已结束、报价冻结的供应商是 surplus（可以还没有交付身份，按快照补结算）；
--   missing_identity：交付调用没有 generation_id（含没有交付调用），且早于 p_identity_before（流式宽限期之后）。
-- 都要求有报价快照、未打结算完成。可重跑。

BEGIN;

CREATE OR REPLACE FUNCTION experience.list_chat_settlement_candidates(
  p_scan text,
  p_since timestamptz,
  p_limit integer,
  p_identity_before timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  model text,
  session_id uuid,
  llm_finish_reason text,
  llm_charge_id uuid,
  assistant_reply text,
  status text,
  llm_billing_snapshot jsonb,
  llm_billing_settled_at timestamptz,
  delivery_provider text,
  generation_id text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT h.id, h.user_id, h.model, h.session_id, h.llm_finish_reason, h.llm_charge_id, h.assistant_reply, h.status,
    h.llm_billing_snapshot, h.llm_billing_settled_at, a.provider, a.generation_id
  FROM experience.chat_history h
  LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
  LEFT JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id
  WHERE h.created_at >= p_since
    AND h.llm_billing_snapshot IS NOT NULL
    AND h.llm_billing_settled_at IS NULL
    AND CASE
      WHEN p_scan IN ('openrouter', 'venice') THEN
        h.status <> 'streaming' AND a.provider = p_scan AND a.generation_id IS NOT NULL
      WHEN p_scan = 'surplus' THEN
        h.status <> 'streaming' AND h.llm_billing_snapshot ->> 'provider' = 'surplus'
      WHEN p_scan = 'missing_identity' THEN
        a.generation_id IS NULL AND h.created_at < p_identity_before
      ELSE false
    END
  ORDER BY h.created_at, h.id
  LIMIT least(greatest(COALESCE(p_limit, 50), 1), 50)
$fn$;

COMMENT ON FUNCTION experience.list_chat_settlement_candidates(text, timestamptz, integer, timestamptz) IS
  '生成结算回捞候选（数据库重组 6a-2b）：身份只取交付调用（requests.delivery_attempt_id → attempts）。'
  '扫描 openrouter / venice / surplus / missing_identity，各自最多 50 条。只读；调用方 backend sync-job。';

REVOKE ALL ON FUNCTION experience.list_chat_settlement_candidates(text, timestamptz, integer, timestamptz) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION experience.list_chat_settlement_candidates(text, timestamptz, integer, timestamptz) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION experience.list_chat_settlement_candidates(text, timestamptz, integer, timestamptz) FROM authenticated';
  END IF;
END
$grants$;
GRANT EXECUTE ON FUNCTION experience.list_chat_settlement_candidates(text, timestamptz, integer, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
