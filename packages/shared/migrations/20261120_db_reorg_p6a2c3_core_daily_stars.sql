-- Domain: miniapp_analytics（Grafana 01 日汇总）——数据库重组阶段 6a-2c-3 补充：实扣星尘改取每轮扣费额，与钱包流水一致。
-- 计划见 .trellis/tasks/11-19-db-reorg-p6-billing/design.md（6a-2c-3）。
--
-- refresh_grafana_core_day 的实扣星尘 / 扣星尘请求原来取 billing.llm_usage_charges.charged_amount，
-- 但那张表每个用户只留最近 100 条（消费记录用），重度用户当天的记录在次日收盘刷新前就会被清掉：
-- 生产 11-07～11-20 缓存值普遍少算（11-19 缓存 24240，钱包流水 28892）；20261119_..._core_daily_cost 重刷 14 天后旧日子缺得更多。
-- 生产核对：每轮 experience.chat_history.deduction_rate 的日合计与钱包流水 chat_debit / llm_usage（按 llm_charge_id 关联）
-- 14 天逐日完全相等（11-07 13470 … 11-19 28892），且不会被清理。
-- 本文件：两处替换（守卫当前 md5 98cab2eb…，恰好一处，核对结果 md5；已是新版本跳过），再等看板刷新锁重刷 14 天。
-- 型号、成本的兜底仍读扣费记录（缺了就用聊天记录里的型号）。
--
-- Verify: bash scripts/test-db-reorg-p6a2c3-core-daily-stars.sh
-- Release: TEST -> Production（不需要后端发布）。

DO $stars$
DECLARE
  v_fn regprocedure := 'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure;
  v_old_md5 constant text := '98cab2eb3a011c1faeb93d7bed9d1341';
  v_new_md5 constant text := '11ea797699ac67b5a2f61162bc153075';
  v_md5 text;
  v_def text;
  v_old_cols constant text := $o1$    SELECT id,user_id,llm_charge_id,model,
$o1$;
  v_new_cols constant text := $n1$    SELECT id,user_id,llm_charge_id,model,deduction_rate,
$n1$;
  v_old_stars constant text := $o2$      CASE WHEN c.status IN ('charged','partial','reconciled','historical')
        THEN GREATEST(COALESCE(c.charged_amount,0),0) ELSE 0 END AS stars,
$o2$;
  v_new_stars constant text := $n2$      -- 实扣星尘取每轮扣费额（与钱包流水 chat_debit 逐日一致）；扣费记录每用户只留 100 条，不能作来源
      GREATEST(COALESCE(h.deduction_rate,0),0) AS stars,
$n2$;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 = v_new_md5 THEN
    RAISE NOTICE 'p6a2c3s2: refresh_grafana_core_day already reads deduction_rate';
    RETURN;
  ELSIF v_md5 <> v_old_md5 THEN
    RAISE EXCEPTION 'p6a2c3s2: refresh_grafana_core_day drifted (md5 %), refusing', v_md5;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  IF (length(v_def) - length(replace(v_def, v_old_cols, ''))) / length(v_old_cols) <> 1
     OR (length(v_def) - length(replace(v_def, v_old_stars, ''))) / length(v_old_stars) <> 1 THEN
    RAISE EXCEPTION 'p6a2c3s2: anchors not found exactly once in refresh_grafana_core_day';
  END IF;
  EXECUTE replace(replace(v_def, v_old_cols, v_new_cols), v_old_stars, v_new_stars);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_fn;
  IF v_md5 <> v_new_md5 THEN
    RAISE EXCEPTION 'p6a2c3s2: unexpected md5 % after patch', v_md5;
  END IF;
  RAISE NOTICE 'p6a2c3s2: refresh_grafana_core_day now reads stars from deduction_rate';
END
$stars$;

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
    RAISE EXCEPTION 'p6a2c3s2: only % of 14 days refreshed', v_done;
  END IF;
  RAISE NOTICE 'p6a2c3s2: 14 days of grafana_core_daily refreshed with stars from deduction_rate';
END
$refresh$;
