#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261118_db_reorg_p4a_payment_reconcile_jobs.sql (+ _contract) as a NON-superuser with CREATEROLE:
# - expand is idempotent; jobs are backfilled only for reconcilable Epay orders inside the 7-day window; new orders get
#   a job; claim backs off 30s, 60s, ... capped at max, drops jobs of settled / final / out-of-window / non-Epay orders,
#   and two concurrent claimers never get the same order (SKIP LOCKED);
# - payment events moved to ops.payment_events with data, identity, constraints and indexes (renamed); the old backend's
#   upsert-with-ignore through the billing compatibility view still dedupes; direct ops writes work; grants unchanged;
#   the dead record_checkout_confirmation function is gone;
# - contract refuses while a function or view still uses the old event table or retired order columns, then drops the
#   view, 7 columns and their index/constraint; dependent views and the claim function keep working; idempotent.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
expand="$task_root/packages/shared/migrations/20261118_db_reorg_p4a_payment_reconcile_jobs.sql"
contract="$task_root/packages/shared/migrations/20261118_db_reorg_p4a_payment_reconcile_jobs_contract.sql"
stop_policy="$task_root/packages/shared/migrations/20261119_payment_reconcile_stop_policy.sql"
record_rpc="$task_root/packages/shared/migrations/20261118_db_reorg_p4a_record_payment_event.sql"
task_container="st-db-reorg-p4a-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
super_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)
admin_psql=(docker exec -i "$task_container" psql -X -q -U app_admin -d postgres -v ON_ERROR_STOP=1)
expect_fail() { # label, expected error substring; SQL on stdin
  local out
  if out=$("${admin_psql[@]}" 2>&1); then
    echo "FAIL: $1 should have been refused"; exit 1
  fi
  if [[ "$out" != *"$2"* ]]; then
    echo "FAIL: $1 refused with an unexpected error:"; echo "$out"; exit 1
  fi
  echo "ok: $1 refused"
}

"${super_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
GRANT CREATE, CONNECT ON DATABASE postgres TO app_admin;
SQL

# Fixture mirrors the production shape collected on 2026-11-18.
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT anon, authenticated, service_role TO app_admin;
CREATE SCHEMA app_core; CREATE SCHEMA billing; CREATE SCHEMA ops; CREATE SCHEMA cs_feed; CREATE SCHEMA miniapp_traffic;
CREATE SCHEMA test_fixture;
GRANT USAGE ON SCHEMA billing, ops TO service_role;
CREATE TABLE app_core.users (id uuid PRIMARY KEY);
CREATE TABLE billing.payment_orders (
  id text NOT NULL PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_core.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending', 'completed', 'expired', 'failed'])),
  payment_type text NOT NULL CHECK (payment_type = ANY (ARRAY['alipay', 'wxpay'])),
  amount_cents integer NOT NULL CHECK (amount_cents > 0), credits_amount integer NOT NULL CHECK (credits_amount >= 0),
  bonus_credits integer NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0), provider_transaction_id text,
  credits_added boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, paid_at timestamptz,
  next_reconcile_at timestamptz NOT NULL DEFAULT (now() + '00:01:00'::interval), last_reconciled_at timestamptz,
  reconcile_attempts integer NOT NULL DEFAULT 0, reconcile_locked_until timestamptz,
  settled_by text CHECK (settled_by = ANY (ARRAY['webhook', 'return', 'query', 'cron'])),
  product_type text NOT NULL DEFAULT 'credits', product_id text, vip_duration_days integer, vip_bonus_credits integer,
  fulfillment_applied boolean NOT NULL DEFAULT false, vip_valid_until timestamptz,
  checkout_confirmed_at timestamptz, last_checkout_confirmed_at timestamptz,
  checkout_confirm_count integer NOT NULL DEFAULT 0, vip_bonus_main_credits integer NOT NULL DEFAULT 0,
  CONSTRAINT payment_orders_checkout_confirm_count_nonnegative CHECK (checkout_confirm_count >= 0));
CREATE INDEX idx_payment_orders_checkout_confirmed_at ON billing.payment_orders USING btree (checkout_confirmed_at DESC) WHERE (checkout_confirmed_at IS NOT NULL);
CREATE INDEX idx_payment_orders_due_reconcile ON billing.payment_orders USING btree (next_reconcile_at) WHERE ((status = 'pending'::text) AND (credits_added = false));
CREATE INDEX idx_miniapp_payment_orders_status ON billing.payment_orders USING btree (status);
ALTER TABLE billing.payment_orders ENABLE ROW LEVEL SECURITY;
GRANT ALL ON billing.payment_orders TO service_role;

