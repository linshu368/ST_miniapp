#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
#
# 6b-1c 写方切换（三）的本地验证（迁移用非超级用户 app_admin 执行）：
#   20261123_db_reorg_p6b1c_turn_billing_rpc.sql（扩展）+ 20261123_db_reorg_p6b1c_turn_billing_contract.sql（收缩）。
#
# 开轮、交付、看板函数用生产原文（fixtures/p6b1c_turn_billing_*_original.sql，md5 与生产 pg_get_functiondef 相同），
# 轮次镜像触发器按 6b-1a 原文 + 6b-1b 补丁重建（md5 与生产 prosrc 相同）。
#   1. 差分：同一组轮次场景（付费、畅聊免费、失败不扣、补结算、重放、Surplus 交付、按用量对账改额、先有编号后结算）
#      分别在"扩展后（写轮次列 → 镜像）"和"收缩后（直写 usage_charges）"两个库里跑，计费行逐行相同；
#      唯一预期差异：开轮只登记编号、还没报价就失败的轮次，旧路径留下一行空报价，新路径不建行。
#   2. 老数据：没有编号的付费老轮次补行并写回编号、失败轮次的快照收进计费行、超过 24 小时的 quoted 报价收口、
#      切换窗口里漏同步的值被补上、看板新旧一致、展示视图每轮星尘不变；4 列、旧表、镜像都删掉；重跑跳过。
#   3. 拒绝：旧扣费记录没进新表、多出引用旧列的函数、已关联轮次金额不一致时拒绝且不改任何东西。
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
mig_dir="$repo_root/packages/shared/migrations"
expand="$mig_dir/20261123_db_reorg_p6b1c_turn_billing_rpc.sql"
contract="$mig_dir/20261123_db_reorg_p6b1c_turn_billing_contract.sql"
begin_fn="$mig_dir/fixtures/p6b1c_turn_billing_begin_original.sql"
delivery_fn="$mig_dir/fixtures/p6b1c_turn_billing_delivery_original.sql"
refresh_fn="$mig_dir/fixtures/p6b1c_turn_billing_refresh_original.sql"
mirror_src="$mig_dir/20261120_db_reorg_p6b1a_usage_charges_expand.sql"
pg="p6b1c-turn-pg-$$"
out_dir=$(mktemp -d)
trap 'docker rm -f "$pg" >/dev/null 2>&1 || true; rm -rf "$out_dir"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
file_md5() { md5 -q "$1" 2>/dev/null || md5sum "$1" | cut -d' ' -f1; }

[[ "$(file_md5 "$begin_fn")" == f049b1d772c061778eb5054c0b1860a3 ]] || fail 'begin fixture is not the production original'
[[ "$(file_md5 "$delivery_fn")" == a51a168e5301f0164c0eae8a41be267c ]] || fail 'delivery fixture is not the production original'
[[ "$(file_md5 "$refresh_fn")" == e7f147ea15ed306229274c39a588df5f ]] || fail 'refresh fixture is not the production original'

docker run --rm -d --network none --name "$pg" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$pg" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
su_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
app_psql() { local db=$1; shift; docker exec -i "$pg" psql -X -q -U app_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }

su_psql postgres >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN CREATEROLE;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
GRANT service_role TO app_admin;
SQL

# 生产 tf_mirror_chat_history_charge = 6b-1a 原文 + 6b-1b 去掉 jsonb_strip_nulls 的补丁
sed -n '/^CREATE OR REPLACE FUNCTION billing.tf_mirror_chat_history_charge()/,/^\$fn\$;/p' "$mirror_src" |
  sed "s/jsonb_strip_nulls(jsonb_build_object('snapshot', NEW.llm_billing_snapshot))/CASE WHEN NEW.llm_billing_snapshot IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('snapshot', NEW.llm_billing_snapshot) END/" \
  >"$out_dir/mirror.sql"

fixture() {
  local db=$1
  su_psql postgres -c "CREATE DATABASE $db OWNER app_admin" >/dev/null
  su_psql "$db" -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto' >/dev/null
  app_psql "$db" >/dev/null <<'SQL'
CREATE SCHEMA app_core; CREATE SCHEMA experience; CREATE SCHEMA billing; CREATE SCHEMA analytics; CREATE SCHEMA ops;
GRANT USAGE ON SCHEMA app_core, experience, billing, analytics, ops TO service_role;
CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE billing.wallet_ledger (id uuid PRIMARY KEY, user_id uuid NOT NULL, amount numeric(14,1) NOT NULL,
  entry_type text, reference_type text, reference_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_core.users(id), session_id uuid, turn_index int, revision int,
  model text, user_input text, assistant_reply text, character_id uuid, status text NOT NULL DEFAULT 'streaming',
  deduction_rate numeric(14,1) DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), llm_finish_reason text,
  llm_charge_id uuid, llm_intended_deduction numeric(14,1), llm_billing_snapshot jsonb, llm_billing_settled_at timestamptz,
  postprocess_version int, rich_reply_metadata jsonb);
CREATE INDEX idx_chat_history_llm_charge_id ON experience.chat_history (llm_charge_id) WHERE llm_charge_id IS NOT NULL;
ALTER TABLE experience.chat_history ENABLE ROW LEVEL SECURITY;
CREATE TABLE experience.chat_history_display_metadata (history_id uuid PRIMARY KEY, request_id text, opening_message text);
CREATE FUNCTION experience.extract_chat_history_display(p_history jsonb) RETURNS TABLE(request_id text, opening_message text)
  LANGUAGE sql IMMUTABLE AS $$ SELECT p_history #>> '{0,request_id}', NULL::text $$;
