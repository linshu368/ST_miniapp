CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA app_core;
CREATE SCHEMA miniapp_traffic;
CREATE SCHEMA experience;
CREATE TABLE app_core.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tg_id text UNIQUE NOT NULL, source_id text,
 miniapp_entered_at timestamptz, bot_entered_at timestamptz,
 total_round bigint NOT NULL DEFAULT 0, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE experience.chat_history (user_id uuid REFERENCES app_core.users, created_at timestamptz DEFAULT now());
CREATE TABLE miniapp_traffic.botlinks (source_id text UNIQUE, source_name text, bot_link text);
CREATE TABLE miniapp_traffic.traffic_clicks (source_id text UNIQUE, clicks integer);
CREATE FUNCTION miniapp_traffic.increment_click(s text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO miniapp_traffic.traffic_clicks VALUES(s,1) ON CONFLICT(source_id) DO UPDATE SET clicks=miniapp_traffic.traffic_clicks.clicks+1;
$$;
GRANT USAGE ON SCHEMA app_core,experience,miniapp_traffic TO service_role;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA app_core,miniapp_traffic TO service_role;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA experience TO service_role;
INSERT INTO miniapp_traffic.botlinks VALUES('legacy_channel','Legacy','https://example.invalid');