CREATE TABLE billing.payment_operation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_key text NOT NULL UNIQUE, order_id text, user_id uuid,
  event_kind text NOT NULL, stage text NOT NULL, outcome text NOT NULL, source text NOT NULL, trigger text NOT NULL,
  error_class text, duration_ms integer, occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT payment_operation_events_duration_ms_check CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT payment_operation_events_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT payment_operation_events_event_kind_check CHECK (event_kind = ANY (ARRAY['checkout_confirmation', 'order_creation',
    'gateway_create', 'webhook', 'return', 'payment_query', 'settlement', 'fast_reconcile', 'expiry_reconcile'])),
  CONSTRAINT payment_operation_events_outcome_check CHECK (outcome = ANY (ARRAY['started', 'succeeded', 'failed', 'unpaid', 'paid', 'skipped'])));
CREATE INDEX idx_payment_operation_events_occurred_at ON billing.payment_operation_events USING btree (occurred_at DESC);
CREATE INDEX idx_payment_operation_events_order_recorded_at ON billing.payment_operation_events USING btree (order_id, recorded_at DESC) WHERE (order_id IS NOT NULL);
ALTER TABLE billing.payment_operation_events ENABLE ROW LEVEL SECURITY;
GRANT ALL ON billing.payment_operation_events TO service_role;

