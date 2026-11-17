-- Optional, reviewed manual provisioning for a dedicated Grafana reader.
-- No passwords, no login, no guessed existing datasource role, no business table grants.
-- 2026-11-17（数据库重组 2c）：看板账号只经 miniapp_analytics 视图读，不再授予 experience 表或 USAGE；
-- chat_first_token_facts 以所有者权限执行（security_invoker = false）。
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='first_token_metrics_reader') THEN
    CREATE ROLE first_token_metrics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA miniapp_analytics TO first_token_metrics_reader;
GRANT SELECT ON miniapp_analytics.chat_first_token_facts TO first_token_metrics_reader;
GRANT EXECUTE ON FUNCTION miniapp_analytics.chat_first_token_report(timestamptz,timestamptz) TO first_token_metrics_reader;
COMMIT;
-- After inspecting the actual datasource role, grant membership separately:
-- GRANT first_token_metrics_reader TO <confirmed_grafana_login_role>;
