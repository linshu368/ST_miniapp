#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Differential test for 20261123_db_reorg_p6b1c_charge_chain.sql, as a NON-superuser.
#
# Two databases are built the same way from the real migrations (6b-1a expand, #1064 quote fix, charge time) plus the
# production originals of the charge chain (fixtures/p6b1c_charge_chain_originals.sql, md5-verified) and the current
# delivery gate. The "new" database additionally runs the switch migration. Both then run the same scenario list:
#   old path: original functions write llm_usage_charges, the mirrors copy into usage_charges;
#   new path: rewritten functions write usage_charges directly.
# Return values, wallets, ledger, usage_charges, creator rewards and reversals must be identical row by row
# (volatile ids and timestamps reduced to "present / absent"; usage_cost_usd and the old serial id dropped).
# Wallet / reward primitives are the same stubs on both sides; this PR does not change them.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
mig="$task_root/packages/shared/migrations"
switch="$mig/20261123_db_reorg_p6b1c_charge_chain.sql"
task_container="st-db-reorg-p6b1c-chain-${RANDOM}-$$"
out_dir="$(mktemp -d)"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$out_dir"' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE DATABASE old_db OWNER app_admin;
CREATE DATABASE new_db OWNER app_admin;
CREATE DATABASE drift_db OWNER app_admin;
SQL
psql_db() { local db=$1; shift; docker exec -i "$task_container" psql -X -q -U app_admin -d "$db" -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "FAIL: $*"; exit 1; }

