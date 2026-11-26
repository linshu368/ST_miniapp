#!/usr/bin/env bash
# 20261126_status_refresh_charge.sql on disposable PG17.
# Disposable container only (--network none). No remote URI, user data, model or real billing calls.
# Builds the production shape of billing (wallet + ledger + usage_charges + apply_wallet_debit as of
# 2026-11-26 + chat reservation guards), applies the migration twice and checks every money path.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_container="st-status-refresh-${RANDOM}-$$"
task_temp="$(mktemp -d)"
cleanup() { docker rm -f "$task_container" >/dev/null 2>&1 || true; rm -rf "$task_temp"; }
trap cleanup EXIT
mig="$task_root/packages/shared/migrations"

docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for task_attempt in $(seq 1 30); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] && docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
task_psql=(docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1)

# Production-shaped prerequisites, cut from the real fixtures and migrations.
python3 - "$mig" "$task_temp/setup.sql" <<'PY'
import re, sys
mig, out = sys.argv[1], sys.argv[2]
read = lambda name: open(f"{mig}/{name}", encoding="utf-8").read()
def cut(text, start, end):
    i = text.index(start)
    j = text.index(end, i) + len(end)
    return text[i:j]
harness = read("fixtures/vip_billing_t2_harness.sql").split("CREATE TABLE IF NOT EXISTS billing.payment_orders")[0]
usage = re.search(r"CREATE TABLE IF NOT EXISTS billing\.usage_charges \([\s\S]*?\n\);", read("20261120_db_reorg_p6b1a_usage_charges_expand.sql")).group(0)
debit = cut(read("fixtures/chat_reservation_production_functions.sql"),
            "CREATE OR REPLACE FUNCTION billing.apply_wallet_debit", "$function$;")
reservations = read("20261123_chat_wallet_reservations.sql")
protect = cut(reservations, "CREATE OR REPLACE FUNCTION billing.protect_chat_reserved_balance",
              "EXECUTE FUNCTION billing.protect_chat_reserved_balance();")
guard = cut(reservations, "CREATE OR REPLACE FUNCTION billing.guard_chat_reservation",
            "EXECUTE FUNCTION billing.guard_chat_reservation();")
production_ledger_check = """ALTER TABLE billing.wallet_ledger DROP CONSTRAINT wallet_ledger_entry_type_check;
ALTER TABLE billing.wallet_ledger ADD CONSTRAINT wallet_ledger_entry_type_check CHECK (
  (entry_type = ANY (ARRAY['recharge','chat_debit','refund','adjustment','checkin_bonus','wish_reward','invite_reward',
    'community_reward','image_generation','vip_bonus','image_plaza_generation','image_plaza_share_reward']))
  OR (entry_type = ANY (ARRAY['creator_reward','creator_reward_reversal']))
  OR (entry_type = 'survey_reward')
  OR (entry_type = ANY (ARRAY['media_plaza_video_reserve','media_plaza_video_refund']))) NOT VALID;
COMMENT ON CONSTRAINT wallet_ledger_entry_type_check ON billing.wallet_ledger IS 'ledger types';"""
with open(out, "w", encoding="utf-8") as f:
    f.write("\n".join([
        harness,
        "ALTER TABLE billing.wallet_ledger ADD COLUMN debit_key text UNIQUE;",
        production_ledger_check,
        usage,
        "ALTER TABLE billing.usage_charges ADD COLUMN reserved_main_credits numeric(14,1) NOT NULL DEFAULT 0,"
        " ADD COLUMN reserved_bonus_credits numeric(14,1) NOT NULL DEFAULT 0;",
        debit,
        "REVOKE ALL ON FUNCTION billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;",
        "GRANT EXECUTE ON FUNCTION billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb) TO service_role;",
        protect, guard,
    ]) + "\n")
PY
"${task_psql[@]}" <"$task_temp/setup.sql" >/dev/null

prosrc() { "${task_psql[@]}" -At -c "SELECT prosrc FROM pg_proc WHERE oid='billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure"; }
prosrc >"$task_temp/before.txt"

"${task_psql[@]}" <"$mig/20261126_status_refresh_charge.sql" >/dev/null
prosrc >"$task_temp/after1.txt"
# Replay must be a no-op.
"${task_psql[@]}" <"$mig/20261126_status_refresh_charge.sql" >/dev/null
prosrc >"$task_temp/after2.txt"

cmp -s "$task_temp/after1.txt" "$task_temp/after2.txt" || { echo "FAIL: replay changed apply_wallet_debit" >&2; exit 1; }
diff "$task_temp/before.txt" "$task_temp/after1.txt" >"$task_temp/guard.diff" || true
changed="$(grep -c '^[<>]' "$task_temp/guard.diff" || true)"
[[ "$changed" == "2" ]] || { echo "FAIL: apply_wallet_debit changed $changed lines, expected exactly the guard line" >&2; cat "$task_temp/guard.diff" >&2; exit 1; }
grep -q "'media_plaza_video_reserve', 'status_refresh') THEN" "$task_temp/guard.diff" || { echo "FAIL: guard line not widened" >&2; cat "$task_temp/guard.diff" >&2; exit 1; }

