-- Synthetic local PostgreSQL fixture only. Never execute against TEST/Production.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE cs_persona_reader NOLOGIN;
CREATE SCHEMA experience;
CREATE SCHEMA miniapp_analytics;
GRANT USAGE ON SCHEMA experience,miniapp_analytics TO service_role,cs_persona_reader;
CREATE TABLE experience.chat_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000099',
 model text NOT NULL DEFAULT 'fixture/model', user_input text NOT NULL DEFAULT 'original input', assistant_reply text,
 history jsonb NOT NULL DEFAULT '[]', character_id uuid, status text NOT NULL DEFAULT 'streaming',upstream_status integer,
 deduction_rate numeric, created_at timestamptz NOT NULL DEFAULT now(),
 llm_provider_name text,llm_finish_reason text,llm_usage jsonb,llm_usage_cache jsonb,
 llm_native_tokens_cached integer,llm_native_tokens_reasoning integer,llm_native_tokens_completion integer,llm_native_tokens_prompt integer,
 llm_latency numeric,llm_generation_time numeric,llm_model text,llm_generation_id text,llm_generation_data jsonb,
 llm_intended_deduction numeric,llm_charge_id uuid,llm_billing_snapshot jsonb,llm_billing_settled_at timestamptz,
 session_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000090', turn_index integer NOT NULL DEFAULT 1,revision integer NOT NULL DEFAULT 1,
 postprocess_version integer,choice_rules_mode text,status_rules_mode text,memory_rules_mode text,rich_reply_metadata jsonb
);
CREATE VIEW experience.current_chat_history WITH(security_invoker=true) AS
 SELECT DISTINCT ON(session_id,turn_index) * FROM experience.chat_history
 WHERE session_id IS NOT NULL AND turn_index IS NOT NULL AND revision IS NOT NULL
 ORDER BY session_id,turn_index,revision DESC;
CREATE VIEW miniapp_analytics.base_chat_bj AS SELECT id,user_id,character_id,status,created_at,
 created_at AT TIME ZONE 'Asia/Shanghai' AS msg_ts_bj,(created_at AT TIME ZONE 'Asia/Shanghai')::date AS msg_date_bj,llm_latency FROM experience.chat_history;
GRANT ALL ON experience.chat_history TO service_role;
GRANT SELECT ON experience.chat_history,experience.current_chat_history,miniapp_analytics.base_chat_bj TO cs_persona_reader;
GRANT SELECT ON experience.current_chat_history TO service_role;
CREATE TABLE experience.chat_sessions (id uuid PRIMARY KEY,context_window_start_turn integer DEFAULT 1);
INSERT INTO experience.chat_sessions(id) VALUES('00000000-0000-0000-0000-000000000090');
GRANT SELECT ON experience.chat_sessions TO service_role;
INSERT INTO experience.chat_history(id,turn_index,status,llm_generation_id,llm_provider_name,llm_latency,llm_usage,llm_billing_snapshot,llm_finish_reason)
VALUES ('00000000-0000-0000-0000-000000000001',1,'success','or-fixture','Google',0,'0','{"provider":"openrouter"}','cancelled'),
 ('00000000-0000-0000-0000-000000000002',2,'success','venice-fixture','venice',7,'0', '{"provider":"venice"}','stop'),
 ('00000000-0000-0000-0000-000000000003',3,'upstream_error',NULL,'Google',12,NULL,'{"provider":"openrouter"}',NULL),
 ('00000000-0000-0000-0000-000000000004',4,'upstream_error',NULL,NULL,13,NULL,NULL,NULL);

-- Minimal governance/billing fixtures for contract classification, never real balances.
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.repo_migrations(filename text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO supabase_migrations.repo_migrations VALUES('20260911_chat_history_billing_settlement.sql','f32b5fcec327217bd6591066d1f7e1c758f8b9e372cda3adbc08b6758bf7e9ea','2026-09-14T11:04:05Z');
CREATE SCHEMA billing;
CREATE TABLE billing.llm_usage_charges(charge_key uuid PRIMARY KEY,generation_id text,user_id uuid NOT NULL,status text,charged_amount numeric DEFAULT 0);
CREATE TABLE billing.llm_usage_charge_dedup(LIKE billing.llm_usage_charges INCLUDING ALL);
CREATE TABLE billing.character_free_chat_quota_decisions(charge_key uuid PRIMARY KEY,status text);