build() { # db: base schema + real migrations + production originals + stubs + seeded turns
  local db=$1
  psql_db "$db" >/dev/null <<'SQL'
CREATE SCHEMA app_core; CREATE SCHEMA billing; CREATE SCHEMA experience;
CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE billing.user_wallets (user_id uuid PRIMARY KEY, main_credits numeric(14,1) NOT NULL DEFAULT 0,
  bonus_credits numeric(14,1) NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, entry_type text, amount numeric(14,1),
  main_delta numeric(14,1), bonus_delta numeric(14,1), balance_main numeric(14,1), balance_bonus numeric(14,1),
  reference_type text, reference_id text, debit_key text UNIQUE, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.llm_usage_charges (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, charge_key uuid NOT NULL UNIQUE, generation_id text,
  user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE, model_id text, model_openrouter_id text NOT NULL,
  model_display_name text NOT NULL, catalog_version integer NOT NULL DEFAULT 0, pricing_config_version integer NOT NULL DEFAULT 0,
  usage_cost_usd numeric(18,8),
  exchange_rate numeric(14,4) NOT NULL, model_markup numeric(4,1) NOT NULL, initial_amount numeric(14,1) NOT NULL DEFAULT 0,
  calculated_amount numeric(14,1) NOT NULL DEFAULT 0, charged_amount numeric(14,1) NOT NULL DEFAULT 0,
  fallback_used boolean NOT NULL DEFAULT false, status text NOT NULL, debit_ledger_id uuid REFERENCES billing.wallet_ledger(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), reconciled_at timestamptz);
CREATE UNIQUE INDEX idx_llm_usage_charges_generation ON billing.llm_usage_charges (generation_id) WHERE generation_id IS NOT NULL;
CREATE TABLE billing.llm_usage_charge_dedup (
  charge_key uuid PRIMARY KEY, generation_id text, user_id uuid NOT NULL, charged_amount numeric(14,1) NOT NULL DEFAULT 0,
  status text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.character_creator_rewards (charge_key uuid PRIMARY KEY, character_id uuid, creator_user_id uuid,
  payer_user_id uuid, charged_amount numeric(14,1), reward_rate numeric, reward_amount numeric(14,1),
  debt_offset_amount numeric(14,1), credited_amount numeric(14,1), grant_ledger_id uuid);
CREATE TABLE billing.character_creator_reward_balances (creator_user_id uuid PRIMARY KEY,
  outstanding_debt numeric(14,1) NOT NULL DEFAULT 0, updated_at timestamptz);
CREATE TABLE billing.t_reversals (n serial PRIMARY KEY, charge_key uuid);
CREATE TABLE experience.chat_history (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  llm_charge_id uuid, deduction_rate numeric(14,1), llm_billing_snapshot jsonb, llm_intended_deduction numeric(10,2),
  llm_billing_settled_at timestamptz, llm_finish_reason text, assistant_reply text);
-- Columns exactly as in production (11-21).
CREATE TABLE experience.chat_generation_requests (chat_history_id uuid NOT NULL, client_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  mode text NOT NULL DEFAULT 'chat', request_received_at timestamptz NOT NULL DEFAULT now(), requested_model_id text NOT NULL DEFAULT 'cat-a',
  requested_provider text NOT NULL DEFAULT 'openrouter', requested_provider_model_id text NOT NULL DEFAULT 'm/a',
  catalog_version integer NOT NULL DEFAULT 7, primary_timeout_ms integer NOT NULL DEFAULT 6000, first_token_deadline_ms integer NOT NULL DEFAULT 6000,
  timeout_rate_target numeric NOT NULL DEFAULT 0.05, fallback_model_id text NOT NULL DEFAULT 'x', fallback_triggered_ms numeric,
  delivery_attempt_id uuid, first_token_timeout boolean NOT NULL DEFAULT false, billing_rejected boolean NOT NULL DEFAULT false,
  client_outcome text NOT NULL DEFAULT 'missing', client_first_token_visible_ms numeric, measurement_method text, client_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), fallback_timeout_ms integer, server_timeout_stage text,
  requires_visible_token boolean NOT NULL DEFAULT true, user_stop_billing_enabled boolean NOT NULL DEFAULT true,
  recoverable_delivery boolean NOT NULL DEFAULT false, client_delivery_failed boolean NOT NULL DEFAULT false,
  server_first_token_ready_ms numeric, first_token_preview jsonb);

INSERT INTO app_core.users VALUES ('00000000-0000-0000-00aa-000000000001'), ('00000000-0000-0000-00aa-000000000002'),
  ('00000000-0000-0000-00aa-000000000003'), ('00000000-0000-0000-00aa-000000000004');
INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits) VALUES
  ('00000000-0000-0000-00aa-000000000001', 100, 20), ('00000000-0000-0000-00aa-000000000002', 5, 0),
  ('00000000-0000-0000-00aa-000000000003', 0, 0), ('00000000-0000-0000-00aa-000000000004', 50, 10);
-- K11: a charge pruned from llm_usage_charges long ago; only its dedup fact survives.
INSERT INTO billing.llm_usage_charge_dedup VALUES ('00000000-0000-0000-0c00-000000000011', NULL, '00000000-0000-0000-00aa-000000000001', 5, 'charged', now() - interval '60 days');
SQL
  for f in 20261120_db_reorg_p6b1a_usage_charges_expand.sql 20261121_db_reorg_p6b1b_fix_quote_nulls.sql 20261121_db_reorg_p6b1c_charge_time.sql \
    fixtures/p6b1c_charge_chain_gate.sql fixtures/p6b1c_charge_chain_originals.sql; do
    psql_db "$db" <"$mig/$f" >/dev/null 2>"$out_dir/$db.err" || fail "$db: $f: $(cat "$out_dir/$db.err")"
  done
  psql_db "$db" >/dev/null <<'SQL'
-- Wallet / reward primitives: identical stubs on both sides (not changed by this PR).
CREATE FUNCTION billing.apply_wallet_debit(p_user uuid, p_debit_key text, p_policy text, p_amount numeric, p_entry_type text,
  p_reference_type text, p_reference_id text, p_metadata jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE w billing.user_wallets; v_main numeric(14,1); v_bonus numeric(14,1); v_ledger uuid;
BEGIN
  INSERT INTO billing.user_wallets (user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
  SELECT * INTO w FROM billing.user_wallets WHERE user_id = p_user FOR UPDATE;
  IF p_policy = 'main_only' THEN v_main := p_amount; v_bonus := 0;
  ELSE v_main := LEAST(w.main_credits, p_amount); v_bonus := p_amount - v_main; END IF;
  IF w.main_credits < v_main OR w.bonus_credits < v_bonus THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE' USING ERRCODE = 'P0001';
  END IF;
  UPDATE billing.user_wallets SET main_credits = main_credits - v_main, bonus_credits = bonus_credits - v_bonus, updated_at = now()
  WHERE user_id = p_user RETURNING * INTO w;
  INSERT INTO billing.wallet_ledger (user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
    reference_type, reference_id, debit_key, metadata)
  VALUES (p_user, p_entry_type, -p_amount, -v_main, -v_bonus, w.main_credits, w.bonus_credits, p_reference_type, p_reference_id, p_debit_key, p_metadata)
  RETURNING id INTO v_ledger;
  RETURN jsonb_build_object('ledger_id', v_ledger, 'split', jsonb_build_object('main_credits', v_main, 'bonus_credits', v_bonus), 'wallet', to_jsonb(w));
END $$;
CREATE FUNCTION billing.refund_wallet_debit(p_refund_key text, p_debit_key text, p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d billing.wallet_ledger; w billing.user_wallets;
BEGIN
  SELECT * INTO d FROM billing.wallet_ledger WHERE debit_key = p_debit_key;
  IF EXISTS (SELECT 1 FROM billing.wallet_ledger WHERE debit_key = p_refund_key) THEN
    SELECT * INTO w FROM billing.user_wallets WHERE user_id = d.user_id;
    RETURN jsonb_build_object('status', 'already_refunded', 'refund_key', p_refund_key, 'wallet', to_jsonb(w));
  END IF;
  UPDATE billing.user_wallets SET main_credits = main_credits - d.main_delta, bonus_credits = bonus_credits - d.bonus_delta, updated_at = now()
  WHERE user_id = d.user_id RETURNING * INTO w;
  INSERT INTO billing.wallet_ledger (user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
    reference_type, reference_id, debit_key, metadata)
  VALUES (d.user_id, 'refund', -d.amount, -d.main_delta, -d.bonus_delta, w.main_credits, w.bonus_credits, 'wallet_refund', p_debit_key,
    p_refund_key, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('status', 'refunded', 'refund_key', p_refund_key, 'wallet', to_jsonb(w),
    'split', jsonb_build_object('main_credits', -d.main_delta, 'bonus_credits', -d.bonus_delta));
END $$;
CREATE FUNCTION billing.lock_character_creator_wallets(uuid, jsonb) RETURNS void LANGUAGE sql AS 'SELECT';
CREATE FUNCTION billing.reverse_character_creator_reward(p_charge_key uuid) RETURNS void LANGUAGE sql AS
  'INSERT INTO billing.t_reversals (charge_key) VALUES (p_charge_key)';
CREATE FUNCTION billing.grant_bonus_credits(p_user uuid, p_amount numeric, p_entry_type text, p_reference_type text,
  p_reference_id text, p_metadata jsonb) RETURNS TABLE(o_ledger_id uuid) LANGUAGE plpgsql AS $$
DECLARE w billing.user_wallets;
BEGIN
  INSERT INTO billing.user_wallets (user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
  UPDATE billing.user_wallets SET bonus_credits = bonus_credits + p_amount, updated_at = now() WHERE user_id = p_user RETURNING * INTO w;
  RETURN QUERY INSERT INTO billing.wallet_ledger (user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus,
    reference_type, reference_id, metadata)
  VALUES (p_user, p_entry_type, p_amount, 0, p_amount, w.main_credits, w.bonus_credits, p_reference_type, p_reference_id, p_metadata) RETURNING id;
END $$;

-- Turns that reached the quote step: the turn mirror opens a 'quoted' usage_charges row, as in production.
INSERT INTO experience.chat_history (id, user_id, status, llm_charge_id, llm_billing_snapshot, llm_finish_reason)
SELECT ('00000000-0000-0000-0d00-0000000000' || k)::uuid, u::uuid, s, ('00000000-0000-0000-0c00-0000000000' || k)::uuid,
  jsonb_build_object('charge_id', '00000000-0000-0000-0c00-0000000000' || k, 'billing_mode', 'fixed_tier', 'payable_credits', p,
    'wallet_policy', 'main_only', 'model_id', 'cat-a', 'model_display_name', 'Model A', 'discount_rate', NULL), f
FROM (VALUES ('01', '00000000-0000-0000-00aa-000000000001', 'streaming', 10, NULL),
             ('03', '00000000-0000-0000-00aa-000000000001', 'streaming', 10, NULL),
             ('04', '00000000-0000-0000-00aa-000000000001', 'streaming', 10, NULL),
             ('05', '00000000-0000-0000-00aa-000000000002', 'streaming', 10, NULL),
             ('06', '00000000-0000-0000-00aa-000000000001', 'stream_interrupted', 12, 'user_cancelled'),
             ('13', '00000000-0000-0000-00aa-000000000001', 'streaming', 10, NULL),
             ('18', '00000000-0000-0000-00aa-000000000001', 'streaming', 10, NULL),
             ('19', '00000000-0000-0000-00aa-000000000001', 'streaming', 10, NULL),
             ('20', '00000000-0000-0000-00aa-000000000001', 'streaming', 10, NULL)) AS t(k, u, s, p, f);
-- Delivery gate inputs: K06 user stop, K18 receipt still pending, K19 client timed out. Other keys have no request (legacy).
INSERT INTO experience.chat_generation_requests (chat_history_id, client_outcome) VALUES
  ('00000000-0000-0000-0d00-000000000006', 'observed'), ('00000000-0000-0000-0d00-000000000018', 'missing'),
  ('00000000-0000-0000-0d00-000000000019', 'timed_out');

CREATE TABLE public.t_results (step int PRIMARY KEY, label text, out jsonb);
CREATE FUNCTION public.t_run(p_step int, p_label text, p_call text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  BEGIN
    EXECUTE 'SELECT to_jsonb((' || p_call || '))' INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := jsonb_build_object('error', SQLSTATE, 'message', SQLERRM);
  END;
  INSERT INTO public.t_results VALUES (p_step, p_label, v);
END $$;
CREATE FUNCTION public.t_charge(p_key text, p_gen text, p_user text, p_markup numeric, p_calc numeric, p_cost numeric, p_meta jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT billing.charge_llm_usage(('00000000-0000-0000-0c00-0000000000' || p_key)::uuid, p_gen, ('00000000-0000-0000-00aa-0000000000' || p_user)::uuid,
    'cat-a', 'm/a', 'Model A', 7, 3, p_cost, 7.2, p_markup, p_calc, false, p_meta)
$$;
CREATE FUNCTION public.t_norm(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN CASE jsonb_typeof(j)
    WHEN 'object' THEN (SELECT COALESCE(jsonb_object_agg(k, CASE
        WHEN k IN ('created_at', 'updated_at', 'reconciled_at', 'charged_at', 'processed_at', 'settled_at',
                   'ledger_id', 'debit_ledger_id', 'grant_ledger_id', 'refund_ledger_id')
          THEN to_jsonb(v IS NOT NULL AND v <> 'null'::jsonb)
        ELSE public.t_norm(v) END), '{}'::jsonb)
      FROM jsonb_each(j) e(k, v) WHERE k NOT IN ('id', 'usage_cost_usd'))
    WHEN 'array' THEN (SELECT COALESCE(jsonb_agg(public.t_norm(v) ORDER BY o), '[]'::jsonb) FROM jsonb_array_elements(j) WITH ORDINALITY a(v, o))
    ELSE j END;
END $$;
SQL
}

scenarios() {
  psql_db "$1" >/dev/null <<'SQL'
-- metadata as the backend sends it (apply-charge.ts) for a fixed tier turn
SELECT t_run(1, 'fixed charge on an open quote', $$t_charge('01', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","fixed_deduction_category":"text_standard","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(2, 'replay', $$t_charge('01', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(3, 'waiting for finish reason', $$t_charge('03', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success"}')$$);
SELECT t_run(4, 'still waiting', $$t_charge('03', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":99,"chat_status":"success"}')$$);
SELECT t_run(5, 'finish reason arrives, quote kept', $$t_charge('03', 'g-03', '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":99,"wallet_policy":"main_then_bonus","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(6, 'non-billable finish', $$t_charge('04', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"stream_interrupted","finish_reason":"error"}')$$);
SELECT t_run(7, 'insufficient balance rolls back', $$t_charge('05', NULL, '02', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(8, 'user stop bills the stored quote', $$t_charge('06', NULL, '01', 1.0, 10, NULL, '{"chat_status":"stream_interrupted","finish_reason":"user_cancelled"}')$$);
SELECT t_run(9, 'free model failure without a turn', $$t_charge('07', NULL, '01', 0, 0, NULL, '{"chat_status":"upstream_error"}')$$);
SELECT t_run(10, 'usage billing', $$t_charge('08', 'g-08', '04', 1.5, 8, 0.002, '{"wallet_policy":"main_then_bonus","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(11, 'reconcile up', $$billing.reconcile_llm_usage('00000000-0000-0000-0c00-000000000008', 0.003, 11, '{"source":"t"}')$$);
SELECT t_run(12, 'reconcile down', $$billing.reconcile_llm_usage('00000000-0000-0000-0c00-000000000008', 0.001, 6, NULL)$$);
SELECT t_run(13, 'deferred usage', $$t_charge('09', NULL, '04', 1.5, 4, NULL, '{"wallet_policy":"main_then_bonus","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(14, 'deferred reconciled', $$billing.reconcile_llm_usage('00000000-0000-0000-0c00-000000000009', 0.004, 4, '{}')$$);
SELECT t_run(15, 'charge with generation id', $$t_charge('10', 'g-10', '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(16, 'same generation under another key', $$t_charge('12', 'g-10', '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(17, 'open quote, generation already charged elsewhere', $$t_charge('20', 'g-10', '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(18, 'archived charge', $$t_charge('11', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(19, 'archived charge, other owner', $$t_charge('11', NULL, '02', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(20, 'creator reward', $$t_charge('13', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop","creator_reward":{"creator_user_id":"00000000-0000-0000-00aa-000000000003","character_id":"00000000-0000-0000-00cc-000000000001","rate":0.4}}')$$);
SELECT t_run(21, 'refund', $$billing.refund_llm_usage_charge('00000000-0000-0000-0c00-000000000001', ' user asked ')$$);
SELECT t_run(22, 'refund again', $$billing.refund_llm_usage_charge('00000000-0000-0000-0c00-000000000001', NULL)$$);
SELECT t_run(23, 'refund a failed charge', $$billing.refund_llm_usage_charge('00000000-0000-0000-0c00-000000000004', NULL)$$);
SELECT t_run(24, 'refund unknown', $$billing.refund_llm_usage_charge('00000000-0000-0000-0c00-000000000099', NULL)$$);
SELECT t_run(25, 'refund archived', $$billing.refund_llm_usage_charge('00000000-0000-0000-0c00-000000000011', NULL)$$);
SELECT t_run(26, 'refund with creator reward', $$billing.refund_llm_usage_charge('00000000-0000-0000-0c00-000000000013', 'r')$$);
SELECT t_run(27, 'invalid input', $$billing.charge_llm_usage('00000000-0000-0000-0c00-000000000014', NULL, '00000000-0000-0000-00aa-000000000001', 'cat-a', '', 'A', 1, 1, NULL, 1, 1, 1, false, '{}')$$);
SELECT t_run(28, 'owner mismatch', $$t_charge('01', NULL, '02', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(29, 'no wallet policy', $$t_charge('16', NULL, '01', 1.0, 5, NULL, '{"billing_mode":"fixed_tier","payable_credits":5,"chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(30, 'legacy free_quota category', $$t_charge('17', NULL, '01', 1.0, 3, NULL, '{"billing_mode":"fixed_tier","payable_credits":3,"fixed_deduction_category":"free_quota","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(31, 'gate pending', $$t_charge('18', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(32, 'gate waived', $$t_charge('19', NULL, '01', 1.0, 10, NULL, '{"billing_mode":"fixed_tier","payable_credits":10,"wallet_policy":"main_only","chat_status":"success","finish_reason":"stop"}')$$);
SELECT t_run(33, 'reconcile archived', $$billing.reconcile_llm_usage('00000000-0000-0000-0c00-000000000011', 0.1, 1, NULL)$$);
-- the backend records the outcome on the turn afterwards; the turn mirror runs on both sides
UPDATE experience.chat_history SET status = 'success', deduction_rate = 10, llm_intended_deduction = 10, llm_billing_settled_at = now()
WHERE id = '00000000-0000-0000-0d00-000000000001';
SQL
}

export_state() {
  psql_db "$1" -At <<'SQL'
SELECT 'result ' || step || ' ' || label || ' ' || t_norm(out)::text FROM t_results ORDER BY step;
SELECT 'wallet ' || user_id || ' ' || main_credits || ' ' || bonus_credits FROM billing.user_wallets ORDER BY user_id;
SELECT 'ledger ' || t_norm(to_jsonb(l))::text FROM billing.wallet_ledger l
ORDER BY reference_id, entry_type, amount, debit_key;
SELECT 'charge ' || t_norm(to_jsonb(u))::text FROM billing.usage_charges u ORDER BY id;
SELECT 'reward ' || t_norm(to_jsonb(r))::text FROM billing.character_creator_rewards r ORDER BY charge_key;
SELECT 'reversal ' || charge_key::text FROM billing.t_reversals ORDER BY n;
SQL
}

build old_db
build new_db
out=$(psql_db new_db <"$switch" 2>&1) || fail "switch migration: $out"
[[ "$out" == *'3 functions now write usage_charges'* ]] || fail "switch notice: $out"
echo 'ok: switch migration applied on the new database'
scenarios old_db
scenarios new_db
export_state old_db >"$out_dir/old.txt"
export_state new_db >"$out_dir/new.txt"
if ! diff -u "$out_dir/old.txt" "$out_dir/new.txt" >"$out_dir/diff.txt"; then
  cat "$out_dir/diff.txt"
  fail 'old and new paths differ'
fi
echo "ok: old and new paths identical ($(grep -c '^result' "$out_dir/new.txt") calls, $(grep -c '^ledger' "$out_dir/new.txt") ledger rows, $(grep -c '^charge' "$out_dir/new.txt") charge rows)"

check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_db new_db -At 2>&1)
  [[ "$got" == "t" ]] || fail "$1 (got: $got)"
  echo "ok: $1"
}
check 'expected outcomes (not just equal): charged, pending, failed_free, archived, reward, refund, errors' <<'SQL'
SELECT (SELECT out->>'charge_status' FROM t_results WHERE step = 1) = 'charged'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 2) = 'already_charged'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 3) = 'pending'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 4) = 'already_pending'
   AND (SELECT out->'charge'->>'charged_amount' FROM t_results WHERE step = 5) = '10.0'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 6) = 'failed'
   AND (SELECT out->>'message' FROM t_results WHERE step = 7) = 'INSUFFICIENT_BALANCE'
   AND (SELECT out->'charge'->>'charged_amount' FROM t_results WHERE step = 8) = '12.0'
   AND (SELECT out->'charge'->'metadata'->>'billing_mode' FROM t_results WHERE step = 9) = 'failed_free'
   AND (SELECT out->>'reconcile_status' FROM t_results WHERE step = 11) = 'reconciled'
   AND (SELECT out->'charge'->>'charge_key' FROM t_results WHERE step = 16) = '00000000-0000-0000-0c00-000000000010'
   AND (SELECT out->'charge'->>'charge_key' FROM t_results WHERE step = 17) = '00000000-0000-0000-0c00-000000000010'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 18) = 'already_archived'
   AND (SELECT out->>'error' FROM t_results WHERE step = 19) = '22023'
   AND (SELECT out->>'status' FROM t_results WHERE step = 21) = 'refunded'
   AND (SELECT out->>'status' FROM t_results WHERE step IN (24)) = 'not_found'
   AND (SELECT out->>'status' FROM t_results WHERE step IN (25)) = 'not_found'
   AND (SELECT out->>'error' FROM t_results WHERE step = 27) = '22023'
   AND (SELECT out->>'error' FROM t_results WHERE step = 29) = 'P0001'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 30) = 'charged'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 31) = 'pending'
   AND (SELECT out->>'charge_status' FROM t_results WHERE step = 32) = 'failed'
   AND (SELECT out->>'error' FROM t_results WHERE step = 33) = 'P0002'
   AND (SELECT count(*) FROM billing.character_creator_rewards) = 1
   -- every refund that passes the debit checks reverses creator rewards (steps 21, 22, 26)
   AND (SELECT count(*) FROM billing.t_reversals) = 3;
SQL
check 'new path writes nothing to the old tables; unique generation index in place' <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM billing.llm_usage_charges)
   AND (SELECT count(*) FROM billing.llm_usage_charge_dedup) = 1
   AND (SELECT indisunique AND indisvalid FROM pg_index WHERE indexrelid = 'billing.usage_charges_generation_key'::regclass)
   AND to_regclass('billing.usage_charges_generation_idx') IS NULL;
SQL
out=$(psql_db new_db <"$switch" 2>&1) || fail "rerun: $out"
[[ "$out" == *'0 functions now write usage_charges'* ]] || fail "rerun notice: $out"
echo 'ok: rerun is a no-op'

build drift_db
psql_db drift_db -c "CREATE OR REPLACE FUNCTION billing.refund_llm_usage_charge(p_charge_key uuid, p_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb'" >/dev/null
if out=$(psql_db drift_db <"$switch" 2>&1); then fail 'drift should refuse'; fi
[[ "$out" == *'drifted function billing.refund_llm_usage_charge'* ]] || fail "drift message: $out"
[[ $(psql_db drift_db -At -c "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'charge_llm_usage'") == dd164728b74f6e07a94c137b9d92d4d8 ]] ||
  fail 'drift must leave charge_llm_usage untouched'
echo 'ok: a drifted function is refused before any change'
echo 'all checks passed'
