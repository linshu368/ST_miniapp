-- Synthetic-only PG17 fixture using the catalog definitions sampled on 2026-10-20.
-- No production rows, credentials, or connection details. Never run against a remote database.
CREATE ROLE grafana_reader NOLOGIN;
CREATE ROLE grafana_cloud NOLOGIN;
CREATE SCHEMA analytics_grafana;
GRANT USAGE ON SCHEMA analytics_grafana TO grafana_reader,grafana_cloud;
CREATE SCHEMA app_core;
CREATE TABLE app_core.users(id uuid PRIMARY KEY,miniapp_entered_at timestamptz);
CREATE TABLE app_core.characters(id uuid PRIMARY KEY,name text);
CREATE TABLE billing.wallet_ledger(reference_id text,amount numeric,main_delta numeric,bonus_delta numeric,reference_type text,entry_type text);
CREATE TABLE billing.payment_orders(user_id uuid,status text,paid_at timestamptz);
ALTER TABLE billing.character_free_chat_quota_decisions ADD COLUMN created_at timestamptz DEFAULT now(),
 ADD COLUMN quota_limit integer DEFAULT 40, ADD COLUMN user_id uuid,ADD COLUMN character_id uuid,
 ADD COLUMN granted_free boolean DEFAULT false;
INSERT INTO app_core.users(id,miniapp_entered_at) VALUES('00000000-0000-0000-0000-000000000099',now());
INSERT INTO app_core.characters(id,name) VALUES('00000000-0000-0000-0000-000000000080','synthetic card');
UPDATE experience.chat_history SET character_id='00000000-0000-0000-0000-000000000080';
CREATE VIEW analytics_grafana.v_llm_calls AS  WITH ledger_by_charge AS (
         SELECT wl.reference_id,
            GREATEST(- sum(wl.amount), 0::numeric) AS stars_total,
            GREATEST(- sum(wl.main_delta), 0::numeric) AS stars_main,
            GREATEST(- sum(wl.bonus_delta), 0::numeric) AS stars_bonus
           FROM billing.wallet_ledger wl
          WHERE wl.reference_type = 'llm_usage'::text AND wl.entry_type = 'chat_debit'::text
          GROUP BY wl.reference_id
        ), first_paid AS (
         SELECT po.user_id,
            min(po.paid_at) AS first_paid_at
           FROM billing.payment_orders po
          WHERE po.status = 'completed'::text AND po.paid_at IS NOT NULL
          GROUP BY po.user_id
        ), enriched AS (
         SELECT ch.created_at AS event_time,
            (ch.created_at AT TIME ZONE 'Asia/Shanghai'::text)::date AS metric_date,
            (date_trunc('hour'::text, (ch.created_at AT TIME ZONE 'Asia/Shanghai'::text)) AT TIME ZONE 'Asia/Shanghai'::text) AS bucket_hour,
            COALESCE(NULLIF(ch.llm_billing_snapshot ->> 'model_display_name'::text, ''::text), NULLIF(v.llm_model, ''::text), NULLIF(ch.llm_model, ''::text), NULLIF(ch.model, ''::text), NULLIF(o.llm_model, ''::text), 'unknown'::text) AS model_name,
            COALESCE(NULLIF(v.llm_model, ''::text), NULLIF(ch.llm_model, ''::text), NULLIF(ch.model, ''::text), NULLIF(o.llm_model, ''::text), 'unknown'::text) AS upstream_model,
                CASE
                    WHEN v.chat_history_id IS NOT NULL THEN 'venice'::text
                    WHEN o.chat_history_id IS NOT NULL OR ch.llm_provider_name IS NOT NULL OR ch.llm_usage IS NOT NULL OR ch.llm_generation_id IS NOT NULL OR ch.llm_latency IS NOT NULL OR ch.llm_native_tokens_prompt IS NOT NULL OR ch.llm_native_tokens_completion IS NOT NULL THEN 'openrouter'::text
                    ELSE 'unknown'::text
                END AS platform,
            COALESCE(NULLIF(v.llm_provider_name, ''::text), NULLIF(ch.llm_provider_name, ''::text), NULLIF(o.provider_name, ''::text), NULLIF(o.llm_provider_name, ''::text),
                CASE
                    WHEN v.chat_history_id IS NOT NULL THEN 'venice'::text
                    ELSE NULL::text
                END, 'unknown'::text) AS provider_name,
            COALESCE(v.llm_finish_reason, ch.llm_finish_reason, o.llm_finish_reason) AS finish_reason,
            COALESCE(ch.status, 'unknown'::text) AS status,
            ch.upstream_status,
                CASE
                    WHEN v.chat_history_id IS NOT NULL AND jsonb_typeof(v.llm_usage) = 'number'::text THEN ((v.llm_usage #>> '{}'::text[])::numeric) / 1000000.0
                    WHEN v.chat_history_id IS NULL AND jsonb_typeof(ch.llm_usage) = 'number'::text THEN (ch.llm_usage #>> '{}'::text[])::numeric
                    WHEN v.chat_history_id IS NULL AND jsonb_typeof(o.llm_usage) = 'number'::text THEN (o.llm_usage #>> '{}'::text[])::numeric
                    ELSE NULL::numeric
                END AS llm_cost_usd,
            COALESCE(v.llm_latency, ch.llm_latency, o.llm_latency) AS latency_ms,
            COALESCE(v.llm_generation_time, ch.llm_generation_time, o.llm_generation_time) AS generation_time_ms,
            COALESCE(v.llm_native_tokens_prompt, ch.llm_native_tokens_prompt, o.llm_native_tokens_prompt, 0) AS prompt_tokens,
            COALESCE(v.llm_native_tokens_completion, ch.llm_native_tokens_completion, o.llm_native_tokens_completion, 0) AS completion_tokens,
            COALESCE(v.llm_native_tokens_reasoning, ch.llm_native_tokens_reasoning, o.llm_native_tokens_reasoning, 0) AS reasoning_tokens,
            COALESCE(v.llm_native_tokens_cached, ch.llm_native_tokens_cached, o.llm_native_tokens_cached, 0) AS cached_tokens,
            COALESCE(l.stars_total, 0::numeric) AS stars_total,
            COALESCE(l.stars_main, 0::numeric) AS stars_main,
            COALESCE(l.stars_bonus, 0::numeric) AS stars_bonus,
            COALESCE(ch.llm_intended_deduction, 0::numeric) AS intended_stars,
            COALESCE(ch.llm_billing_snapshot ->> 'model_tier'::text, 'unknown'::text) AS model_tier,
            COALESCE(ch.llm_billing_snapshot ->> 'fixed_deduction_category'::text, 'unknown'::text) AS deduction_category,
                CASE
                    WHEN ch.llm_billing_snapshot ? 'vip_active'::text THEN COALESCE((ch.llm_billing_snapshot ->> 'vip_active'::text)::boolean, false)
                    ELSE NULL::boolean
                END AS vip_active,
                CASE
                    WHEN fp.first_paid_at IS NULL THEN 'never_paid'::text
                    WHEN fp.first_paid_at <= ch.created_at THEN 'paid_before_call'::text
                    ELSE 'future_payer'::text
                END AS payer_segment,
                CASE
                    WHEN u.miniapp_entered_at IS NULL THEN 'unknown'::text
                    WHEN (u.miniapp_entered_at AT TIME ZONE 'Asia/Shanghai'::text)::date = (ch.created_at AT TIME ZONE 'Asia/Shanghai'::text)::date THEN 'new'::text
                    ELSE 'existing'::text
                END AS lifecycle_segment
           FROM experience.chat_history ch
             LEFT JOIN experience.venice_chat_history v ON v.chat_history_id = ch.id
             LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id = ch.id
             LEFT JOIN ledger_by_charge l ON l.reference_id = ch.llm_charge_id::text
             LEFT JOIN first_paid fp ON fp.user_id = ch.user_id
             LEFT JOIN app_core.users u ON u.id = ch.user_id
        )
 SELECT event_time,
    metric_date,
    bucket_hour,
    model_name AS model,
    model_name,
    upstream_model,
    platform,
    provider_name AS supplier,
    provider_name,
    model_tier,
    deduction_category,
        CASE
            WHEN vip_active IS TRUE THEN 'vip'::text
            WHEN vip_active IS FALSE THEN 'non_vip'::text
            ELSE 'unknown'::text
        END AS vip_state,
    status,
    finish_reason,
    upstream_status,
    status <> 'insufficient_balance'::text AND status <> 'streaming'::text AS is_model_attempt,
    status <> 'insufficient_balance'::text AND status <> 'streaming'::text AS actual_upstream_call,
    status = 'success'::text AS is_success,
    status = 'success'::text AND (lower(finish_reason) = ANY (ARRAY['stop'::text, 'end_turn'::text, 'complete'::text, 'completed'::text])) AS is_clean_success,
    status = 'success'::text AND (lower(finish_reason) = ANY (ARRAY['stop'::text, 'end_turn'::text, 'complete'::text, 'completed'::text])) AS clean_success,
    COALESCE(lower(finish_reason), ''::text) = ANY (ARRAY['length'::text, 'max_tokens'::text, 'max_output_tokens'::text]) AS is_truncated,
    COALESCE(lower(finish_reason), ''::text) = ANY (ARRAY['content_filter'::text, 'safety'::text, 'blocked'::text, 'moderation'::text]) AS is_filtered,
    status = 'stream_interrupted'::text OR (COALESCE(lower(finish_reason), ''::text) = ANY (ARRAY['cancelled'::text, 'timeout'::text, 'error'::text])) AS is_interrupted,
    status = 'upstream_error'::text AS is_upstream_error,
    status = 'insufficient_balance'::text AS is_balance_rejected,
    stars_total > 0::numeric AS is_charged,
    stars_total > 0::numeric AS charged,
    status <> 'insufficient_balance'::text AND status <> 'streaming'::text AND stars_total = 0::numeric AS free_upstream_call,
    llm_cost_usd IS NOT NULL AS has_cost_record,
    llm_cost_usd IS NOT NULL AS cost_reported,
    llm_cost_usd,
    llm_cost_usd AS real_cost_usd,
    llm_cost_usd * 7.0 AS llm_cost_cny,
    llm_cost_usd * 7.0 AS real_cost_cny,
    latency_ms,
    generation_time_ms,
    prompt_tokens,
    completion_tokens,
    reasoning_tokens,
    cached_tokens,
    (prompt_tokens + completion_tokens)::bigint AS total_tokens,
    intended_stars,
    stars_total,
    stars_main,
    stars_main AS main_stars,
    stars_bonus,
    stars_bonus AS bonus_stars,
    stars_total / 115.0 AS wallet_value_proxy_cny,
    payer_segment,
    lifecycle_segment
   FROM enriched;
GRANT SELECT ON analytics_grafana.v_llm_calls TO grafana_reader;
COMMENT ON VIEW analytics_grafana.v_llm_calls IS 'De-identified raw LLM generations. OpenRouter cost is USD; Venice child cost is micro-USD divided by 1,000,000.';
COMMENT ON COLUMN analytics_grafana.v_llm_calls.actual_upstream_call IS 'Terminal model-request attempt proxy: excludes insufficient_balance and still-streaming rows; does not prove a supplier received the request.';
COMMENT ON COLUMN analytics_grafana.v_llm_calls.total_tokens IS 'Observed total tokens = prompt + completion. Reasoning tokens are a subset of completion and are not added again.';
CREATE MATERIALIZED VIEW analytics_grafana.mv_free_quota_daily AS  WITH paid_users AS (
         SELECT DISTINCT payment_orders.user_id
           FROM billing.payment_orders
          WHERE payment_orders.status = 'completed'::text AND payment_orders.paid_at IS NOT NULL
        ), enriched AS (
         SELECT (d.created_at AT TIME ZONE 'Asia/Shanghai'::text)::date AS metric_date,
            d.quota_limit,
                CASE
                    WHEN p.user_id IS NULL THEN 'free_only'::text
                    ELSE 'paid'::text
                END AS user_type,
            d.status,
            d.user_id,
            d.character_id,
            ch.id IS NOT NULL AS matched_chat,
                CASE
                    WHEN v.chat_history_id IS NOT NULL AND jsonb_typeof(v.llm_usage) = 'number'::text THEN ((v.llm_usage #>> '{}'::text[])::numeric) * 7.0 / 1000000.0
                    WHEN v.chat_history_id IS NULL AND jsonb_typeof(ch.llm_usage) = 'number'::text THEN ((ch.llm_usage #>> '{}'::text[])::numeric) * 7.0
                    WHEN v.chat_history_id IS NULL AND jsonb_typeof(o.llm_usage) = 'number'::text THEN ((o.llm_usage #>> '{}'::text[])::numeric) * 7.0
                    ELSE NULL::numeric
                END AS cost_cny
           FROM billing.character_free_chat_quota_decisions d
             LEFT JOIN paid_users p ON p.user_id = d.user_id
             LEFT JOIN experience.chat_history ch ON ch.llm_charge_id = d.charge_key
             LEFT JOIN experience.venice_chat_history v ON v.chat_history_id = ch.id
             LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id = ch.id
          WHERE d.granted_free AND d.created_at >= (now() - '45 days'::interval)
        )
 SELECT metric_date,
    quota_limit,
    user_type,
    status,
    count(*) AS decision_rows,
    count(DISTINCT user_id) AS users,
    count(DISTINCT character_id) AS characters,
    count(*) FILTER (WHERE matched_chat) AS matched_chat_rows,
    count(*) FILTER (WHERE cost_cny IS NOT NULL) AS cost_recorded_rows,
    COALESCE(sum(cost_cny), 0::numeric) AS cost_cny
   FROM enriched
  GROUP BY metric_date, quota_limit, user_type, status;
CREATE MATERIALIZED VIEW analytics_grafana.mv_card_unit_economics_30d AS  WITH ledger_by_charge AS (
         SELECT wallet_ledger.reference_id,
            GREATEST(- sum(wallet_ledger.amount), 0::numeric) AS stars_total,
            GREATEST(- sum(wallet_ledger.main_delta), 0::numeric) AS stars_main,
            GREATEST(- sum(wallet_ledger.bonus_delta), 0::numeric) AS stars_bonus
           FROM billing.wallet_ledger
          WHERE wallet_ledger.reference_type = 'llm_usage'::text AND wallet_ledger.entry_type = 'chat_debit'::text
          GROUP BY wallet_ledger.reference_id
        ), paid_users AS (
         SELECT DISTINCT payment_orders.user_id
           FROM billing.payment_orders
          WHERE payment_orders.status = 'completed'::text AND payment_orders.paid_at IS NOT NULL
        ), base AS (
         SELECT ch.user_id,
                CASE
                    WHEN p.user_id IS NULL THEN 'free_only'::text
                    ELSE 'paid'::text
                END AS user_type,
            (COALESCE(NULLIF(c.name, ''::text), '[deleted/unknown]'::text) || ' · '::text) || substr(md5(ch.character_id::text), 1, 6) AS character_label,
            ch.status <> 'insufficient_balance'::text AND ch.status <> 'streaming'::text AS actual_upstream_call,
            ch.status = 'success'::text AND (lower(COALESCE(v.llm_finish_reason, ch.llm_finish_reason, o.llm_finish_reason)) = ANY (ARRAY['stop'::text, 'end_turn'::text, 'complete'::text, 'completed'::text])) AS is_clean_success,
            COALESCE(l.stars_total, 0::numeric) AS stars_total,
            COALESCE(l.stars_main, 0::numeric) AS stars_main,
            COALESCE(l.stars_bonus, 0::numeric) AS stars_bonus,
                CASE
                    WHEN v.chat_history_id IS NOT NULL AND jsonb_typeof(v.llm_usage) = 'number'::text THEN ((v.llm_usage #>> '{}'::text[])::numeric) * 7.0 / 1000000.0
                    WHEN v.chat_history_id IS NULL AND jsonb_typeof(ch.llm_usage) = 'number'::text THEN ((ch.llm_usage #>> '{}'::text[])::numeric) * 7.0
                    WHEN v.chat_history_id IS NULL AND jsonb_typeof(o.llm_usage) = 'number'::text THEN ((o.llm_usage #>> '{}'::text[])::numeric) * 7.0
                    ELSE NULL::numeric
                END AS cost_cny
           FROM experience.chat_history ch
             LEFT JOIN experience.venice_chat_history v ON v.chat_history_id = ch.id
             LEFT JOIN experience.openrouter_chat_history o ON o.chat_history_id = ch.id
             LEFT JOIN ledger_by_charge l ON l.reference_id = ch.llm_charge_id::text
             LEFT JOIN paid_users p ON p.user_id = ch.user_id
             LEFT JOIN app_core.characters c ON c.id = ch.character_id
          WHERE ch.created_at >= (now() - '30 days'::interval) AND ch.character_id IS NOT NULL
        )
 SELECT character_label,
    count(*) FILTER (WHERE actual_upstream_call) AS calls,
    count(DISTINCT user_id) FILTER (WHERE actual_upstream_call) AS active_users,
    count(DISTINCT user_id) FILTER (WHERE actual_upstream_call AND user_type = 'paid'::text) AS paid_users,
    count(DISTINCT user_id) FILTER (WHERE actual_upstream_call AND user_type = 'free_only'::text) AS free_only_users,
    count(*) FILTER (WHERE actual_upstream_call AND is_clean_success) AS clean_success_calls,
    count(*) FILTER (WHERE actual_upstream_call AND stars_total = 0::numeric) AS free_calls,
    count(*) FILTER (WHERE actual_upstream_call AND stars_total > 0::numeric) AS charged_calls,
    count(*) FILTER (WHERE actual_upstream_call AND cost_cny IS NOT NULL) AS cost_recorded_calls,
    COALESCE(sum(cost_cny) FILTER (WHERE actual_upstream_call), 0::numeric) AS cost_cny,
    COALESCE(sum(cost_cny) FILTER (WHERE actual_upstream_call AND stars_total = 0::numeric), 0::numeric) AS free_cost_cny,
    COALESCE(sum(cost_cny) FILTER (WHERE actual_upstream_call AND stars_total > 0::numeric), 0::numeric) AS charged_cost_cny,
    COALESCE(sum(stars_total) FILTER (WHERE actual_upstream_call), 0::numeric) AS stars_total,
    COALESCE(sum(stars_main) FILTER (WHERE actual_upstream_call), 0::numeric) AS stars_main,
    COALESCE(sum(stars_bonus) FILTER (WHERE actual_upstream_call), 0::numeric) AS stars_bonus,
    115::numeric AS stars_per_cny,
    COALESCE(sum(stars_main) FILTER (WHERE actual_upstream_call), 0::numeric) / 115.0 AS revenue_lower_bound_cny,
    COALESCE(sum(stars_total) FILTER (WHERE actual_upstream_call), 0::numeric) / 115.0 AS wallet_value_upper_bound_cny,
    COALESCE(sum(stars_main) FILTER (WHERE actual_upstream_call), 0::numeric) / 115.0 - COALESCE(sum(cost_cny) FILTER (WHERE actual_upstream_call), 0::numeric) AS margin_lower_bound_cny,
    COALESCE(sum(stars_total) FILTER (WHERE actual_upstream_call), 0::numeric) / 115.0 - COALESCE(sum(cost_cny) FILTER (WHERE actual_upstream_call), 0::numeric) AS margin_upper_bound_cny
   FROM base
  GROUP BY character_label;
GRANT SELECT ON analytics_grafana.mv_card_unit_economics_30d TO grafana_reader;
COMMENT ON MATERIALIZED VIEW analytics_grafana.mv_card_unit_economics_30d IS 'Fixed rolling 30-day per-card facts. Strict success requires explicit terminal finish reason; excludes still-streaming and insufficient-balance rows.';
CREATE VIEW analytics_grafana.v_free_quota_daily AS  SELECT metric_date,
    quota_limit,
    user_type,
    status,
    decision_rows,
    users,
    characters,
    matched_chat_rows,
    cost_recorded_rows,
    cost_cny
   FROM analytics_grafana.mv_free_quota_daily;
GRANT SELECT ON analytics_grafana.v_free_quota_daily TO grafana_reader;
CREATE VIEW analytics_grafana.v_card_unit_economics_30d AS  SELECT character_label,
    calls,
    active_users,
    paid_users,
    free_only_users,
    clean_success_calls,
    free_calls,
    charged_calls,
    cost_recorded_calls,
    cost_cny,
    free_cost_cny,
    charged_cost_cny,
    stars_total,
    stars_main,
    stars_bonus,
    stars_per_cny,
    revenue_lower_bound_cny,
    wallet_value_upper_bound_cny,
    margin_lower_bound_cny,
    margin_upper_bound_cny,
    round(100.0 * clean_success_calls::numeric / NULLIF(calls, 0)::numeric, 2) AS clean_success_rate_pct,
    round(100.0 * free_calls::numeric / NULLIF(calls, 0)::numeric, 2) AS free_call_rate_pct,
    round(100.0 * cost_recorded_calls::numeric / NULLIF(calls, 0)::numeric, 2) AS cost_coverage_pct
   FROM analytics_grafana.mv_card_unit_economics_30d;
GRANT SELECT ON analytics_grafana.v_card_unit_economics_30d TO grafana_reader;
GRANT SELECT ON analytics_grafana.v_card_unit_economics_30d TO grafana_cloud;
CREATE UNIQUE INDEX mv_card_unit_economics_30d_character_label_idx ON analytics_grafana.mv_card_unit_economics_30d USING btree (character_label);
CREATE UNIQUE INDEX mv_free_quota_daily_uidx ON analytics_grafana.mv_free_quota_daily USING btree (metric_date, quota_limit, user_type, status);
-- Downstream object identities and refresh consumers must survive the switch.
CREATE VIEW analytics_grafana.v_card_downstream_fixture AS SELECT * FROM analytics_grafana.v_card_unit_economics_30d;
CREATE MATERIALIZED VIEW analytics_grafana.mv_strategy_downstream_fixture AS SELECT platform,count(*) FROM analytics_grafana.v_llm_calls GROUP BY platform;
CREATE UNIQUE INDEX strategy_downstream_uidx ON analytics_grafana.mv_strategy_downstream_fixture(platform);
GRANT SELECT ON analytics_grafana.v_card_downstream_fixture,analytics_grafana.mv_strategy_downstream_fixture TO grafana_reader;
