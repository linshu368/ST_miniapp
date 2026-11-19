-- 数据库重组 6a-2c-1（收缩）：OpenRouter / Venice 明细表退役（后端发布、旧读写停涨之后执行）。
--
-- 第一段（一个事务）：
--   - select_chat_generation_delivery 不再往两张明细表插身份行（交付身份只认 attempts，6a-2b 起回捞也只读它）；
--     OpenRouter / Venice 分支整体去掉，Surplus 分支不变，未知供应商照旧报 22023。按原文定位替换，已改过则跳过。
--   - miniapp_analytics.refresh_grafana_core_day 的成本改读 ops.llm_calls（每轮 OpenRouter 优先、其次 Venice，美元）。
--   提交后等 5 秒，让还在用旧函数体的交付调用跑完，再进入第二段。
-- 第二段（一个事务，最后才拿锁）：
--   - 补复制扩展之后两张明细表里新增或更新的行（只补空值，不覆盖新后端写进 ops 的值）；
--   - 自检：14 天前到 36 小时前的轮次（发布前后都不会再被回捞改动），按旧算法（明细表）与新算法（ops）算出的每轮
--     成本必须逐轮相同；
--   - 删两张明细表（删表会因外键短暂锁 chat_history，所以放在最后）；没有函数再引用它们。
-- 可重跑：函数已改、表已删时相应步骤跳过。

BEGIN;
SELECT set_config('lock_timeout', '5s', true);
SELECT set_config('statement_timeout', '120s', true);

DO $phase1$
DECLARE
  v_delivery regprocedure := 'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure;
  v_refresh regprocedure := 'miniapp_analytics.refresh_grafana_core_day(date)'::regprocedure;
  v_def text;
  v_pairs text[][];
  v_i int;
  v_hits int;
