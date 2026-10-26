-- Domain: experience facts remain runtime-owned; miniapp_analytics is read-only projection.
-- Provision the existing Grafana login with metrics-only access; no business data is changed.
-- Apply through Database Migration workflow, TEST before production.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_token_metrics_reader') THEN
    CREATE ROLE first_token_metrics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'first_token_metrics_reader'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Unexpected first_token_metrics_reader attributes';
  END IF;
  -- A SELECT policy combines with existing grants. Refuse to make pre-existing content grants
  -- effective by adding this membership to a login with broader history access.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_cloud') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_cloud' AND (rolsuper OR rolbypassrls))
      OR EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'experience.chat_history'::regclass AND attnum > 0 AND NOT attisdropped
          AND attname NOT IN ('id', 'status', 'llm_finish_reason')
          AND has_column_privilege('grafana_cloud', attrelid, attname, 'SELECT')
      ) THEN
      RAISE EXCEPTION 'Grafana role has unexpected history privileges; inspect before granting';
    END IF;
  END IF;
END $$;

GRANT USAGE ON SCHEMA experience, miniapp_analytics TO first_token_metrics_reader;
GRANT SELECT ON experience.chat_generation_requests, experience.chat_generation_attempts TO first_token_metrics_reader;
GRANT SELECT (id, status, llm_finish_reason) ON experience.chat_history TO first_token_metrics_reader;
GRANT SELECT ON miniapp_analytics.chat_first_token_facts TO first_token_metrics_reader;
GRANT EXECUTE ON FUNCTION miniapp_analytics.chat_first_token_report(timestamptz, timestamptz) TO first_token_metrics_reader;

DROP POLICY IF EXISTS first_token_metrics_read ON experience.chat_generation_requests;
CREATE POLICY first_token_metrics_read ON experience.chat_generation_requests FOR SELECT TO first_token_metrics_reader USING (true);
DROP POLICY IF EXISTS first_token_metrics_read ON experience.chat_generation_attempts;
CREATE POLICY first_token_metrics_read ON experience.chat_generation_attempts FOR SELECT TO first_token_metrics_reader USING (true);
DROP POLICY IF EXISTS first_token_metrics_read ON experience.chat_history;
CREATE POLICY first_token_metrics_read ON experience.chat_history FOR SELECT TO first_token_metrics_reader USING (true);

DO $$
BEGIN
  -- The same file also works in TEST without a Grafana login. No login/password is created.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_cloud') THEN
    GRANT first_token_metrics_reader TO grafana_cloud WITH INHERIT TRUE, SET FALSE;
  END IF;
END $$;
COMMIT;

-- Access rollback: REVOKE first_token_metrics_reader FROM grafana_cloud;
-- Preserve facts, existing Grafana permissions and the NOLOGIN role for audit/recovery.
