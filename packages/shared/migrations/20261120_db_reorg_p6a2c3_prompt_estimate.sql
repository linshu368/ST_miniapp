-- Domain: ops（模型调用成本观测）——被取消的 OpenRouter 调用改按"输入 token × 模型输入单价"粗估，重算已有估算行。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-2c-3「被取消的 OpenRouter 调用怎么估」，用户 11-20 定）。
--
-- 旧规则按"近 7 天停下且查到真实成本的调用均价"估，被两个 30 万 token 的样本拉到每次 $0.024–0.031，
-- 收费聊天每轮成本里估算约占四成。新规则（后端 generation/call-cost-rules.ts 同口径）：
--   输入 token 取同一轮其他调用上报的值（优先同模型），单价取 OpenRouter 模型目录的输入单价；缺任一项记 unavailable。
-- 本文件只重算 cost_source = 'estimated' 的行（只观测、不进扣费）：
--   - 单价表是 11-20 从 OpenRouter 公开模型目录取的，覆盖现有估算行涉及的全部 10 个模型（按请求时的模型 ID）；
--   - 不在表里的模型保留原值（后端发布后新估算行已是新口径）；
--   - 然后在看板刷新锁下重刷 14 天日汇总。
-- 生产核对（11-20）：收费聊天估算 $46.25 → $11.23，畅聊 $17.08 → $10.98；370 次调用同轮没有输入 token，改记 unavailable。
--
-- Verify: bash scripts/test-db-reorg-p6a2c3-prompt-estimate.sh
-- Release: 后端发布（新口径）→ TEST → Production。

DO $reestimate$
DECLARE
  v_priced bigint;
  v_unpriced bigint;
BEGIN
  SET LOCAL lock_timeout = '5s';
  WITH price(model, usd_per_token) AS (VALUES
    ('deepseek/deepseek-v4.1-flash-1017', 0.00000015),
    ('deepseek/deepseek-v4.1-flash', 0.0000000507),
    ('deepseek/deepseek-v4-flash', 0.00000009),
    ('deepseek/deepseek-v4-flash-0731', 0.0000000456),
    ('deepseek/deepseek-v4-pro-0813', 0.00000132),
    ('google/gemini-3-flash-preview', 0.0000005),
    ('google/gemini-3.1-flash-lite', 0.00000025),
    ('google/gemini-3.1-flash-lite-preview', 0.00000025),
    ('google/gemini-4-hydrogen', 0.0000015),
    ('z-ai/glm-5.2', 0.00000062)
  ),
  calc AS (
    SELECT l.id,
      round(p.usd_per_token * (
        SELECT s.prompt_tokens FROM ops.llm_calls s
        WHERE s.chat_history_id = l.chat_history_id AND s.id <> l.id AND s.prompt_tokens IS NOT NULL
        ORDER BY (s.model = l.model) DESC, s.dispatched_at NULLS LAST, s.id
        LIMIT 1), 9) AS usd
    FROM ops.llm_calls l
    JOIN price p ON p.model = l.model
    WHERE l.cost_source = 'estimated'
  ),
  upd AS (
    UPDATE ops.llm_calls l
    SET cost_usd = CASE WHEN c.usd > 0 THEN c.usd END,
        cost_source = CASE WHEN c.usd > 0 THEN 'estimated' ELSE 'unavailable' END,
        updated_at = now()
    FROM calc c
    WHERE l.id = c.id
    RETURNING l.cost_source
  )
  SELECT count(*) FILTER (WHERE cost_source = 'estimated'), count(*) FILTER (WHERE cost_source = 'unavailable')
  INTO v_priced, v_unpriced
  FROM upd;
  RAISE NOTICE 'p6a2c3e: re-estimated calls (estimated %, now unavailable %)', v_priced, v_unpriced;
END
$reestimate$;

DO $refresh$
DECLARE
  v_today date := (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date;
  v_day date;
  v_done int := 0;
BEGIN
  SET LOCAL lock_timeout = '60s';
  -- 与定时刷新同一把锁；本事务先拿到，函数内的 try-lock 对同一会话总是成功
  PERFORM pg_advisory_xact_lock(20261026, 510);
  FOR v_day IN SELECT generate_series(v_today - 13, v_today, interval '1 day')::date LOOP
    IF miniapp_analytics.refresh_grafana_core_day(v_day) THEN
      v_done := v_done + 1;
    END IF;
  END LOOP;
  IF v_done <> 14 THEN
    RAISE EXCEPTION 'p6a2c3e: only % of 14 days refreshed', v_done;
  END IF;
  RAISE NOTICE 'p6a2c3e: 14 days of grafana_core_daily refreshed';
END
$refresh$;