CREATE TABLE experience.chat_generation_requests (chat_history_id uuid PRIMARY KEY, client_request_id uuid, mode text,
  request_received_at timestamptz, requested_model_id text, requested_provider text, requested_provider_model_id text,
  catalog_version int, primary_timeout_ms int, first_token_deadline_ms int, timeout_rate_target numeric, fallback_model_id text,
  fallback_timeout_ms int, recoverable_delivery boolean, measurement_method text, delivery_attempt_id uuid, first_token_preview jsonb);
CREATE TABLE experience.chat_generation_attempts (id uuid PRIMARY KEY, chat_history_id uuid, role text, provider text,
  provider_model_id text, generation_id text);
CREATE TABLE experience.surplus_calls (history_id uuid, input jsonb);
CREATE FUNCTION experience.record_surplusintelligence_call(p_history_id uuid, p_input jsonb) RETURNS void LANGUAGE sql
  AS $$ INSERT INTO experience.surplus_calls VALUES (p_history_id, p_input) $$;
CREATE TABLE experience.chat_message_overrides (session_id uuid, message_id uuid, role text, content text, deleted boolean, version int);
CREATE TABLE experience.chat_message_likes (session_id uuid, message_id uuid);
CREATE TABLE experience.chat_sessions (id uuid PRIMARY KEY, user_id uuid, character_id uuid);
CREATE TABLE experience.chat_branch_turns (session_id uuid, turn_index int, source_history_id uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA experience TO service_role;

CREATE TABLE billing.usage_charges (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('chat_text', 'chat_voice', 'plaza_image', 'plaza_video')), subject_id uuid,
  status text NOT NULL CHECK (status IN ('quoted', 'reserved', 'pending', 'charged', 'free', 'failed', 'waived', 'refunded',
                                         'partial', 'reconciled', 'historical')),
  billing_mode text, wallet_policy text, quoted_credits numeric(14,1), charged_credits numeric(14,1) NOT NULL DEFAULT 0,
  debit_ledger_id uuid REFERENCES billing.wallet_ledger(id), refund_ledger_id uuid REFERENCES billing.wallet_ledger(id),
  generation_id text, quote jsonb NOT NULL DEFAULT '{}'::jsonb, quote_expires_at timestamptz, settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX usage_charges_generation_key ON billing.usage_charges (generation_id) WHERE generation_id IS NOT NULL;
ALTER TABLE billing.usage_charges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.usage_charges, billing.wallet_ledger TO service_role;
CREATE TABLE billing.llm_usage_charges (charge_key uuid PRIMARY KEY, user_id uuid NOT NULL, charged_amount numeric(14,1) NOT NULL DEFAULT 0,
  status text NOT NULL, debit_ledger_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.llm_usage_charge_dedup (charge_key uuid PRIMARY KEY, user_id uuid NOT NULL,
  charged_amount numeric(14,1) NOT NULL DEFAULT 0, status text NOT NULL);
CREATE FUNCTION billing.prepare_llm_usage_charge() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN INSERT INTO billing.llm_usage_charge_dedup VALUES (NEW.charge_key, NEW.user_id, NEW.charged_amount, NEW.status) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
CREATE FUNCTION billing.retain_recent_llm_usage_charges() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN PERFORM 1 FROM billing.llm_usage_charges, billing.llm_usage_charge_dedup LIMIT 0; RETURN NULL; END $$;
CREATE FUNCTION billing.tf_mirror_llm_usage_charge() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN PERFORM 1 FROM billing.usage_charges LIMIT 0; RETURN NULL; END $$;
CREATE TRIGGER trg_prepare_llm_usage_charge BEFORE INSERT ON billing.llm_usage_charges FOR EACH ROW EXECUTE FUNCTION billing.prepare_llm_usage_charge();
CREATE TRIGGER trg_retain_recent_llm_usage_charges AFTER INSERT ON billing.llm_usage_charges FOR EACH ROW EXECUTE FUNCTION billing.retain_recent_llm_usage_charges();
CREATE TRIGGER trg_mirror_llm_usage_charge AFTER INSERT OR UPDATE ON billing.llm_usage_charges FOR EACH ROW EXECUTE FUNCTION billing.tf_mirror_llm_usage_charge();
CREATE FUNCTION billing.grant_character_creator_reward(p_charge billing.llm_usage_charges) RETURNS void LANGUAGE sql AS
  $$ SELECT NULL::void $$;
CREATE FUNCTION billing.grant_character_creator_reward(p_charge billing.usage_charges) RETURNS void LANGUAGE sql AS
  $$ SELECT NULL::void $$;

CREATE TABLE analytics.core_daily (metric_date date, metric_scope text, model_id text, model_name text, requests bigint,
  chat_users bigint, charged_requests bigint, charged_stars numeric, known_cost_requests bigint, recorded_cost_usd numeric,
  refreshed_at timestamptz, paid_orders bigint, paying_users bigint, cash_cny numeric);
CREATE TABLE ops.llm_calls (chat_history_id uuid, cost_usd numeric, cost_source text, dispatched_at timestamptz);
CREATE TABLE billing.payment_orders (user_id uuid, status text, amount_cents int, paid_at timestamptz);

CREATE VIEW experience.chat_history_display WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.model, h.user_input, h.assistant_reply, h.character_id, h.status,
    COALESCE(uc.charged_credits, h.deduction_rate) AS deduction_rate, h.created_at, h.llm_finish_reason, h.llm_charge_id,
    h.session_id, h.turn_index, h.revision, h.postprocess_version, h.rich_reply_metadata, r.first_token_preview,
    m.request_id AS display_request_id, m.opening_message AS display_opening_message
   FROM experience.chat_history h
     LEFT JOIN experience.chat_history_display_metadata m ON m.history_id = h.id
     LEFT JOIN experience.chat_generation_requests r ON r.chat_history_id = h.id
     LEFT JOIN billing.usage_charges uc ON uc.id = h.llm_charge_id;
CREATE VIEW experience.session_chat_display WITH (security_invoker = true) AS
 SELECT h.id, h.session_id, h.deduction_rate FROM experience.chat_history_display h WHERE h.session_id IS NOT NULL
 UNION ALL
 SELECT b.source_history_id, b.session_id, NULL::numeric AS deduction_rate FROM experience.chat_branch_turns b;
CREATE VIEW experience.session_chat_history WITH (security_invoker = true) AS
 SELECT h.id, h.user_id, h.status, h.deduction_rate, h.session_id, h.turn_index, false AS is_inherited
   FROM ( SELECT DISTINCT ON (c.session_id, c.turn_index) c.id, c.user_id, c.status,
            COALESCE(uc.charged_credits, c.deduction_rate) AS deduction_rate, c.session_id, c.turn_index
           FROM experience.chat_history c
             LEFT JOIN billing.usage_charges uc ON uc.id = c.llm_charge_id
          WHERE c.session_id IS NOT NULL AND c.turn_index IS NOT NULL AND c.revision IS NOT NULL
          ORDER BY c.session_id, c.turn_index, c.revision DESC) h
UNION ALL
 SELECT h.id, s.user_id, h.status, NULL::numeric AS deduction_rate, b.session_id, b.turn_index, true AS is_inherited
   FROM experience.chat_branch_turns b
     JOIN experience.chat_sessions s ON s.id = b.session_id
     JOIN experience.chat_history h ON h.id = b.source_history_id;
GRANT SELECT ON experience.chat_history_display, experience.session_chat_display, experience.session_chat_history TO service_role;
SQL
  app_psql "$db" -f - <"$begin_fn" >/dev/null
  app_psql "$db" -f - <"$delivery_fn" >/dev/null
  app_psql "$db" -f - <"$refresh_fn" >/dev/null
  app_psql "$db" -f - <"$out_dir/mirror.sql" >/dev/null
  app_psql "$db" >/dev/null <<'SQL'
CREATE TRIGGER trg_mirror_chat_history_charge
  AFTER INSERT OR UPDATE OF llm_charge_id, llm_billing_snapshot, deduction_rate, llm_intended_deduction, llm_billing_settled_at
  ON experience.chat_history
  FOR EACH ROW WHEN (NEW.llm_charge_id IS NOT NULL) EXECUTE FUNCTION billing.tf_mirror_chat_history_charge();
REVOKE ALL ON FUNCTION experience.begin_chat_generation_observation(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION experience.select_chat_generation_delivery(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION experience.begin_chat_generation_observation(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION experience.select_chat_generation_delivery(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION experience.begin_chat_generation_observation(uuid, jsonb) IS 'admission RPC';
SQL
  local got
  got=$(app_psql "$db" -At -c "SELECT string_agg(md5(prosrc), ',' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN (
    'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure, 'experience.select_chat_generation_delivery(uuid,uuid,text)'::regprocedure,
    'analytics.refresh_core_daily(date)'::regprocedure, 'billing.tf_mirror_chat_history_charge()'::regprocedure)")
  [[ "$got" == "44823be219f5f41ae91f4d0ebc48ab8b,1a1616a61ba4f3b42a032f08d7b8132a,14b5c720f86cdf0683575ac01401e1df,328ec8a612f0ad05fc00351d1fada03f" ]] ||
    fail "$db: fixture functions differ from production prosrc ($got)"
}

apply() { # db file log
  app_psql "$1" -f - <"$2" >"$3" 2>&1 || { cat "$3"; return 1; }
}

# ---------------------------------------------------------------------------------------------------------------
# 场景：后端在一轮里按顺序调用的数据库操作（两个库完全相同的输入）。时间都是固定值，便于逐行比较。
scenario_sql() {
  cat <<'SQL'
SET ROLE service_role;
-- t(n, k) 生成第 n 轮的固定 uuid：h 轮次 1、s 会话 2、r 请求 3、a 调用 a、c 计费编号 c、l 流水 e
CREATE OR REPLACE FUNCTION pg_temp.t(n int, k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT (lpad(to_hex(n), 8, '0') || '-0000-4000-8000-' ||
       lpad(CASE k WHEN 'h' THEN '1' WHEN 's' THEN '2' WHEN 'r' THEN '3' WHEN 'a' THEN 'a' WHEN 'c' THEN 'c' WHEN 'l' THEN 'e' END, 12, '0'))::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.snap(n int, extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('charge_id', pg_temp.t(n, 'c')::text, 'model_id', 'm-' || n, 'model_display_name', 'Model ' || n,
    'payable_credits', 15, 'fixed_deduction', 15, 'fixed_deduction_category', 'standard', 'discount_rate', NULL,
    'vip_valid_until', NULL, 'wallet_policy', 'main_only') || extra $$;
CREATE OR REPLACE FUNCTION pg_temp.open_turn(n int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO experience.chat_history (id, user_id, session_id, turn_index, revision, model, user_input, status, created_at)
  VALUES (pg_temp.t(n, 'h'), '00000000-0000-4000-8000-0000000000aa', pg_temp.t(n, 's'), 1, 1, 'm-' || n, 'hi', 'streaming',
          timestamptz '2026-11-23 01:00:00+00' + n * interval '1 minute');
  -- 组 prompt 时第一次开轮：只登记计费编号和请求标记
  PERFORM experience.begin_chat_generation_observation(pg_temp.t(n, 'h'), jsonb_build_object(
    'request_id', pg_temp.t(n, 'r'), 'primary_attempt_id', pg_temp.t(n, 'a'), 'requested_model_id', 'm-' || n,
    'provider', 'openrouter', 'model', 'vendor/m-' || n, 'received_at', '2026-11-23T01:00:00Z', 'timeout_ms', 6000,
    'deadline_ms', 6000, 'timeout_rate_target', 0.05, 'catalog_version', 7, 'mode', 'send', 'charge_id', pg_temp.t(n, 'c'),
    'history', jsonb_build_array(jsonb_build_object('role', 'system', 'content', '', 'request_id', pg_temp.t(n, 'r')))));
END $$;
CREATE OR REPLACE FUNCTION pg_temp.dispatch(n int, provider text DEFAULT 'openrouter') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM experience.begin_chat_generation_observation(pg_temp.t(n, 'h'), jsonb_build_object(
    'request_id', pg_temp.t(n, 'r'), 'primary_attempt_id', pg_temp.t(n, 'a'), 'requested_model_id', 'm-' || n,
    'provider', 'openrouter', 'model', 'vendor/m-' || n, 'received_at', '2026-11-23T01:00:00Z', 'timeout_ms', 6000,
    'deadline_ms', 6000, 'timeout_rate_target', 0.05, 'catalog_version', 7, 'mode', 'send', 'charge_id', pg_temp.t(n, 'c'),
    'snapshot', pg_temp.snap(n),
    'history', jsonb_build_array(jsonb_build_object('role', 'system', 'content', 'sys', 'request_id', pg_temp.t(n, 'r')),
                                 jsonb_build_object('role', 'user', 'content', 'hi'))));
  IF provider <> 'openrouter' THEN
    UPDATE experience.chat_generation_attempts SET provider = dispatch.provider, provider_model_id = 'sp/m' WHERE id = pg_temp.t(n, 'a');
  END IF;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.deliver(n int) RETURNS void LANGUAGE sql AS
  $$ SELECT experience.select_chat_generation_delivery(pg_temp.t(n, 'h'), pg_temp.t(n, 'a'), 'gen-' || n) $$;
-- 扣费函数（PR② 起直写 usage_charges，两个库相同）
CREATE OR REPLACE FUNCTION pg_temp.charge(n int, status text, amount numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_ledger uuid;
BEGIN
  IF amount > 0 THEN
    v_ledger := pg_temp.t(n, 'l');
    INSERT INTO billing.wallet_ledger (id, user_id, amount, entry_type, reference_type, reference_id)
    VALUES (v_ledger, '00000000-0000-4000-8000-0000000000aa', -amount, 'chat_debit', 'llm_usage', pg_temp.t(n, 'c')::text);
  END IF;
  INSERT INTO billing.usage_charges AS u (id, user_id, kind, status, charged_credits, debit_ledger_id, generation_id, billing_mode, quote, created_at)
  VALUES (pg_temp.t(n, 'c'), '00000000-0000-4000-8000-0000000000aa', 'chat_text', status, amount, v_ledger, 'gen-' || n, 'fixed_tier',
          jsonb_build_object('charge', jsonb_build_object('model_id', 'm-' || n, 'charged_at', '2026-11-23T02:00:00Z')),
          timestamptz '2026-11-23 01:00:00+00' + n * interval '1 minute')
  ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, charged_credits = EXCLUDED.charged_credits,
    debit_ledger_id = EXCLUDED.debit_ledger_id, generation_id = EXCLUDED.generation_id, billing_mode = EXCLUDED.billing_mode,
    quote = u.quote || EXCLUDED.quote, updated_at = now();
END $$;
CREATE OR REPLACE FUNCTION pg_temp.finish(n int, status text, charge_id boolean) RETURNS void LANGUAGE sql AS $$
  UPDATE experience.chat_history SET status = finish.status, assistant_reply = 'reply', llm_finish_reason = 'stop',
    llm_charge_id = CASE WHEN finish.charge_id THEN pg_temp.t(n, 'c') END WHERE id = pg_temp.t(n, 'h') $$;
CREATE OR REPLACE FUNCTION pg_temp.set_status(n int, status text) RETURNS void LANGUAGE sql AS
  $$ UPDATE experience.chat_history SET status = set_status.status WHERE id = pg_temp.t(n, 'h') $$;
CREATE OR REPLACE FUNCTION pg_temp.quote(n int) RETURNS void LANGUAGE sql AS
  $$ SELECT billing.save_chat_turn_quote(pg_temp.t(n, 'h'), pg_temp.snap(n, '{"provider":"openrouter","provider_model_id":"vendor/x"}')) $$;
CREATE OR REPLACE FUNCTION pg_temp.record(n int, charged numeric, quoted numeric, settled boolean) RETURNS void LANGUAGE sql AS
  $$ SELECT billing.record_chat_turn_charge(pg_temp.t(n, 'h'), charged, quoted,
       CASE WHEN settled THEN timestamptz '2026-11-23 02:00:05+00' END) $$;

-- 1 付费成功：开轮 → 放行 → 交付 → 结算（快照、扣费、回写）→ 收尾登记编号
SELECT pg_temp.open_turn(1); SELECT pg_temp.dispatch(1); SELECT pg_temp.deliver(1); SELECT pg_temp.set_status(1, 'success');
SELECT pg_temp.quote(1); SELECT pg_temp.charge(1, 'charged', 15); SELECT pg_temp.record(1, 15, 15, true); SELECT pg_temp.finish(1, 'success', true);
-- 2 畅聊免费：扣费函数记 free 0
SELECT pg_temp.open_turn(2); SELECT pg_temp.dispatch(2); SELECT pg_temp.deliver(2); SELECT pg_temp.set_status(2, 'success');
SELECT pg_temp.quote(2); SELECT pg_temp.charge(2, 'free', 0); SELECT pg_temp.record(2, 0, 0, true); SELECT pg_temp.finish(2, 'success', true);
-- 3 交付后中断、不扣费（不调扣费函数），收尾清编号
SELECT pg_temp.open_turn(3); SELECT pg_temp.dispatch(3); SELECT pg_temp.deliver(3); SELECT pg_temp.set_status(3, 'stream_interrupted');
SELECT pg_temp.record(3, 0, NULL, false); SELECT pg_temp.finish(3, 'stream_interrupted', false);
-- 4 上游报错、补结算记结算时间（没有扣费明细 → failed）
SELECT pg_temp.open_turn(4); SELECT pg_temp.dispatch(4); SELECT pg_temp.set_status(4, 'upstream_error');
SELECT pg_temp.record(4, 0, NULL, false); SELECT pg_temp.record(4, 0, NULL, true);
-- 5 成功、补结算不经扣费函数（free）
SELECT pg_temp.open_turn(5); SELECT pg_temp.dispatch(5); SELECT pg_temp.deliver(5); SELECT pg_temp.set_status(5, 'success');
SELECT pg_temp.record(5, 0, 0, true); SELECT pg_temp.finish(5, 'success', true);
-- 6 放行重放（同一快照再开一次轮）
SELECT pg_temp.open_turn(6); SELECT pg_temp.dispatch(6); SELECT pg_temp.dispatch(6); SELECT pg_temp.deliver(6); SELECT pg_temp.deliver(6);
-- 7 Surplus 交付
SELECT pg_temp.open_turn(7); SELECT pg_temp.dispatch(7, 'surplus'); SELECT pg_temp.deliver(7); SELECT pg_temp.set_status(7, 'success');
SELECT pg_temp.charge(7, 'charged', 15); SELECT pg_temp.record(7, 15, 15, true); SELECT pg_temp.finish(7, 'success', true);
-- 8 按用量计费：先 pending，对账后改额，回写两次
SELECT pg_temp.open_turn(8); SELECT pg_temp.dispatch(8); SELECT pg_temp.deliver(8); SELECT pg_temp.set_status(8, 'success');
SELECT pg_temp.quote(8); SELECT pg_temp.charge(8, 'pending', 0); SELECT pg_temp.record(8, 0, 9, false);
SELECT pg_temp.charge(8, 'charged', 9); SELECT pg_temp.record(8, 9, 9, true); SELECT pg_temp.finish(8, 'success', true);
-- 9 开轮后、放行前失败：编号被清掉（预期差异：旧路径留一行空报价）
SELECT pg_temp.open_turn(9); SELECT pg_temp.finish(9, 'upstream_error', false);
-- 10 收尾先登记编号、再补结算（没有报价快照的轮次）
INSERT INTO experience.chat_history (id, user_id, status, created_at)
VALUES (pg_temp.t(10, 'h'), '00000000-0000-4000-8000-0000000000aa', 'streaming', timestamptz '2026-11-23 01:10:00+00');
SELECT pg_temp.finish(10, 'upstream_error', true); SELECT pg_temp.record(10, 0, NULL, true);
-- 11 余额不足：交付成功但扣费失败，计费行停在 quoted（之后由超时收口）
SELECT pg_temp.open_turn(11); SELECT pg_temp.dispatch(11); SELECT pg_temp.deliver(11); SELECT pg_temp.set_status(11, 'success');
SELECT pg_temp.quote(11); SELECT pg_temp.record(11, 0, 15, false); SELECT pg_temp.finish(11, 'success', true);
RESET ROLE;
SQL
}
dump_charges() {
  app_psql "$1" -At -c "SELECT id || ' ' || (to_jsonb(u) - 'id' - 'updated_at')::text FROM billing.usage_charges u ORDER BY id"
}
dump_display() {
  app_psql "$1" -At -c "SELECT id || ' ' || coalesce(deduction_rate::text, 'null') FROM experience.chat_history_display ORDER BY id"
}

# ---------------------------------------------------------------------------------------------------------------
echo "== differential: expanded (columns + mirror) vs contracted (direct usage_charges)"
for db in old_db new_db; do
  fixture "$db"
  app_psql "$db" -c "INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-0000000000aa')" >/dev/null
  apply "$db" "$expand" "$out_dir/$db.expand.log" || fail "$db: expand failed"
done
apply new_db "$contract" "$out_dir/new.contract.log" || fail 'contract failed on an empty database'
grep -q 'p6b1c-turn-billing: contract complete' "$out_dir/new.contract.log" || { cat "$out_dir/new.contract.log"; fail 'contract did not finish'; }
for db in old_db new_db; do
  scenario_sql | app_psql "$db" >/dev/null 2>"$out_dir/$db.scenario.err" || { cat "$out_dir/$db.scenario.err"; fail "$db: scenario failed"; }
done
dump_charges old_db >"$out_dir/old.charges"; dump_charges new_db >"$out_dir/new.charges"
orphan='00000009-0000-4000-8000-00000000000c'
grep -q "^$orphan " "$out_dir/old.charges" || fail 'old path should leave a quoted row for the turn that failed before its quote'
grep -q "^$orphan " "$out_dir/new.charges" && fail 'new path must not create a row before the quote'
diff <(grep -v "^$orphan " "$out_dir/old.charges") "$out_dir/new.charges" >"$out_dir/charges.diff" ||
  { cat "$out_dir/charges.diff"; fail 'usage_charges differ between the old and new write paths'; }
echo "usage_charges: $(wc -l <"$out_dir/new.charges" | tr -d ' ') rows identical (only expected difference: no empty quote row for turn 9)"
grep -q '"provider": "surplus"' "$out_dir/new.charges" || fail 'surplus delivery should bind the provider into the quote'
[[ "$(app_psql new_db -At -c "SELECT count(*) FROM experience.surplus_calls")" == 1 ]] || fail 'surplus call should be recorded once'
# 展示视图：已关联轮次相同；编号被清掉的失败轮次旧库显示 0（默认值），新库不显示
diff <(dump_display old_db | sed -E 's/^(0000000[39][^ ]*) 0\.0$/\1 null/') <(dump_display new_db) >"$out_dir/display.diff" ||
  { cat "$out_dir/display.diff"; fail 'display rates differ'; }
echo "display: per-turn credits identical for linked turns; unlinked failed turns now show no credits instead of 0"
[[ "$(app_psql new_db -At -c "SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_schema='experience' AND table_name='chat_history' AND column_name ~ '(deduction|llm_billing|intended)'")" == "" ]] ||
  fail 'billing columns should be gone'

# ---------------------------------------------------------------------------------------------------------------
echo "== legacy data, lost writes, readers, drops and rerun"
fixture legacy_db
app_psql legacy_db >/dev/null <<'SQL'
INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-0000000000aa'), ('00000000-0000-4000-8000-0000000000bb');
-- L1 七月付费、没有编号也没有快照
INSERT INTO experience.chat_history (id, user_id, status, deduction_rate, llm_intended_deduction, created_at, session_id, turn_index, revision)
VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'success', 12, 12, '2026-07-15 10:00+00',
        '20000000-0000-4000-8000-000000000001', 1, 1);
-- L2 九月中断付费：快照里的编号在新表有一行（旧扣费记录迁来、没关联轮次）
INSERT INTO billing.wallet_ledger VALUES ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', -44, 'chat_debit', 'llm_usage', 'x', '2026-09-28 10:00+00');
INSERT INTO billing.usage_charges (id, user_id, kind, status, charged_credits, debit_ledger_id, quote, created_at)
VALUES ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'chat_text', 'charged', 44,
        '30000000-0000-4000-8000-000000000002', '{"charge":{"model_id":"m"}}', '2026-09-28 10:00+00');
INSERT INTO billing.llm_usage_charges VALUES ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 44, 'charged', '30000000-0000-4000-8000-000000000002');
INSERT INTO experience.chat_history (id, user_id, status, deduction_rate, llm_billing_snapshot, created_at)
VALUES ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000aa', 'stream_interrupted', 44,
        '{"charge_id":"40000000-0000-4000-8000-000000000002","model_id":"m2"}', '2026-09-28 10:00+00');
-- L3 失败轮次：快照编号在新表是 failed、没有轮次
INSERT INTO billing.usage_charges (id, user_id, kind, status, quote, created_at)
VALUES ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'chat_text', 'failed', '{"charge":{"model_id":"m"}}', '2026-10-10 10:00+00');
INSERT INTO billing.llm_usage_charge_dedup VALUES ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 0, 'failed');
INSERT INTO experience.chat_history (id, user_id, status, deduction_rate, llm_billing_snapshot, created_at)
VALUES ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000aa', 'upstream_error', 0,
        '{"charge_id":"40000000-0000-4000-8000-000000000003","model_id":"m3"}', '2026-10-10 10:00+00');
-- L4 失败轮次：快照编号在新表没有行
INSERT INTO experience.chat_history (id, user_id, status, deduction_rate, llm_billing_snapshot, created_at)
VALUES ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000aa', 'upstream_error', 0,
        '{"charge_id":"40000000-0000-4000-8000-000000000004","model_id":"m4"}', '2026-10-11 10:00+00');
-- L5 余额不足被拒：没有编号、没有快照、0 扣费 → 不动
INSERT INTO experience.chat_history (id, user_id, status, deduction_rate, created_at)
VALUES ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000aa', 'insufficient_balance', 0, '2026-11-20 10:00+00');
-- L6 过期报价：交付成功没扣上 / 失败轮 / 编号被清掉的空报价；以及 1 小时内的报价和仍在流式的轮次（不动）
INSERT INTO experience.chat_history (id, user_id, status, llm_charge_id, llm_billing_snapshot, created_at) VALUES
  ('10000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-0000000000bb', 'success', '40000000-0000-4000-8000-000000000061',
   '{"charge_id":"40000000-0000-4000-8000-000000000061"}', now() - interval '2 days'),
  ('10000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-0000000000bb', 'upstream_error', '40000000-0000-4000-8000-000000000062',
   '{"charge_id":"40000000-0000-4000-8000-000000000062"}', now() - interval '2 days'),
  ('10000000-0000-4000-8000-000000000064', '00000000-0000-4000-8000-0000000000bb', 'success', '40000000-0000-4000-8000-000000000064',
   '{"charge_id":"40000000-0000-4000-8000-000000000064"}', now() - interval '1 hour'),
  ('10000000-0000-4000-8000-000000000065', '00000000-0000-4000-8000-0000000000bb', 'streaming', '40000000-0000-4000-8000-000000000065',
   '{"charge_id":"40000000-0000-4000-8000-000000000065"}', now() - interval '2 days');
INSERT INTO billing.usage_charges (id, user_id, kind, status, created_at)
VALUES ('40000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-0000000000bb', 'chat_text', 'quoted', now() - interval '2 days');
-- L7 昨天（上海）的轮次：已关联付费一轮 + 没编号的失败一轮，看板新旧要一致
INSERT INTO billing.wallet_ledger VALUES ('30000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-0000000000bb', -15, 'chat_debit', 'llm_usage', 'y', now());
INSERT INTO experience.chat_history (id, user_id, status, model, llm_charge_id, created_at)
VALUES ('10000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-0000000000bb', 'success', 'vendor/m7', '40000000-0000-4000-8000-000000000071',
        ((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1)::timestamp AT TIME ZONE 'Asia/Shanghai' + interval '3 hours'),
       ('10000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-0000000000bb', 'upstream_error', 'vendor/m8', NULL,
        ((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date - 1)::timestamp AT TIME ZONE 'Asia/Shanghai' + interval '4 hours');
UPDATE experience.chat_history SET llm_billing_snapshot = '{"charge_id":"40000000-0000-4000-8000-000000000071","model_id":"m7","model_display_name":"M7"}'
WHERE id = '10000000-0000-4000-8000-000000000071';
UPDATE billing.usage_charges SET status = 'charged', charged_credits = 15, debit_ledger_id = '30000000-0000-4000-8000-000000000007',
  quote = quote || '{"charge":{"model_id":"m7"}}' WHERE id = '40000000-0000-4000-8000-000000000071';
UPDATE experience.chat_history SET deduction_rate = 15, llm_intended_deduction = 15, llm_billing_settled_at = now()
WHERE id = '10000000-0000-4000-8000-000000000071';
INSERT INTO experience.chat_generation_requests (chat_history_id, requested_model_id) VALUES ('10000000-0000-4000-8000-000000000072', 'm8');
-- L8 切换窗口里漏同步：轮次 1 小时前开始，镜像已同步报价；旧版写入口在切换提交那一刻只写进了轮次列（注入在等待之后）
INSERT INTO experience.chat_history (id, user_id, status, llm_charge_id, llm_billing_snapshot, created_at)
VALUES ('10000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-0000000000bb', 'success', '40000000-0000-4000-8000-000000000081',
        '{"charge_id":"40000000-0000-4000-8000-000000000081"}', now() - interval '1 hour');
SQL
apply legacy_db "$expand" "$out_dir/legacy.expand.log" || fail 'legacy: expand failed'
before_display=$(dump_display legacy_db)
# 等待之后注入一次"只写进轮次列"的旧版写入（镜像此时已是空操作），模拟切换那一刻的在途调用
awk '{print} /^SELECT pg_sleep\(5\);$/ {print "UPDATE experience.chat_history SET deduction_rate = 0, llm_intended_deduction = 15, llm_billing_settled_at = timestamptz '"'"'2026-11-23 03:00+00'"'"' WHERE id = '"'"'10000000-0000-4000-8000-000000000081'"'"';"}' \
  "$contract" >"$out_dir/contract_injected.sql"
grep -q "10000000-0000-4000-8000-000000000081" "$out_dir/contract_injected.sql" || fail 'injection point not found'
apply legacy_db "$out_dir/contract_injected.sql" "$out_dir/legacy.contract.log" || fail 'legacy: contract failed'
grep -q 'healed 1 lost writes, linked 2 legacy paid turns, kept 2 failed-turn quotes, closed 3 stale quotes' "$out_dir/legacy.contract.log" ||
  { cat "$out_dir/legacy.contract.log"; fail 'unexpected legacy NOTICE'; }
grep -q 'core_daily .* identical ([0-9]* rows)' "$out_dir/legacy.contract.log" || { cat "$out_dir/legacy.contract.log"; fail 'core_daily compare missing'; }
grep -q 'dropped llm_usage_charges (1 rows), llm_usage_charge_dedup (2 rows)' "$out_dir/legacy.contract.log" ||
  { cat "$out_dir/legacy.contract.log"; fail 'old tables not dropped'; }

q() { app_psql legacy_db -At -c "$1"; }
[[ "$(q "SELECT h.llm_charge_id IS NOT NULL, u.status, u.charged_credits, u.quoted_credits, u.subject_id = h.id, u.quote->>'legacy'
         FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = h.llm_charge_id
         WHERE h.id = '10000000-0000-4000-8000-000000000001'")" == "t|historical|12.0|12.0|t|no_charge_id" ]] || fail 'L1 legacy paid turn'
[[ "$(q "SELECT h.llm_charge_id, u.status, u.charged_credits, u.subject_id = h.id, u.quote->'snapshot'->>'model_id'
         FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = h.llm_charge_id
         WHERE h.id = '10000000-0000-4000-8000-000000000002'")" == "40000000-0000-4000-8000-000000000002|charged|44.0|t|m2" ]] || fail 'L2 linked to its existing charge'
[[ "$(q "SELECT h.llm_charge_id IS NULL, u.status, u.subject_id = h.id, u.quote->'snapshot'->>'model_id', u.quote ? 'charge'
         FROM experience.chat_history h JOIN billing.usage_charges u ON u.id = '40000000-0000-4000-8000-000000000003'
         WHERE h.id = '10000000-0000-4000-8000-000000000003'")" == "t|failed|t|m3|t" ]] || fail 'L3 failed-turn quote kept on its charge'
[[ "$(q "SELECT u.id = '40000000-0000-4000-8000-000000000004', u.status, u.charged_credits, u.quote->>'legacy', u.quote->'snapshot'->>'model_id'
         FROM billing.usage_charges u WHERE u.subject_id = '10000000-0000-4000-8000-000000000004'")" == "t|failed|0.0|no_charge_id|m4" ]] || fail 'L4 failed-turn quote gets a row'
[[ "$(q "SELECT count(*) FROM billing.usage_charges WHERE subject_id = '10000000-0000-4000-8000-000000000005'")" == 0 ]] || fail 'L5 untouched'
[[ "$(q "SELECT string_agg(right(id::text, 2) || ':' || status || ':' || coalesce(quote->>'legacy', '-') || ':' || (settled_at IS NOT NULL), ',' ORDER BY id)
         FROM billing.usage_charges WHERE id::text LIKE '40000000-0000-4000-8000-00000000006_'")" == "61:waived:stale_quote:true,62:failed:stale_quote:true,63:failed:stale_quote:true,64:quoted:-:false,65:quoted:-:false" ]] ||
  fail "L6 stale quotes: $(q "SELECT string_agg(right(id::text, 2) || ':' || status, ',' ORDER BY id) FROM billing.usage_charges WHERE id::text LIKE '40000000-0000-4000-8000-00000000006_'")"
[[ "$(q "SELECT status, quoted_credits, settled_at = timestamptz '2026-11-23 03:00+00' FROM billing.usage_charges WHERE id = '40000000-0000-4000-8000-000000000081'")" == "free|15.0|t" ]] ||
  fail 'L8 lost write should be healed'
after_display=$(dump_display legacy_db)
diff <(echo "$before_display" | grep -v -E '^10000000-0000-4000-8000-00000000000[345] |^10000000-0000-4000-8000-000000000072 ') \
     <(echo "$after_display" | grep -v -E '^10000000-0000-4000-8000-00000000000[345] |^10000000-0000-4000-8000-000000000072 ') >"$out_dir/legacy.display.diff" ||
  { cat "$out_dir/legacy.display.diff"; fail 'display credits changed for linked or legacy paid turns'; }
[[ "$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('tf_mirror_chat_history_charge','tf_mirror_llm_usage_charge','prepare_llm_usage_charge','retain_recent_llm_usage_charges')")" == 0 ]] ||
  fail 'mirror and old-table functions should be gone'
[[ "$(q "SELECT count(*) FROM pg_proc WHERE proname = 'grant_character_creator_reward'")" == 1 ]] || fail 'only the usage_charges overload should remain'
[[ "$(q "SELECT count(*) FROM pg_trigger WHERE tgrelid = 'experience.chat_history'::regclass AND NOT tgisinternal")" == 0 ]] || fail 'chat_history mirror trigger should be gone'
[[ "$(q "SELECT reloptions::text FROM pg_class WHERE oid = 'experience.chat_history_display'::regclass")" == "{security_invoker=true}" ]] || fail 'view options lost'
[[ "$(q "SELECT has_function_privilege('service_role', 'billing.record_chat_turn_charge(uuid,numeric,numeric,timestamptz)', 'EXECUTE')::text || has_function_privilege('anon', 'billing.record_chat_turn_charge(uuid,numeric,numeric,timestamptz)', 'EXECUTE')::text")" == "truefalse" ]] ||
  fail 'RPC grants'
[[ "$(q "SELECT obj_description('experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure, 'pg_proc') || '|' || array_to_string(proacl, ',') FROM pg_proc WHERE oid = 'experience.begin_chat_generation_observation(uuid,jsonb)'::regprocedure")" == "admission RPC|app_admin=X/app_admin,service_role=X/app_admin" ]] ||
  fail 'begin comment/grants changed'
echo "legacy: paid turns linked, failed quotes kept, stale quotes closed, lost write healed, displays unchanged, old objects dropped"

app_psql legacy_db -f - <"$contract" >"$out_dir/legacy.rerun.log" 2>&1 || { cat "$out_dir/legacy.rerun.log"; fail 'rerun failed'; }
grep -q 'already contracted, skipping the switch' "$out_dir/legacy.rerun.log" || fail 'rerun should skip'
echo "rerun: skipped"

# ---------------------------------------------------------------------------------------------------------------
echo "== refusals leave everything unchanged"
state() { app_psql "$1" -At -c "SELECT md5(string_agg(md5(prosrc), ',' ORDER BY oid)) || '|' || (SELECT count(*) FROM information_schema.columns WHERE table_schema='experience' AND table_name='chat_history') FROM pg_proc WHERE pronamespace IN ('experience'::regnamespace, 'billing'::regnamespace, 'analytics'::regnamespace)"; }
refuse() { # db expected-message setup-sql
  local db=$1 msg=$2 setup=$3 before
  fixture "$db"
  app_psql "$db" -c "INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-0000000000aa')" >/dev/null
  apply "$db" "$expand" "$out_dir/$db.expand.log" || fail "$db: expand failed"
  app_psql "$db" -c "$setup" >/dev/null
  before=$(state "$db")
  if app_psql "$db" -f - <"$contract" >"$out_dir/$db.log" 2>&1; then fail "$db: contract should refuse"; fi
  grep -q "$msg" "$out_dir/$db.log" || { cat "$out_dir/$db.log"; fail "$db: wrong refusal"; }
  [[ "$(state "$db")" == "$before" ]] || fail "$db: refusal changed something"
  echo "$db: refused ($msg)"
}
refuse missing_db 'old charge rows are missing or differ' \
  "INSERT INTO billing.llm_usage_charges VALUES ('50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 5, 'charged', NULL)"
refuse reader_db 'unexpected functions reference the dropped billing objects: experience.p_probe()' \
  "CREATE FUNCTION experience.p_probe() RETURNS numeric LANGUAGE sql AS 'SELECT sum(deduction_rate) FROM experience.chat_history'"
refuse diff_db 'linked turns differ from usage_charges' \
  "INSERT INTO experience.chat_history (id, user_id, status, llm_charge_id, deduction_rate) VALUES ('60000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000aa', 'success', '60000000-0000-4000-8000-0000000000c1', 0); UPDATE billing.usage_charges SET charged_credits = 3 WHERE id = '60000000-0000-4000-8000-0000000000c1'"

echo "ALL P6B1C TURN-BILLING CHECKS PASSED"
