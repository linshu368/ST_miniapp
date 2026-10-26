-- Isolated local test fixture only. Never execute on a remote project.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE first_token_metrics_reader NOLOGIN;
CREATE SCHEMA miniapp_analytics;
CREATE SCHEMA experience;
CREATE SCHEMA billing;
CREATE SCHEMA cron;
CREATE TABLE experience.chat_history(id uuid PRIMARY KEY,user_id uuid,created_at timestamptz,
 llm_charge_id uuid,model text,status text,llm_billing_snapshot jsonb);
CREATE INDEX ON experience.chat_history(created_at);
CREATE TABLE experience.openrouter_chat_history(chat_history_id uuid UNIQUE,usage jsonb);
CREATE TABLE experience.venice_chat_history(chat_history_id uuid UNIQUE,llm_usage jsonb);
CREATE TABLE billing.llm_usage_charges(charge_key uuid UNIQUE,model_id text,model_display_name text,
 status text,charged_amount numeric,usage_cost_usd numeric);
CREATE TABLE billing.payment_orders(user_id uuid,status text,paid_at timestamptz,amount_cents bigint);
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text,active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3)
 ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid;
$$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $$
 DELETE FROM cron.job WHERE jobid=$1 RETURNING true;
$$;
CREATE FUNCTION cron.alter_job(jobid bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,
 database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$
 UPDATE cron.job j SET active=COALESCE($6,j.active) WHERE j.jobid=$1;
$$;
INSERT INTO cron.job(jobname,schedule,command) VALUES
 ('grafana_cache_billing_hourly','2 * * * *','old heavy refresh'),
 ('grafana_cache_user_distribution_hourly','12 * * * *','old heavy refresh'),
 ('unrelated_job','* * * * *','must stay');