-- Dead RPC (production body shape, reduced): writes the event table and the checkout columns.
CREATE FUNCTION billing.record_checkout_confirmation(p_order_id text, p_user_id uuid, p_request_id uuid, p_occurred_at timestamptz, p_action text)
 RETURNS TABLE(recorded boolean, checkout_confirmed_at timestamptz, last_checkout_confirmed_at timestamptz, checkout_confirm_count integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
BEGIN
  INSERT INTO billing.payment_operation_events (event_key, order_id, user_id, event_kind, stage, outcome, source, trigger, occurred_at)
  VALUES ('checkout_confirmation:' || p_order_id || ':' || p_request_id::text, p_order_id, p_user_id, 'checkout_confirmation',
          'checkout', 'succeeded', 'client', p_action, p_occurred_at) ON CONFLICT (event_key) DO NOTHING;
  UPDATE billing.payment_orders SET checkout_confirm_count = billing.payment_orders.checkout_confirm_count + 1 WHERE id = p_order_id;
  RETURN;
END;
$function$;

-- Views that depend on payment_orders in production (columns as production).
CREATE VIEW miniapp_traffic.traffic_daily_stats AS
  SELECT o.user_id, sum(o.amount_cents) AS paid_cents FROM billing.payment_orders o WHERE o.status = 'completed' GROUP BY o.user_id;
CREATE VIEW cs_feed.user_profiles AS
  SELECT o.user_id, max(o.paid_at) AS last_paid_at FROM billing.payment_orders o WHERE o.status = 'completed' GROUP BY o.user_id;

INSERT INTO app_core.users VALUES ('00000000-0000-4000-8000-000000000001');
INSERT INTO billing.payment_orders (id, user_id, status, payment_type, amount_cents, credits_amount, credits_added,
  fulfillment_applied, created_at, expires_at, product_type)
SELECT k, '00000000-0000-4000-8000-000000000001', st, 'alipay', 100, 10, ca, fa, now() - age, now() - age + interval '15 minutes', 'credits'
FROM (VALUES
  ('EP-pending-new', 'pending', false, false, interval '5 minutes'),
  ('EP-expired-2d', 'expired', false, false, interval '2 days'),
  ('EP-expired-6d', 'expired', false, false, interval '6 days'),
  ('EP-completed', 'completed', true, false, interval '1 hour'),
  ('EP-expired-credited', 'expired', true, false, interval '1 hour'),
  ('EP-expired-fulfilled', 'expired', false, true, interval '1 hour'),
  ('EP-failed', 'failed', false, false, interval '1 hour'),
  ('EP-pending-10d', 'pending', false, false, interval '10 days'),
  ('LEGACY-pending', 'pending', false, false, interval '1 hour')
) AS t(k, st, ca, fa, age);
INSERT INTO billing.payment_operation_events (event_key, order_id, event_kind, stage, outcome, source, trigger, occurred_at)
SELECT 'fast_reconcile:EP-expired-2d:' || n, 'EP-expired-2d', 'fast_reconcile', 'query', 'unpaid', 'gateway', 'fast_reconcile',
       now() - n * interval '1 minute' FROM generate_series(1, 50) n;
CREATE TABLE test_fixture.event_count AS SELECT count(*) AS n, max(id) AS max_id FROM billing.payment_operation_events;
SQL
echo "ok: fixture"

"${admin_psql[@]}" >/dev/null <"$expand"
"${admin_psql[@]}" >/dev/null <"$expand"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
DECLARE v_ids text;
BEGIN
  SELECT string_agg(order_id, ',' ORDER BY order_id) INTO v_ids FROM billing.payment_reconcile_jobs;
  IF v_ids IS DISTINCT FROM 'EP-expired-2d,EP-expired-6d,EP-pending-new' THEN
    RAISE EXCEPTION 'assert: backfill covered %', v_ids;
  END IF;
  IF EXISTS (SELECT 1 FROM billing.payment_reconcile_jobs WHERE attempts <> 0 OR next_attempt_at <= now()) THEN
    RAISE EXCEPTION 'assert: backfilled jobs not scheduled one minute ahead';
  END IF;

  INSERT INTO billing.payment_orders (id, user_id, payment_type, amount_cents, credits_amount, expires_at)
  VALUES ('EP-inserted', '00000000-0000-4000-8000-000000000001', 'wxpay', 600, 60, now() + interval '15 minutes');
  IF NOT EXISTS (SELECT 1 FROM billing.payment_reconcile_jobs WHERE order_id = 'EP-inserted'
                 AND next_attempt_at BETWEEN now() + interval '59 seconds' AND now() + interval '61 seconds') THEN
    RAISE EXCEPTION 'assert: inserted order has no job one minute ahead';
  END IF;

  -- Events moved with data, identity and renamed constraints/indexes; the compatibility view dedupes upserts.
  IF to_regclass('billing.payment_operation_events') IS NULL
     OR (SELECT relkind FROM pg_class WHERE oid = 'billing.payment_operation_events'::regclass) <> 'v'
     OR (SELECT count(*) FROM ops.payment_events) <> (SELECT n FROM test_fixture.event_count)
     OR to_regclass('ops.idx_payment_events_occurred_at') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_events_event_key_key')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_events_metadata_check') THEN
    RAISE EXCEPTION 'assert: event table not moved intact';
  END IF;
  INSERT INTO billing.payment_operation_events (event_key, order_id, event_kind, stage, outcome, source, trigger, occurred_at)
  VALUES ('fast_reconcile:EP-expired-2d:1', 'EP-expired-2d', 'fast_reconcile', 'query', 'unpaid', 'gateway', 'fast_reconcile', now()),
         ('webhook:EP-pending-new:1', 'EP-pending-new', 'webhook', 'callback', 'paid', 'gateway', 'webhook', now())
  ON CONFLICT (event_key) DO NOTHING;
  INSERT INTO ops.payment_events (event_key, order_id, event_kind, stage, outcome, source, trigger, occurred_at, metadata)
  VALUES ('settlement:EP-pending-new:1', 'EP-pending-new', 'settlement', 'settlement', 'succeeded', 'backend', 'settlement', now(), '{"x":1}')
  ON CONFLICT (event_key) DO NOTHING;
  IF (SELECT count(*) FROM ops.payment_events) <> (SELECT n FROM test_fixture.event_count) + 2
     OR (SELECT min(id) FROM ops.payment_events WHERE event_key LIKE 'webhook:%') <= (SELECT max_id FROM test_fixture.event_count)
     OR (SELECT count(*) FROM billing.payment_operation_events) <> (SELECT count(*) FROM ops.payment_events) THEN
    RAISE EXCEPTION 'assert: old/new event writes wrong';
  END IF;
  IF NOT has_table_privilege('service_role', 'billing.payment_operation_events', 'INSERT')
     OR NOT has_table_privilege('service_role', 'ops.payment_events', 'SELECT')
     OR has_table_privilege('anon', 'billing.payment_operation_events', 'SELECT')
     OR has_table_privilege('authenticated', 'ops.payment_events', 'SELECT')
     OR NOT has_function_privilege('service_role', 'billing.claim_payment_reconcile_jobs(timestamptz,timestamptz,integer,integer,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'billing.claim_payment_reconcile_jobs(timestamptz,timestamptz,integer,integer,integer)', 'EXECUTE')
     OR has_table_privilege('service_role', 'billing.payment_reconcile_jobs', 'UPDATE') THEN
    RAISE EXCEPTION 'assert: grants wrong';
  END IF;
  IF to_regprocedure('billing.record_checkout_confirmation(text,uuid,uuid,timestamptz,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'assert: dead checkout confirmation function still exists';
  END IF;
END $$;
SQL
echo "ok: expand applied twice; backfill, insert trigger, events moved (old view upsert dedupes, ops direct writes), grants"

# The new backend's raw SQL (MiniappPaymentOrderRepository.recordOperationEvent / PaymentAlertMonitorRepository.snapshot),
# with Prisma's parameters written as typed literals.
"${admin_psql[@]}" >/dev/null <<'SQL'
PREPARE record_event(text, text, text, text, text, text, text, text, text, numeric, text, text) AS
  INSERT INTO ops.payment_events (event_key, order_id, user_id, event_kind, stage, outcome, source, trigger,
    error_class, duration_ms, occurred_at, metadata)
  VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::integer, $11::timestamptz, $12::jsonb)
  ON CONFLICT (event_key) DO NOTHING;
EXECUTE record_event('payment_query:EP-pending-new:9', 'EP-pending-new', '00000000-0000-4000-8000-000000000001',
  'payment_query', 'query', 'unpaid', 'gateway', 'user_poll', NULL, 812, '2026-11-18T14:00:00.000Z', '{"attempt":1}');
EXECUTE record_event('payment_query:EP-pending-new:9', 'EP-pending-new', NULL,
  'payment_query', 'query', 'failed', 'gateway', 'user_poll', 'timeout', NULL, '2026-11-18T14:00:01.000Z', '{}');
PREPARE scan(timestamptz, timestamptz, bigint) AS
  SELECT event_kind, outcome, trigger, occurred_at, error_class, duration_ms, order_id, user_id::text AS user_id
  FROM ops.payment_events WHERE occurred_at >= $1 AND occurred_at <= $2 ORDER BY occurred_at DESC LIMIT $3;
CREATE TABLE test_fixture.scan AS EXECUTE scan('2026-11-18T13:00:00Z', '2026-11-18T15:00:00Z', 2000);
SQL
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM ops.payment_events WHERE event_key = 'payment_query:EP-pending-new:9') <> 1
     OR (SELECT duration_ms FROM ops.payment_events WHERE event_key = 'payment_query:EP-pending-new:9') <> 812
     OR (SELECT metadata FROM ops.payment_events WHERE event_key = 'payment_query:EP-pending-new:9') <> '{"attempt":1}'::jsonb
     OR (SELECT count(*) FROM test_fixture.scan WHERE user_id = '00000000-0000-4000-8000-000000000001' AND duration_ms = 812) <> 1 THEN
    RAISE EXCEPTION 'assert: new-backend event insert/dedupe wrong';
  END IF;
