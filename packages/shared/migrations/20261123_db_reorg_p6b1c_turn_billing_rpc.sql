-- Domain: billing（文本计费）——数据库重组阶段 6b-1c 写方切换（三）扩展：轮次计费的两个写入口。
-- 设计见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md「写方切换 PR③～⑤（收尾合并）」。
--
-- 后端结算现在直接 UPDATE experience.chat_history 的 4 个计费列（deduction_rate / llm_intended_deduction /
-- llm_billing_settled_at / llm_billing_snapshot），由镜像触发器同步到 billing.usage_charges。本文件新增两个函数，
-- 后端改为只调它们：
--   - billing.record_chat_turn_charge(轮次, 实扣, 应扣, 结算时间)：参数为 null 的字段不改；
--   - billing.save_chat_turn_quote(轮次, 报价快照)。
-- 这一版仍写轮次表的计费列（镜像照旧同步，行为与后端直接 UPDATE 完全相同），所以新旧后端可以同时在线。
-- 收缩迁移把两个函数原地改为直写 usage_charges，再删计费列和镜像。
--
-- Verify: bash scripts/test-db-reorg-p6b1c-turn-billing.sh
-- Release: TEST -> Production -> 后端发布。前后跑 R1 文本按日对账。
-- Rollback: DROP FUNCTION 两个函数（后端回滚到直接 UPDATE 的版本之后）。

CREATE OR REPLACE FUNCTION billing.record_chat_turn_charge(
  p_history_id uuid,
  p_charged_credits numeric,
  p_quoted_credits numeric,
  p_settled_at timestamptz
)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  -- db reorg 6b-1c 过渡版：与后端原来的 UPDATE 相同，镜像触发器同步 usage_charges；收缩时改为直写 usage_charges。
  UPDATE experience.chat_history SET
    deduction_rate = COALESCE(p_charged_credits, deduction_rate),
    llm_intended_deduction = COALESCE(p_quoted_credits, llm_intended_deduction),
    llm_billing_settled_at = COALESCE(p_settled_at, llm_billing_settled_at)
  WHERE id = p_history_id;
END
$fn$;

CREATE OR REPLACE FUNCTION billing.save_chat_turn_quote(p_history_id uuid, p_snapshot jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $fn$
BEGIN
  IF jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid billing snapshot' USING ERRCODE = '22023';
  END IF;
  -- db reorg 6b-1c 过渡版：与后端原来的 UPDATE 相同；收缩时改为写 usage_charges.quote.snapshot。
  UPDATE experience.chat_history SET llm_billing_snapshot = p_snapshot WHERE id = p_history_id;
END
$fn$;

COMMENT ON FUNCTION billing.record_chat_turn_charge(uuid, numeric, numeric, timestamptz) IS
  '文本轮次的计费结果（实扣、应扣、结算时间），null 参数不改。后端结算与补结算唯一写入口。';
COMMENT ON FUNCTION billing.save_chat_turn_quote(uuid, jsonb) IS
  '文本轮次扣费前落下冻结报价快照。后端结算唯一写入口。';

REVOKE ALL ON FUNCTION billing.record_chat_turn_charge(uuid, numeric, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION billing.save_chat_turn_quote(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION billing.record_chat_turn_charge(uuid, numeric, numeric, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION billing.save_chat_turn_quote(uuid, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
