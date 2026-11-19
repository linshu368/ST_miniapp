-- Domain: ops（上游模型调用）——数据库重组阶段 6a-2c-3 收缩（一）：删畅聊调用台账 miniapp_features.free_zone_calls。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-2c-3）。
--
-- 前提：后端发布（所有轮次的每次调用统一写 ops.llm_calls、通用成本补查）后，旧表已停止写入；
-- 并已用 force_rerun 重跑 20261119_db_reorg_p6a2c3_call_ledger_expand.sql 补搬窗口期增量。
-- 1. 守卫（锁外）：近 15 分钟旧表没有新行；旧表每一行在 ops.llm_calls 都有对应（原 id 的行，或并入的 attempt 行
--    ——按 chat_history_id + role + slot + lane=free_zone 对上）。
-- 2. 畅聊两个成本视图改为新视图 llm_call_costs / llm_turn_costs 里 lane = free_zone 的子集（列名不变，Grafana 无感），
--    授权照旧；删旧表。一个 DO 块。
--    差异（生产只读核对 11-19）：本文件不改每轮总成本（与扩展后的新视图一致；相对迁移前，扩展时已有 106 轮的
--    Surplus 调用改用响应金额，合计 +0.046 美元）；并入 attempt 行的 OpenRouter 调用，provider_model 由请求名
--    变为 OpenRouter 返回的带日期版本名（如 deepseek-v4-flash → deepseek-v4-flash-20260423，8508 条），按候选模型
--    （model_id）统计不受影响；结束原因 21476 条里 1 条不同。
--
-- Verify: bash scripts/test-db-reorg-p6a2c3-contract.sh
-- Release: 后端发布核对后 -> 重跑扩展（force_rerun）-> TEST -> Production。
-- Recovery: 旧表不可恢复（数据已在 ops.llm_calls，按 lane = free_zone 取）。

DO $guard$
DECLARE
  v_recent bigint;
  v_missing bigint;
BEGIN
  IF to_regclass('miniapp_features.free_zone_calls') IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_recent FROM miniapp_features.free_zone_calls WHERE created_at > now() - interval '15 minutes';
  IF v_recent > 0 THEN
    RAISE EXCEPTION 'p6a2c3c: free_zone_calls still receives rows (% in 15 minutes), refusing', v_recent;
  END IF;
  SELECT count(*) INTO v_missing
  FROM miniapp_features.free_zone_calls f
  WHERE NOT EXISTS (
    SELECT 1 FROM ops.llm_calls l
    WHERE l.chat_history_id = f.chat_history_id AND l.lane = 'free_zone' AND l.role = f.role AND l.slot = f.slot);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'p6a2c3c: % free-zone calls are not in ops.llm_calls, rerun the expand file first', v_missing;
  END IF;
END
$guard$;

DO $contract$
BEGIN
  SET LOCAL lock_timeout = '5s';
  DROP VIEW IF EXISTS miniapp_analytics.free_zone_turn_costs;
  DROP VIEW IF EXISTS miniapp_analytics.free_zone_call_costs;
  CREATE VIEW miniapp_analytics.free_zone_call_costs AS
  SELECT id, chat_history_id, model_id, role, slot, provider, provider_model, dispatched_at, end_reason, won,
         cost_source, cost_pending, cost_estimated, cost_usd, prompt_tokens, completion_tokens
    FROM miniapp_analytics.llm_call_costs
   WHERE lane = 'free_zone';
  COMMENT ON VIEW miniapp_analytics.free_zone_call_costs IS
    '畅聊每次上游调用（llm_call_costs 中 lane = free_zone 的子集，6a-2c-3 起）';
  CREATE VIEW miniapp_analytics.free_zone_turn_costs AS
  SELECT chat_history_id, model_id, turn_at, primary_calls, fallback_calls, primary_cost_usd, fallback_cost_usd,
         total_cost_usd, estimated_cost_usd, cost_pending
    FROM miniapp_analytics.llm_turn_costs
   WHERE lane = 'free_zone';
  COMMENT ON VIEW miniapp_analytics.free_zone_turn_costs IS
    '畅聊每轮总成本（llm_turn_costs 中 lane = free_zone 的子集，6a-2c-3 起）';
  REVOKE ALL ON miniapp_analytics.free_zone_call_costs, miniapp_analytics.free_zone_turn_costs
    FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON miniapp_analytics.free_zone_call_costs, miniapp_analytics.free_zone_turn_costs
    TO service_role, first_token_metrics_reader;
  DROP TABLE IF EXISTS miniapp_features.free_zone_calls;
  RAISE NOTICE 'p6a2c3c: free-zone views read ops.llm_calls, free_zone_calls dropped';
END
$contract$;
