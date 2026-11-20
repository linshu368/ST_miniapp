-- Domain: miniapp_analytics（Grafana 01 日汇总）/ ops（模型调用成本）——数据库重组阶段 6a-2c-3：看板日汇总改为"每轮总成本"口径。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-2c-3）。
--
-- 口径（用户 11-19）：每轮成本 = 首发 + 兜底全部上游调用成本之和，统一美元，不分供应商；确实拿不到的不算。
-- miniapp_analytics.llm_turn_costs 已按这个口径；refresh_grafana_core_day 还是旧口径：
--   先取扣费记录的 usage_cost_usd，没有再取 OpenRouter / Venice 其中一家的 max(cost)，不含 Surplus、不加兜底；
--   且按 ops.llm_calls.created_at 窗口取调用，而扩展迁移补建的行 created_at 是迁移时刻，会漏。
-- 本文件：
--   1. refresh_grafana_core_day 两处替换（守卫生产原文 md5，恰好一处，核对结果 md5；已是新版本跳过）：
--      day_calls 改为按当天轮次 id 关联、汇总该轮全部调用已确定的成本；还有调用在等成本补查的轮次，
--      当天先不算"已记录成本"（cost_usd 为空），定时刷新会在补查完成后补上。没有调用行的轮次仍用扣费记录的成本。
--   2. 一次性补标：成本补查任务只扫近 7 天、有发出时间的行。扩展迁移搬进来的窗口边缘行（有发出时间、已超 7 天）
--      永远不会被处理，视图却一直显示待补，按补查规则（超 7 天记 unavailable）补标，只动成本也为空的行。
--      没有发出时间的历史行（7–8 月旧明细照搬，本来就不算待补）不动，历史照搬不重算。
--   3. 重刷可刷新的 14 天日汇总（先等看板刷新锁，避免和定时任务撞车），整条曲线同一口径。
--
-- Verify: bash scripts/test-db-reorg-p6a2c3-core-daily.sh
-- Release: TEST -> Production（不需要后端发布）。

DO $core$
DECLARE
  v_fn regprocedure := 'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure;
  v_old_md5 constant text := 'aca128007b4aa43ab3e93dc4255bea47';
  v_new_md5 constant text := '98cab2eb3a011c1faeb93d7bed9d1341';
  v_md5 text;
  v_def text;
  v_old_calls constant text := $o1$  ), day_calls AS MATERIALIZED (
    -- 调用元数据在聊天记录之后写入；窗口两端各留余量。ops.llm_calls 成本统一为美元（数据库重组 6a-2c-1）。
    SELECT chat_history_id,
      max(cost_usd) FILTER (WHERE provider='openrouter') AS openrouter_cost_usd,
      max(cost_usd) FILTER (WHERE provider='venice') AS venice_cost_usd
    FROM ops.llm_calls
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
      AND provider IN ('openrouter','venice')
    GROUP BY chat_history_id
  ), facts AS MATERIALIZED (
$o1$;
  v_new_calls constant text := $n1$  ), day_calls AS MATERIALIZED (
    -- 每轮成本 = 首发 + 兜底全部上游调用（三家供应商，统一美元），与 miniapp_analytics.llm_turn_costs 同口径。
    -- 按当天轮次 id 关联（扩展迁移补建的行 created_at 不是轮次时间）；还有调用在等成本补查的轮次先不算已记录成本。
    SELECT l.chat_history_id,
      sum(COALESCE(l.cost_usd,0)) FILTER (WHERE l.cost_source IS NOT NULL) AS cost_usd,
      bool_or(l.cost_source IS NULL AND l.dispatched_at IS NOT NULL) AS cost_pending
    FROM ops.llm_calls l
    WHERE l.chat_history_id IN (SELECT id FROM day_history)
    GROUP BY l.chat_history_id
  ), facts AS MATERIALIZED (
$n1$;
  v_old_cost constant text := $o2$      COALESCE(c.usage_cost_usd,
        o.openrouter_cost_usd, o.venice_cost_usd) AS cost_usd
$o2$;
  v_new_cost constant text := $n2$      CASE WHEN o.cost_pending THEN NULL
        ELSE COALESCE(o.cost_usd, c.usage_cost_usd) END AS cost_usd
$n2$;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 = v_new_md5 THEN
    RAISE NOTICE 'p6a2c3k: refresh_grafana_core_day already uses per-turn total cost';
    RETURN;
  ELSIF v_md5 <> v_old_md5 THEN
    RAISE EXCEPTION 'p6a2c3k: refresh_grafana_core_day drifted (md5 %), refusing', v_md5;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  IF (length(v_def) - length(replace(v_def, v_old_calls, ''))) / length(v_old_calls) <> 1
     OR (length(v_def) - length(replace(v_def, v_old_cost, ''))) / length(v_old_cost) <> 1 THEN
    RAISE EXCEPTION 'p6a2c3k: anchors not found exactly once in refresh_grafana_core_day';
  END IF;
  EXECUTE replace(replace(v_def, v_old_calls, v_new_calls), v_old_cost, v_new_cost);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 <> v_new_md5 THEN
    RAISE EXCEPTION 'p6a2c3k: unexpected md5 % after patch', v_md5;
  END IF;
  RAISE NOTICE 'p6a2c3k: refresh_grafana_core_day now sums every call of the turn';
END
$core$;

DO $label$
DECLARE
  v_rows bigint;
BEGIN
  SET LOCAL lock_timeout = '5s';
  UPDATE ops.llm_calls SET cost_source = 'unavailable', updated_at = now()
  WHERE cost_source IS NULL AND cost_usd IS NULL
    AND dispatched_at IS NOT NULL AND dispatched_at < now() - interval '7 days';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'p6a2c3k: % calls outside the cost job window labelled unavailable', v_rows;
END
$label$;

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
    RAISE EXCEPTION 'p6a2c3k: only % of 14 days refreshed', v_done;
  END IF;
  RAISE NOTICE 'p6a2c3k: 14 days of grafana_core_daily refreshed with per-turn total cost';
END
$refresh$;
