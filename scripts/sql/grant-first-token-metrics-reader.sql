-- Optional, reviewed manual provisioning for a dedicated Grafana reader.
-- No passwords, no login, no guessed existing datasource role, no business content grants.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='first_token_metrics_reader') THEN
    CREATE ROLE first_token_metrics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA experience,miniapp_analytics TO first_token_metrics_reader;
GRANT SELECT ON experience.chat_generation_requests,experience.chat_generation_attempts TO first_token_metrics_reader;
GRANT SELECT(id,status,llm_finish_reason) ON experience.chat_history TO first_token_metrics_reader;
GRANT SELECT ON miniapp_analytics.chat_first_token_facts TO first_token_metrics_reader;
GRANT EXECUTE ON FUNCTION miniapp_analytics.chat_first_token_report(timestamptz,timestamptz) TO first_token_metrics_reader;
DROP POLICY IF EXISTS first_token_metrics_read ON experience.chat_generation_requests;
CREATE POLICY first_token_metrics_read ON experience.chat_generation_requests FOR SELECT TO first_token_metrics_reader USING(true);
DROP POLICY IF EXISTS first_token_metrics_read ON experience.chat_generation_attempts;
CREATE POLICY first_token_metrics_read ON experience.chat_generation_attempts FOR SELECT TO first_token_metrics_reader USING(true);
DROP POLICY IF EXISTS first_token_metrics_read ON experience.chat_history;
CREATE POLICY first_token_metrics_read ON experience.chat_history FOR SELECT TO first_token_metrics_reader USING(true);
COMMIT;
-- After inspecting the actual datasource role, grant membership separately:
-- GRANT first_token_metrics_reader TO <confirmed_grafana_login_role>;