BEGIN
  -- ── select_chat_generation_delivery ──
  v_pairs := ARRAY[
    ARRAY[$o1$  IF a.provider='openrouter' THEN
    IF EXISTS(SELECT 1 FROM experience.venice_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;
    SELECT llm_generation_id INTO v_existing FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id;
    IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM COALESCE(p_generation_id,a.generation_id) THEN RAISE EXCEPTION 'Provider identity conflict'; END IF;
    INSERT INTO experience.openrouter_chat_history(chat_history_id,llm_generation_id)
    VALUES(p_history_id,COALESCE(p_generation_id,a.generation_id)) ON CONFLICT(chat_history_id)
    DO UPDATE SET llm_generation_id=COALESCE(experience.openrouter_chat_history.llm_generation_id,EXCLUDED.llm_generation_id);
  ELSIF a.provider='surplus' THEN
$o1$, $n1$  -- db reorg 6a-2c-1: the delivered attempt is the only call identity; OpenRouter / Venice
  -- metadata lives in ops.llm_calls, written by experience.record_llm_call_metadata.
  IF a.provider='surplus' THEN
$n1$],
    ARRAY[$o2$  ELSIF a.provider='venice' THEN
    IF EXISTS(SELECT 1 FROM experience.openrouter_chat_history WHERE chat_history_id=p_history_id) THEN RAISE EXCEPTION 'Conflicting provider metadata'; END IF;
    SELECT llm_generation_id INTO v_existing FROM experience.venice_chat_history WHERE chat_history_id=p_history_id;
    IF v_existing IS NOT NULL AND v_existing IS DISTINCT FROM COALESCE(p_generation_id,a.generation_id) THEN RAISE EXCEPTION 'Provider identity conflict'; END IF;
    INSERT INTO experience.venice_chat_history(chat_history_id,llm_generation_id)
    VALUES(p_history_id,COALESCE(p_generation_id,a.generation_id)) ON CONFLICT(chat_history_id)
    DO UPDATE SET llm_generation_id=COALESCE(experience.venice_chat_history.llm_generation_id,EXCLUDED.llm_generation_id);
  ELSE
    RAISE EXCEPTION 'Unknown delivery provider' USING ERRCODE='22023';
$o2$, $n2$  ELSIF a.provider NOT IN ('openrouter','venice') THEN
    RAISE EXCEPTION 'Unknown delivery provider' USING ERRCODE='22023';
$n2$],
    ARRAY[$o3$ a experience.chat_generation_attempts%ROWTYPE; v_existing text;
$o3$, $n3$ a experience.chat_generation_attempts%ROWTYPE;
$n3$]];
  v_def := pg_get_functiondef(v_delivery);
  v_hits := 0;
  FOR v_i IN 1 .. array_length(v_pairs, 1) LOOP
    IF position(v_pairs[v_i][1] IN v_def) > 0 THEN
      IF cardinality(string_to_array(v_def, v_pairs[v_i][1])) <> 2 THEN
        RAISE EXCEPTION 'p6a2c1c: delivery anchor % must match exactly once', v_i;
      END IF;
      v_hits := v_hits + 1;
    END IF;
  END LOOP;
  IF v_hits = array_length(v_pairs, 1) THEN
    FOR v_i IN 1 .. array_length(v_pairs, 1) LOOP
      v_def := replace(v_def, v_pairs[v_i][1], v_pairs[v_i][2]);
    END LOOP;
    EXECUTE v_def;
    RAISE NOTICE 'p6a2c1c: select_chat_generation_delivery no longer writes provider detail tables';
  ELSIF v_hits = 0 AND v_def !~ '(openrouter|venice)_chat_history' THEN
    RAISE NOTICE 'p6a2c1c: select_chat_generation_delivery already patched';
  ELSE
    RAISE EXCEPTION 'p6a2c1c: select_chat_generation_delivery drifted (% of % anchors found)', v_hits, array_length(v_pairs, 1);
  END IF;

  -- ── refresh_grafana_core_day ──
  v_pairs := ARRAY[
    ARRAY[$r1$  ), day_openrouter AS MATERIALIZED (
    -- 明细行在聊天记录之后写入；窗口两端各留余量，按 created_at 索引取一段再哈希配对。
    SELECT chat_history_id,usage FROM experience.openrouter_chat_history
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
  ), day_venice AS MATERIALIZED (
    SELECT chat_history_id,llm_usage FROM experience.venice_chat_history
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
  ), facts AS MATERIALIZED ($r1$, $s1$  ), day_calls AS MATERIALIZED (
    -- 调用元数据在聊天记录之后写入；窗口两端各留余量。ops.llm_calls 成本统一为美元（数据库重组 6a-2c-1）。
    SELECT chat_history_id,
      max(cost_usd) FILTER (WHERE provider='openrouter') AS openrouter_cost_usd,
      max(cost_usd) FILTER (WHERE provider='venice') AS venice_cost_usd
    FROM ops.llm_calls
    WHERE created_at>=v_start-interval '5 minutes' AND created_at<v_end+interval '1 hour'
      AND provider IN ('openrouter','venice')
    GROUP BY chat_history_id
  ), facts AS MATERIALIZED ($s1$],
    ARRAY[$r2$        CASE WHEN jsonb_typeof(o.usage)='number' THEN (o.usage#>>'{}')::numeric END,
        CASE WHEN jsonb_typeof(v.llm_usage)='number' THEN (v.llm_usage#>>'{}')::numeric/1000000 END) AS cost_usd$r2$,
          $s2$        o.openrouter_cost_usd, o.venice_cost_usd) AS cost_usd$s2$],
    ARRAY[$r3$    LEFT JOIN day_openrouter o ON o.chat_history_id=h.id
    LEFT JOIN day_venice v ON v.chat_history_id=h.id$r3$, $s3$    LEFT JOIN day_calls o ON o.chat_history_id=h.id$s3$]];
  v_def := pg_get_functiondef(v_refresh);
  v_hits := 0;
  FOR v_i IN 1 .. array_length(v_pairs, 1) LOOP
    IF position(v_pairs[v_i][1] IN v_def) > 0 THEN
      IF cardinality(string_to_array(v_def, v_pairs[v_i][1])) <> 2 THEN
        RAISE EXCEPTION 'p6a2c1c: refresh anchor % must match exactly once', v_i;
      END IF;
      v_hits := v_hits + 1;
    END IF;
  END LOOP;
  IF v_hits = array_length(v_pairs, 1) THEN
    FOR v_i IN 1 .. array_length(v_pairs, 1) LOOP
      v_def := replace(v_def, v_pairs[v_i][1], v_pairs[v_i][2]);
    END LOOP;
    EXECUTE v_def;
    RAISE NOTICE 'p6a2c1c: refresh_grafana_core_day reads ops.llm_calls';
  ELSIF v_hits = 0 AND v_def !~ '(openrouter|venice)_chat_history' AND v_def ~ 'ops\.llm_calls' THEN
    RAISE NOTICE 'p6a2c1c: refresh_grafana_core_day already patched';
  ELSE
    RAISE EXCEPTION 'p6a2c1c: refresh_grafana_core_day drifted (% of % anchors found)', v_hits, array_length(v_pairs, 1);
  END IF;
END
$phase1$;
COMMIT;

-- Let deliveries that started on the old function body finish before the tables go away.
SELECT pg_sleep(5);

BEGIN;
SELECT set_config('lock_timeout', '5s', true);
SELECT set_config('statement_timeout', '300s', true);

DO $phase2$
DECLARE
  v_since timestamptz := '2026-11-19 00:40:00+00';  -- before the expand copy started (TEST 00:50Z, production 00:51Z)
  v_or_new bigint := 0;
  v_ve_new bigint := 0;
  v_diff bigint;
  v_turns bigint;
  v_bad text;
BEGIN
  IF to_regclass('experience.openrouter_chat_history') IS NULL AND to_regclass('experience.venice_chat_history') IS NULL THEN
    RAISE NOTICE 'p6a2c1c: provider detail tables already dropped';
    RETURN;
  END IF;

  -- ── delta copy (rows written or updated after the expand copy; fill empty values only) ──
  WITH src AS (
    SELECT COALESCE(a.id, o.id) AS id, a.id AS attempt_id, o.chat_history_id,
      COALESCE(o.llm_generation_id, a.generation_id) AS generation_id, o.provider_name, o.model, o.finish_reason,
      CASE WHEN o.native_tokens_prompt >= 0 THEN o.native_tokens_prompt END AS prompt_tokens,
      CASE WHEN o.native_tokens_completion >= 0 THEN o.native_tokens_completion END AS completion_tokens,
      CASE WHEN o.native_tokens_cached >= 0 THEN o.native_tokens_cached END AS cached_tokens,
      CASE WHEN o.native_tokens_reasoning >= 0 THEN o.native_tokens_reasoning END AS reasoning_tokens,
      CASE WHEN jsonb_typeof(o.usage) = 'number' AND (o.usage #>> '{}')::numeric >= 0 THEN (o.usage #>> '{}')::numeric END AS cost_usd,
      CASE WHEN jsonb_typeof(o.usage_cache) = 'number' AND (o.usage_cache #>> '{}')::numeric >= 0 THEN (o.usage_cache #>> '{}')::numeric END AS cache_cost_usd,
      CASE WHEN jsonb_typeof(o.usage) = 'number' THEN 'openrouter_usage' END AS cost_source,
      CASE WHEN o.latency >= 0 THEN o.latency END AS latency_ms,
      CASE WHEN o.generation_time >= 0 THEN o.generation_time END AS generation_time_ms,
      CASE WHEN jsonb_typeof(o.llm_generation_data) IN ('object', 'array') THEN o.llm_generation_data END AS raw_usage,
      o.created_at, o.updated_at
    FROM experience.openrouter_chat_history o
    LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = o.chat_history_id
    LEFT JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id AND a.provider = 'openrouter'
      AND (o.llm_generation_id IS NULL OR a.generation_id = o.llm_generation_id)
    WHERE o.updated_at >= v_since OR o.created_at >= v_since
  ), upserted AS (
    INSERT INTO ops.llm_calls AS l (id, attempt_id, chat_history_id, provider, generation_id, provider_name, model,
      finish_reason, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost_usd, cache_cost_usd, cost_source,
      latency_ms, generation_time_ms, raw_usage, created_at, updated_at)
    SELECT id, attempt_id, chat_history_id, 'openrouter', generation_id, provider_name, model, finish_reason, prompt_tokens,
      completion_tokens, cached_tokens, reasoning_tokens, cost_usd, cache_cost_usd, cost_source, latency_ms,
      generation_time_ms, raw_usage, created_at, updated_at FROM src
    ON CONFLICT (id) DO UPDATE SET
      generation_id = COALESCE(l.generation_id, EXCLUDED.generation_id),
      provider_name = COALESCE(l.provider_name, EXCLUDED.provider_name), model = COALESCE(l.model, EXCLUDED.model),
      finish_reason = COALESCE(l.finish_reason, EXCLUDED.finish_reason),
      prompt_tokens = COALESCE(l.prompt_tokens, EXCLUDED.prompt_tokens),
      completion_tokens = COALESCE(l.completion_tokens, EXCLUDED.completion_tokens),
      cached_tokens = COALESCE(l.cached_tokens, EXCLUDED.cached_tokens),
      reasoning_tokens = COALESCE(l.reasoning_tokens, EXCLUDED.reasoning_tokens),
      cost_usd = COALESCE(l.cost_usd, EXCLUDED.cost_usd), cache_cost_usd = COALESCE(l.cache_cost_usd, EXCLUDED.cache_cost_usd),
      cost_source = COALESCE(l.cost_source, EXCLUDED.cost_source), latency_ms = COALESCE(l.latency_ms, EXCLUDED.latency_ms),
      generation_time_ms = COALESCE(l.generation_time_ms, EXCLUDED.generation_time_ms),
      raw_usage = COALESCE(l.raw_usage, EXCLUDED.raw_usage)
    RETURNING 1
  ) SELECT count(*) INTO v_or_new FROM upserted;

  WITH src AS (
    SELECT COALESCE(a.id, v.id) AS id, a.id AS attempt_id, v.chat_history_id,
      COALESCE(v.llm_generation_id, a.generation_id) AS generation_id, v.llm_provider_name AS provider_name,
      v.llm_model AS model, v.llm_finish_reason AS finish_reason,
      CASE WHEN v.llm_native_tokens_prompt >= 0 THEN v.llm_native_tokens_prompt END AS prompt_tokens,
      CASE WHEN v.llm_native_tokens_completion >= 0 THEN v.llm_native_tokens_completion END AS completion_tokens,
      CASE WHEN v.llm_native_tokens_cached >= 0 THEN v.llm_native_tokens_cached END AS cached_tokens,
      CASE WHEN v.llm_native_tokens_reasoning >= 0 THEN v.llm_native_tokens_reasoning END AS reasoning_tokens,
      CASE WHEN jsonb_typeof(v.llm_usage) = 'number' AND (v.llm_usage #>> '{}')::numeric >= 0 THEN (v.llm_usage #>> '{}')::numeric / 1000000 END AS cost_usd,
      CASE WHEN jsonb_typeof(v.llm_usage_cache) = 'number' AND (v.llm_usage_cache #>> '{}')::numeric >= 0 THEN (v.llm_usage_cache #>> '{}')::numeric / 1000000 END AS cache_cost_usd,
      CASE WHEN jsonb_typeof(v.llm_usage) = 'number' THEN 'venice_usage' END AS cost_source,
      CASE WHEN v.llm_latency >= 0 THEN v.llm_latency END AS latency_ms,
      CASE WHEN v.llm_generation_time >= 0 THEN v.llm_generation_time END AS generation_time_ms,
      CASE WHEN jsonb_typeof(v.llm_generation_data) IN ('object', 'array') THEN v.llm_generation_data END AS raw_usage,
      v.created_at, v.updated_at
    FROM experience.venice_chat_history v
    LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = v.chat_history_id
    LEFT JOIN experience.chat_generation_attempts a ON a.id = r.delivery_attempt_id AND a.provider = 'venice'
      AND (v.llm_generation_id IS NULL OR a.generation_id = v.llm_generation_id)
    WHERE v.updated_at >= v_since OR v.created_at >= v_since
  ), upserted AS (
    INSERT INTO ops.llm_calls AS l (id, attempt_id, chat_history_id, provider, generation_id, provider_name, model,
      finish_reason, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost_usd, cache_cost_usd, cost_source,
      latency_ms, generation_time_ms, raw_usage, created_at, updated_at)
    SELECT id, attempt_id, chat_history_id, 'venice', generation_id, provider_name, model, finish_reason, prompt_tokens,
      completion_tokens, cached_tokens, reasoning_tokens, cost_usd, cache_cost_usd, cost_source, latency_ms,
      generation_time_ms, raw_usage, created_at, updated_at FROM src
    ON CONFLICT (id) DO UPDATE SET
      generation_id = COALESCE(l.generation_id, EXCLUDED.generation_id),
      provider_name = COALESCE(l.provider_name, EXCLUDED.provider_name), model = COALESCE(l.model, EXCLUDED.model),
      finish_reason = COALESCE(l.finish_reason, EXCLUDED.finish_reason),
      prompt_tokens = COALESCE(l.prompt_tokens, EXCLUDED.prompt_tokens),
      completion_tokens = COALESCE(l.completion_tokens, EXCLUDED.completion_tokens),
      cached_tokens = COALESCE(l.cached_tokens, EXCLUDED.cached_tokens),
      reasoning_tokens = COALESCE(l.reasoning_tokens, EXCLUDED.reasoning_tokens),
      cost_usd = COALESCE(l.cost_usd, EXCLUDED.cost_usd), cache_cost_usd = COALESCE(l.cache_cost_usd, EXCLUDED.cache_cost_usd),
      cost_source = COALESCE(l.cost_source, EXCLUDED.cost_source), latency_ms = COALESCE(l.latency_ms, EXCLUDED.latency_ms),
      generation_time_ms = COALESCE(l.generation_time_ms, EXCLUDED.generation_time_ms),
      raw_usage = COALESCE(l.raw_usage, EXCLUDED.raw_usage)
    RETURNING 1
  ) SELECT count(*) INTO v_ve_new FROM upserted;

  -- ── self-check: per-turn recorded cost, old (detail tables) vs new (ops), over settled history ──
  WITH turns AS (
    SELECT h.id, h.created_at FROM experience.chat_history h
    WHERE h.created_at >= now() - interval '14 days' AND h.created_at < now() - interval '36 hours'
  ), old_cost AS (
    SELECT t.id, COALESCE(
      CASE WHEN jsonb_typeof(o.usage) = 'number' THEN (o.usage #>> '{}')::numeric END,
      CASE WHEN jsonb_typeof(v.llm_usage) = 'number' THEN (v.llm_usage #>> '{}')::numeric / 1000000 END) AS cost
    FROM turns t
    LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id = t.id
    LEFT JOIN experience.venice_chat_history v ON v.chat_history_id = t.id
  ), new_cost AS (
    SELECT t.id, COALESCE(max(l.cost_usd) FILTER (WHERE l.provider = 'openrouter'),
      max(l.cost_usd) FILTER (WHERE l.provider = 'venice')) AS cost
    FROM turns t LEFT JOIN ops.llm_calls l ON l.chat_history_id = t.id AND l.provider IN ('openrouter', 'venice')
    GROUP BY t.id
  )
  SELECT count(*) FILTER (WHERE o.cost IS DISTINCT FROM n.cost AND NOT (o.cost < 0 AND n.cost IS NULL)), count(*)
    INTO v_diff, v_turns
  FROM old_cost o JOIN new_cost n USING (id);
  IF v_diff > 0 THEN
    RAISE EXCEPTION 'p6a2c1c: % of % settled turns would report a different cost from ops.llm_calls', v_diff, v_turns;
  END IF;

  -- ── drop (briefly locks chat_history through the parent foreign keys) ──
  DROP TABLE IF EXISTS experience.openrouter_chat_history, experience.venice_chat_history;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ '(openrouter|venice)_chat_history';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'p6a2c1c: functions still reference the dropped detail tables: %', v_bad;
  END IF;
  RAISE NOTICE 'p6a2c1c: delta copied openrouter % / venice %, % settled turns cost-identical, detail tables dropped',
    v_or_new, v_ve_new, v_turns;
END
$phase2$;

NOTIFY pgrst, 'reload schema';
COMMIT;