END $$;
SQL
echo "ok: new backend event insert (typed params, dedupe) and alert scan SQL run against ops.payment_events"

# record_payment_event: the backend's single write path into ops.payment_events (via PostgREST as service_role).
"${admin_psql[@]}" >/dev/null <"$record_rpc"
"${admin_psql[@]}" >/dev/null <"$record_rpc"
"${admin_psql[@]}" >/dev/null <<'SQL'
SET ROLE service_role;
DO $$ BEGIN
  IF billing.record_payment_event('fast_reconcile:EP-expired-2d:rpc', 'EP-expired-2d', '00000000-0000-4000-8000-000000000001',
       'fast_reconcile', 'query', 'unpaid', 'gateway', 'fast_reconcile', NULL, 950, now(), '{"attempt":2}') IS NOT TRUE
     OR billing.record_payment_event('fast_reconcile:EP-expired-2d:rpc', 'EP-expired-2d', NULL,
       'fast_reconcile', 'query', 'failed', 'gateway', 'fast_reconcile', 'timeout', NULL, now(), NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'assert: record_payment_event insert/dedupe wrong';
  END IF;
  BEGIN
    PERFORM billing.record_payment_event('bad:1', NULL, NULL, 'not_a_kind', 'query', 'unpaid', 'gateway', 'fast_reconcile',
      NULL, NULL, now(), NULL);
    RAISE EXCEPTION 'assert: invalid event kind accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT duration_ms FROM ops.payment_events WHERE event_key = 'fast_reconcile:EP-expired-2d:rpc') <> 950
     OR has_function_privilege('anon', 'billing.record_payment_event(text,text,uuid,text,text,text,text,text,text,integer,timestamptz,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'billing.record_payment_event(text,text,uuid,text,text,text,text,text,text,integer,timestamptz,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assert: record_payment_event result or grants wrong';
  END IF;
END $$;
SQL
echo "ok: record_payment_event writes ops.payment_events as service_role, dedupes, rejects invalid kinds, not for anon"

# Claim: backoff sequence and cap, cleanup, then concurrency -------------------------------------------------------
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
DECLARE
  v_now timestamptz := now();
  v_ids text;
  v_job record;
  i integer;
BEGIN
  UPDATE billing.payment_reconcile_jobs SET next_attempt_at = v_now - interval '1 second';
  SELECT string_agg(id, ',' ORDER BY id) INTO v_ids
  FROM billing.claim_payment_reconcile_jobs(v_now, v_now - interval '7 days', 10, 30, 7200);
  IF v_ids IS DISTINCT FROM 'EP-expired-2d,EP-expired-6d,EP-inserted,EP-pending-new' THEN
    RAISE EXCEPTION 'assert: first claim returned %', v_ids;
  END IF;
  -- Exponential backoff for one job: 30, 60, 120, ..., capped at 7200 seconds (others parked out of the way).
  UPDATE billing.payment_reconcile_jobs SET next_attempt_at = 'infinity' WHERE order_id <> 'EP-expired-6d';
  FOR i IN 0..10 LOOP
    SELECT * INTO v_job FROM billing.payment_reconcile_jobs WHERE order_id = 'EP-expired-6d';
    IF i > 0 THEN
      SELECT string_agg(id, ',') INTO v_ids
      FROM billing.claim_payment_reconcile_jobs(v_job.next_attempt_at, v_now - interval '7 days', 10, 30, 7200);
      IF v_ids IS DISTINCT FROM 'EP-expired-6d' THEN
        RAISE EXCEPTION 'assert: backoff step % claimed %', i, v_ids;
      END IF;
      SELECT * INTO v_job FROM billing.payment_reconcile_jobs WHERE order_id = 'EP-expired-6d';
    END IF;
    IF v_job.attempts <> i + 1
       OR v_job.next_attempt_at - v_job.last_attempt_at <> make_interval(secs => least(30 * power(2, i), 7200)) THEN
      RAISE EXCEPTION 'assert: backoff step % gave attempts=% delay=%', i, v_job.attempts, v_job.next_attempt_at - v_job.last_attempt_at;
    END IF;
    -- Not due one microsecond before the scheduled time.
    IF EXISTS (SELECT 1 FROM billing.claim_payment_reconcile_jobs(v_job.next_attempt_at - interval '1 microsecond',
                 v_now - interval '7 days', 10, 30, 7200)) THEN
      RAISE EXCEPTION 'assert: job claimable before its backoff elapsed (step %)', i;
    END IF;
  END LOOP;

  -- Cleanup: settled, final, credited and out-of-window orders lose their job on the next claim.
  UPDATE billing.payment_orders SET status = 'completed', credits_added = true WHERE id = 'EP-pending-new';
  UPDATE billing.payment_orders SET status = 'failed' WHERE id = 'EP-inserted';
  PERFORM 1 FROM billing.claim_payment_reconcile_jobs(v_now, v_now - interval '3 days', 10, 30, 7200);
  SELECT string_agg(order_id, ',' ORDER BY order_id) INTO v_ids FROM billing.payment_reconcile_jobs;
  IF v_ids IS DISTINCT FROM 'EP-expired-2d' THEN
    RAISE EXCEPTION 'assert: cleanup left %', v_ids;
  END IF;

  BEGIN
    PERFORM 1 FROM billing.claim_payment_reconcile_jobs(v_now, v_now, 0, 30, 7200);
    RAISE EXCEPTION 'assert: invalid claim arguments accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;
-- Reset for the concurrency check: six due jobs.
INSERT INTO billing.payment_orders (id, user_id, payment_type, amount_cents, credits_amount, expires_at)
SELECT 'EP-c' || n, '00000000-0000-4000-8000-000000000001', 'alipay', 100, 10, now() + interval '15 minutes' FROM generate_series(1, 6) n;
UPDATE billing.payment_reconcile_jobs SET next_attempt_at = now() - interval '1 second';
SQL
echo "ok: claim backoff 30s..7200s cap, cleanup of settled/final/out-of-window jobs, argument checks"

# Two claimers at once: A holds its claim open, B must get a disjoint set.
docker exec -i "$task_container" psql -X -q -At -U app_admin -d postgres -v ON_ERROR_STOP=1 >/tmp/p4a_a.$$ <<'SQL' &
BEGIN;
SELECT string_agg(id, ',' ORDER BY id) FROM billing.claim_payment_reconcile_jobs(now(), now() - interval '7 days', 4, 30, 7200);
SELECT pg_sleep(4);
COMMIT;
SQL
claimer_a=$!
sleep 2
b_ids="$("${admin_psql[@]}" -At -c "SELECT string_agg(id, ',' ORDER BY id) FROM billing.claim_payment_reconcile_jobs(now(), now() - interval '7 days', 10, 30, 7200)")"
wait "$claimer_a"
a_ids="$(head -1 /tmp/p4a_a.$$)"; rm -f /tmp/p4a_a.$$
overlap="$(comm -12 <(tr ',' '\n' <<<"$a_ids" | sort) <(tr ',' '\n' <<<"$b_ids" | sort))"
if [[ -z "$a_ids" || -z "$b_ids" || -n "$overlap" ]] || (( $(tr ',' '\n' <<<"$a_ids,$b_ids" | sort -u | wc -l) != 7 )); then
  echo "FAIL: concurrent claims A=[$a_ids] B=[$b_ids]"; exit 1
fi
echo "ok: concurrent claimers got disjoint orders (A=$a_ids | B=$b_ids)"

# Contract guards ---------------------------------------------------------------------------------------------------
"${admin_psql[@]}" >/dev/null <<'SQL'
CREATE FUNCTION test_fixture.rogue() RETURNS bigint LANGUAGE sql AS
  $$ SELECT count(*) FROM billing.payment_orders WHERE next_reconcile_at < now() $$;
SQL
expect_fail "contract with a function reading next_reconcile_at" "functions still reference the old payment event table or retired order columns: test_fixture.rogue()" <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
DROP FUNCTION test_fixture.rogue();
CREATE VIEW test_fixture.rogue_v AS SELECT event_key FROM billing.payment_operation_events;
SQL
expect_fail "contract with a view on the compatibility view" "views still depend on the old payment event table" <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
DROP VIEW test_fixture.rogue_v;
DO $$ BEGIN
  IF to_regclass('billing.payment_operation_events') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'billing' AND table_name = 'payment_orders'
                    AND column_name = 'next_reconcile_at') THEN
    RAISE EXCEPTION 'assert: refused contract left changes behind';
  END IF;
END $$;
SQL

"${admin_psql[@]}" >/dev/null <"$contract"
"${admin_psql[@]}" >/dev/null <"$contract"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
DECLARE v_n integer;
BEGIN
  IF to_regclass('billing.payment_operation_events') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'billing' AND table_name = 'payment_orders'
                AND column_name IN ('next_reconcile_at', 'last_reconciled_at', 'reconcile_attempts', 'reconcile_locked_until',
                                    'checkout_confirmed_at', 'last_checkout_confirmed_at', 'checkout_confirm_count'))
     OR to_regclass('billing.idx_payment_orders_due_reconcile') IS NOT NULL
     OR to_regclass('billing.idx_payment_orders_checkout_confirmed_at') IS NOT NULL THEN
    RAISE EXCEPTION 'assert: contract left old objects';
  END IF;
  PERFORM * FROM miniapp_traffic.traffic_daily_stats;
  PERFORM * FROM cs_feed.user_profiles;
  -- Claim still returns full order rows after the columns are gone; new orders still get a job.
  INSERT INTO billing.payment_orders (id, user_id, payment_type, amount_cents, credits_amount, expires_at)
  VALUES ('EP-after', '00000000-0000-4000-8000-000000000001', 'alipay', 100, 10, now() + interval '15 minutes');
  UPDATE billing.payment_reconcile_jobs SET next_attempt_at = now() - interval '1 second' WHERE order_id = 'EP-after';
  SELECT count(*) INTO v_n FROM billing.claim_payment_reconcile_jobs(now(), now() - interval '7 days', 10, 30, 7200) c
  WHERE c.id = 'EP-after' AND c.amount_cents = 100;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'assert: claim after contract returned % rows for the new order', v_n;
  END IF;
END $$;
SQL
echo "ok: contract applied twice; view and 7 columns dropped; dependent views, insert trigger and claim keep working"
echo "PASS: p4a payment reconcile jobs + events migration"


# Eight-hour / confirmed-unpaid policy (forward migration only).
"${admin_psql[@]}" >/dev/null <<'SQL'
TRUNCATE billing.payment_orders CASCADE;
INSERT INTO billing.payment_orders (id,user_id,payment_type,amount_cents,credits_amount,created_at,expires_at)
SELECT id,'00000000-0000-4000-8000-000000000001','alipay',600,600,
  now() - CASE WHEN id = 'EP-too-old' THEN interval '9 hours' ELSE interval '2 hours' END,
  now() + CASE WHEN id = 'EP-before-expiry' THEN interval '15 minutes' ELSE interval '-1 hour' END
FROM unnest(ARRAY['EP-history','EP-history-one','EP-history-two','EP-active','EP-before-expiry','EP-too-old','EP-concurrent','EP-callback']) id;
INSERT INTO ops.payment_events(event_key,order_id,event_kind,stage,outcome,source,trigger,occurred_at)
SELECT 'stop-history-'||n,'EP-history','fast_reconcile','query','unpaid','gateway','fast_reconcile',now()-interval '30 minutes'
FROM generate_series(1,5) n;
INSERT INTO ops.payment_events(event_key,order_id,event_kind,stage,outcome,source,trigger,occurred_at)
SELECT 'stop-count-'||k||'-'||n,'EP-history-'||k,'expiry_reconcile','query','unpaid','gateway','expiry_reconcile',now()-interval '30 minutes'
FROM (VALUES ('one',1),('two',2)) history(k,total) CROSS JOIN LATERAL generate_series(1,total) n;
INSERT INTO ops.payment_events(event_key,order_id,event_kind,stage,outcome,source,trigger,occurred_at) VALUES
 ('stop-before-expiry','EP-active','fast_reconcile','query','unpaid','gateway','fast_reconcile',now()-interval '90 minutes'),
 ('stop-failed','EP-active','fast_reconcile','query','failed','gateway','fast_reconcile',now()-interval '30 minutes'),
 ('stop-user-query','EP-active','payment_query','query','unpaid','gateway','query',now()-interval '30 minutes');
SQL
"${admin_psql[@]}" >/dev/null <"$stop_policy"
"${admin_psql[@]}" >/dev/null <"$stop_policy"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$
DECLARE r record; v_now timestamptz := clock_timestamp(); i integer;
BEGIN
  IF (SELECT unpaid_confirmations FROM billing.payment_reconcile_jobs WHERE order_id='EP-history') <> 3
     OR (SELECT unpaid_confirmations FROM billing.payment_reconcile_jobs WHERE order_id='EP-active') <> 0
     OR (SELECT unpaid_confirmations FROM billing.payment_reconcile_jobs WHERE order_id='EP-history-one') <> 1
     OR (SELECT unpaid_confirmations FROM billing.payment_reconcile_jobs WHERE order_id='EP-history-two') <> 2 THEN
    RAISE EXCEPTION 'assert: history includes non-confirmed, pre-expiry or explicit-query events';
  END IF;
  UPDATE billing.payment_reconcile_jobs SET next_attempt_at=v_now-interval '1 second';
  PERFORM 1 FROM billing.claim_payment_reconcile_jobs(v_now,v_now-interval '7 days',30,30,7200);
  IF EXISTS (SELECT 1 FROM billing.payment_reconcile_jobs WHERE order_id='EP-too-old')
     OR (SELECT attempts FROM billing.payment_reconcile_jobs WHERE order_id='EP-history') <> 0 THEN
    RAISE EXCEPTION 'assert: DB eight-hour clamp or history stop failed';
  END IF;
  SELECT * INTO r FROM billing.record_payment_reconcile_unpaid('EP-before-expiry',v_now);
  IF r.recorded OR r.confirmations <> 0 THEN RAISE EXCEPTION 'assert: counted before expiry'; END IF;
  FOR i IN 1..3 LOOP
    UPDATE billing.payment_reconcile_jobs SET last_attempt_at=v_now+make_interval(secs=>i) WHERE order_id='EP-active';
    SELECT * INTO r FROM billing.record_payment_reconcile_unpaid('EP-active',v_now+make_interval(secs=>i));
    IF NOT r.recorded OR r.confirmations <> i OR r.stopped <> (i=3) THEN RAISE EXCEPTION 'assert: step % returned %',i,r; END IF;
    SELECT * INTO r FROM billing.record_payment_reconcile_unpaid('EP-active',v_now+make_interval(secs=>i));
    IF r.recorded OR r.confirmations <> i THEN RAISE EXCEPTION 'assert: duplicate counted'; END IF;
    SELECT * INTO r FROM billing.record_payment_reconcile_unpaid('EP-active',v_now);
    IF r.recorded OR r.confirmations <> i THEN RAISE EXCEPTION 'assert: stale counted'; END IF;
  END LOOP;
  UPDATE billing.payment_reconcile_jobs SET next_attempt_at=v_now WHERE order_id='EP-active';
  IF EXISTS (SELECT 1 FROM billing.claim_payment_reconcile_jobs(v_now,v_now-interval '8 hours',30,30,7200) WHERE id='EP-active')
     OR NOT EXISTS (SELECT 1 FROM billing.payment_reconcile_jobs WHERE order_id='EP-active') THEN
    RAISE EXCEPTION 'assert: stopped task reclaimed or prematurely deleted';
  END IF;
  IF has_function_privilege('anon','billing.record_payment_reconcile_unpaid(text,timestamptz)','EXECUTE')
     OR has_function_privilege('authenticated','billing.record_payment_reconcile_unpaid(text,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('service_role','billing.record_payment_reconcile_unpaid(text,timestamptz)','EXECUTE')
     OR has_function_privilege('anon','billing.claim_payment_reconcile_jobs(timestamptz,timestamptz,integer,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'assert: reconcile function ACL drift';
  END IF;
END $$;
SET ROLE service_role;
SELECT * FROM billing.record_payment_reconcile_unpaid('missing',now());
RESET ROLE;
UPDATE billing.payment_reconcile_jobs SET last_attempt_at=clock_timestamp(), unpaid_confirmations=0 WHERE order_id='EP-concurrent';
SQL
# Two sessions replay the same result, one while the other retains the lock.
"${admin_psql[@]}" -At >/tmp/p4a_count_a.$$ <<'SQL' &
BEGIN;
SELECT * FROM billing.record_payment_reconcile_unpaid('EP-concurrent',(SELECT last_attempt_at FROM billing.payment_reconcile_jobs WHERE order_id='EP-concurrent'));
SELECT pg_sleep(3);
COMMIT;
SQL
counter_a=$!
sleep 1
count_b="$("${admin_psql[@]}" -At -c "SELECT * FROM billing.record_payment_reconcile_unpaid('EP-concurrent',(SELECT last_attempt_at FROM billing.payment_reconcile_jobs WHERE order_id='EP-concurrent'))")"
wait "$counter_a"
count_a="$(head -1 /tmp/p4a_count_a.$$)"; rm -f /tmp/p4a_count_a.$$
if [[ "$count_a" != '1|f|t' || "$count_b" != '1|f|f' ]]; then
  echo "FAIL: concurrent result counter A=[$count_a] B=[$count_b]"; exit 1
fi
# Callback holds the order lock before the unpaid result, so the result must observe settlement.
"${admin_psql[@]}" >/dev/null <<'SQL' &
BEGIN;
UPDATE billing.payment_orders SET status='completed',credits_added=true,fulfillment_applied=true WHERE id='EP-callback';
SELECT pg_sleep(3);
COMMIT;
SQL
callback_a=$!
sleep 1
callback_result="$("${admin_psql[@]}" -At -c "SELECT * FROM billing.record_payment_reconcile_unpaid('EP-callback',now())")"
wait "$callback_a"
if [[ "$callback_result" != '0|f|f' ]]; then echo "FAIL: settled callback still counted: $callback_result"; exit 1; fi
"${admin_psql[@]}" >/dev/null <"$stop_policy"
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF (SELECT unpaid_confirmations FROM billing.payment_reconcile_jobs WHERE order_id='EP-concurrent') <> 1
     OR (SELECT unpaid_confirmations FROM billing.payment_reconcile_jobs WHERE order_id='EP-active') <> 3
     OR (SELECT amount_cents FROM billing.payment_orders WHERE id='EP-active') <> 600
     OR (SELECT credits_added FROM billing.payment_orders WHERE id='EP-active') THEN
    RAISE EXCEPTION 'assert: replay decreased checkpoint or changed money';
  END IF;
END $$;
SQL
# Rollback only the claim body, never rerun the historical expand migration.
sed -n '/^CREATE OR REPLACE FUNCTION billing.claim_payment_reconcile_jobs(/,/^\$function\$;/p' "$expand" | "${admin_psql[@]}" >/dev/null
"${admin_psql[@]}" >/dev/null <<'SQL'
DO $$ BEGIN
  IF pg_get_functiondef('billing.claim_payment_reconcile_jobs(timestamptz,timestamptz,integer,integer,integer)'::regprocedure) LIKE '%unpaid_confirmations%' THEN
    RAISE EXCEPTION 'assert: claim rollback did not restore the previous body';
  END IF;
END $$;
SQL
"${admin_psql[@]}" >/dev/null <"$stop_policy"
echo "PASS: eight-hour DB clamp, bounded history, three-unpaid stop, replay/stale/concurrent CAS, callback race, service ACL and claim rollback/forward-fix"