"${task_psql[@]}" <<'SQL'
-- Users: A bonus-only, B mixed, C short, D held by a chat reservation, E other user.
INSERT INTO app_core.users(id) VALUES
  ('a0000000-0000-4000-8000-000000000001'),('b0000000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-000000000001'),('d0000000-0000-4000-8000-000000000001');
INSERT INTO billing.user_wallets(user_id, main_credits, bonus_credits) VALUES
  ('a0000000-0000-4000-8000-000000000001', 0, 10),
  ('b0000000-0000-4000-8000-000000000001', 10, 3),
  ('c0000000-0000-4000-8000-000000000001', 2, 3),
  ('d0000000-0000-4000-8000-000000000001', 10, 0);
-- D has a live chat reservation of 8 main credits.
INSERT INTO billing.usage_charges(id, user_id, kind, status, reserved_main_credits)
  VALUES ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'chat_text', 'reserved', 8);

DO $t$
DECLARE
  s CONSTANT uuid := '5e550000-0000-4000-8000-000000000001';
  r jsonb; w record; l record; c record; n int;
BEGIN
  -- A: bonus covers everything.
  r := billing.charge_status_refresh('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', s, 6);
  IF r->>'status' <> 'charged' THEN RAISE EXCEPTION 'A status %', r; END IF;
  SELECT * INTO w FROM billing.user_wallets WHERE user_id = 'a0000000-0000-4000-8000-000000000001';
  IF w.main_credits <> 0 OR w.bonus_credits <> 4 THEN RAISE EXCEPTION 'A wallet % %', w.main_credits, w.bonus_credits; END IF;
  SELECT * INTO l FROM billing.wallet_ledger WHERE reference_id = 'a1000000-0000-4000-8000-000000000001';
  IF l.entry_type <> 'status_refresh' OR l.reference_type <> 'status_refresh' OR l.amount <> -6
     OR l.bonus_delta <> -6 OR l.main_delta <> 0 OR l.debit_key <> 'status_refresh:a1000000-0000-4000-8000-000000000001'
     OR l.metadata - 'policy' - 'debit_key' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'A ledger %', to_jsonb(l);
  END IF;
  SELECT * INTO c FROM billing.usage_charges WHERE id = 'a1000000-0000-4000-8000-000000000001';
  IF c.kind <> 'status_refresh' OR c.status <> 'charged' OR c.charged_credits <> 6 OR c.quoted_credits <> 6
     OR c.subject_id <> s OR c.debit_ledger_id <> l.id OR c.wallet_policy <> 'main_then_bonus'
     OR c.settled_at IS NULL OR (c.quote #>> '{charge,bonus_credits}')::numeric <> 6 THEN
    RAISE EXCEPTION 'A charge %', to_jsonb(c);
  END IF;

  -- Same charge id again: one debit only.
  r := billing.charge_status_refresh('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', s, 6);
  IF r->>'status' <> 'already_charged' THEN RAISE EXCEPTION 'A replay %', r; END IF;
  SELECT count(*) INTO n FROM billing.wallet_ledger WHERE user_id = 'a0000000-0000-4000-8000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'A replay ledger rows %', n; END IF;
  SELECT * INTO w FROM billing.user_wallets WHERE user_id = 'a0000000-0000-4000-8000-000000000001';
  IF w.bonus_credits <> 4 THEN RAISE EXCEPTION 'A replay wallet %', w.bonus_credits; END IF;

  -- B: bonus first, rest from main.
  r := billing.charge_status_refresh('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', s, 6);
  SELECT * INTO w FROM billing.user_wallets WHERE user_id = 'b0000000-0000-4000-8000-000000000001';
  IF r->>'status' <> 'charged' OR w.main_credits <> 7 OR w.bonus_credits <> 0
     OR (r #>> '{split,main_credits}')::numeric <> 3 OR (r #>> '{split,bonus_credits}')::numeric <> 3 THEN
    RAISE EXCEPTION 'B % wallet % %', r, w.main_credits, w.bonus_credits;
  END IF;

  -- C: 5 < 6 → insufficient, nothing moves, a failed row is kept.
  r := billing.charge_status_refresh('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', s, 6);
  SELECT * INTO w FROM billing.user_wallets WHERE user_id = 'c0000000-0000-4000-8000-000000000001';
  IF r->>'status' <> 'insufficient' OR w.main_credits <> 2 OR w.bonus_credits <> 3 THEN RAISE EXCEPTION 'C % %', r, to_jsonb(w); END IF;
  SELECT * INTO c FROM billing.usage_charges WHERE id = 'c1000000-0000-4000-8000-000000000001';
  IF c.status <> 'failed' OR c.charged_credits <> 0 OR c.debit_ledger_id IS NOT NULL THEN RAISE EXCEPTION 'C charge %', to_jsonb(c); END IF;
  IF EXISTS (SELECT 1 FROM billing.wallet_ledger WHERE user_id = 'c0000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'C ledger written'; END IF;
  r := billing.charge_status_refresh('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', s, 6);
  IF r->>'status' <> 'insufficient' THEN RAISE EXCEPTION 'C replay %', r; END IF;

  -- D: 10 main but 8 held by a chat turn → refuses, reservation intact.
  r := billing.charge_status_refresh('d2000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', s, 6);
  SELECT * INTO w FROM billing.user_wallets WHERE user_id = 'd0000000-0000-4000-8000-000000000001';
  IF r->>'status' <> 'insufficient' OR w.main_credits <> 10 THEN RAISE EXCEPTION 'D % %', r, w.main_credits; END IF;
  IF (SELECT reserved_main_credits FROM billing.usage_charges WHERE id = 'd1000000-0000-4000-8000-000000000001') <> 8 THEN
    RAISE EXCEPTION 'D reservation changed';
  END IF;

  -- Another user reusing a charge id is an error, not a silent success.
  BEGIN
    PERFORM billing.charge_status_refresh('a1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', s, 6);
    RAISE EXCEPTION 'cross-user charge id accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'CHARGE_ID_CONFLICT' THEN RAISE; END IF;
  END;

  -- Bad amounts.
  BEGIN
    PERFORM billing.charge_status_refresh('e1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', s, 1.5);
    RAISE EXCEPTION 'fractional amount accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INVALID_AMOUNT' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM billing.charge_status_refresh('e2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', s, 0);
    RAISE EXCEPTION 'zero amount accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INVALID_AMOUNT' THEN RAISE; END IF;
  END;

  -- Existing debit types still work; unknown types are still rejected.
  r := billing.apply_wallet_debit('b0000000-0000-4000-8000-000000000001', 'chat:1', 'main_only', 1, 'chat_debit', 'llm_usage', 'x', '{}');
  IF r->>'status' <> 'debited' THEN RAISE EXCEPTION 'chat_debit %', r; END IF;
  BEGIN
    PERFORM billing.apply_wallet_debit('b0000000-0000-4000-8000-000000000001', 'bogus:1', 'main_only', 1, 'bogus', 'bogus', 'x', '{}');
    RAISE EXCEPTION 'bogus type accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INVALID_AMOUNT' THEN RAISE; END IF;
  END;

  -- Constraints still reject unknown values.
  BEGIN
    INSERT INTO billing.usage_charges(id, user_id, kind, status) VALUES (gen_random_uuid(), 'b0000000-0000-4000-8000-000000000001', 'bogus', 'charged');
    RAISE EXCEPTION 'bogus kind accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT (SELECT convalidated FROM pg_constraint WHERE conname = 'usage_charges_kind_check') THEN RAISE EXCEPTION 'kind check not validated'; END IF;
  IF (SELECT convalidated FROM pg_constraint WHERE conname = 'wallet_ledger_entry_type_check') THEN RAISE EXCEPTION 'ledger check got validated'; END IF;
  IF obj_description((SELECT oid FROM pg_constraint WHERE conname = 'wallet_ledger_entry_type_check'), 'pg_constraint') IS DISTINCT FROM 'ledger types' THEN
    RAISE EXCEPTION 'ledger check comment lost';
  END IF;

  -- Privileges.
  IF has_function_privilege('anon', 'billing.charge_status_refresh(uuid,uuid,uuid,numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'billing.charge_status_refresh(uuid,uuid,uuid,numeric)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'billing.charge_status_refresh(uuid,uuid,uuid,numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'privileges differ';
  END IF;
END;
$t$;
SQL

# An unexpected apply_wallet_debit guard must abort the whole migration with nothing changed.
"${task_psql[@]}" >/dev/null <<'SQL'
DROP FUNCTION billing.charge_status_refresh(uuid,uuid,uuid,numeric);
DO $tamper$
DECLARE d text := pg_get_functiondef('billing.apply_wallet_debit(uuid,text,text,numeric,text,text,text,jsonb)'::regprocedure);
BEGIN
  EXECUTE replace(d, ', ''status_refresh'') THEN', ', ''status_refresh'', ''other'') THEN');
END;
$tamper$;
SQL
if "${task_psql[@]}" <"$mig/20261126_status_refresh_charge.sql" >/dev/null 2>"$task_temp/tamper.err"; then
  echo "FAIL: migration accepted an unknown wallet guard" >&2; exit 1
fi
grep -q "unknown or duplicate entry guard" "$task_temp/tamper.err" || { cat "$task_temp/tamper.err" >&2; exit 1; }
[[ "$("${task_psql[@]}" -At -c "SELECT to_regprocedure('billing.charge_status_refresh(uuid,uuid,uuid,numeric)') IS NULL")" == "t" ]] \
  || { echo "FAIL: aborted migration left the function behind" >&2; exit 1; }

echo "status refresh charge migration: OK"
