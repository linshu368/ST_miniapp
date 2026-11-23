#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261120_db_reorg_p6b1q_free_model_expand.sql as a NON-superuser:
# - the two validators start as the production bodies (md5 checked; the catalog one keeps its \r\n line endings);
# - after the patch a catalog without is_free and a pricing config without freeQuotaExhausted validate;
# - a non-boolean is_free, a negative freeQuotaExhausted and a missing light amount are still rejected;
# - the self-check passes on configs with and without the fields; rerun is a no-op; a drifted body is refused.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261120_db_reorg_p6b1q_free_model_expand.sql"
task_container="st-db-reorg-p6b1q-expand-${RANDOM}-$$"
trap 'docker rm -f "$task_container" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$task_container" --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if [[ "$(docker logs "$task_container" 2>&1)" == *'PostgreSQL init process complete'* ]] &&
    docker exec "$task_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$task_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE app_admin LOGIN NOSUPERUSER CREATEROLE;
CREATE DATABASE fixture OWNER app_admin;
SQL
psql_f() { docker exec -i "$task_container" psql -X -q -U app_admin -d fixture -v ON_ERROR_STOP=1 "$@"; }
check() { # label; SQL on stdin must print exactly "t"
  local got
  got=$(psql_f -At)
  if [[ "$got" != "t" ]]; then echo "FAIL: $1 (got: $got)"; exit 1; fi
  echo "ok: $1"
}
# Production bodies (base64 of pg_proc.prosrc, 11-20)
CATALOG_B64='DQpCRUdJTgogIFBFUkZPUk0gYWRtaW4udmFsaWRhdGVfbW9kZWxfY2F0YWxvZ19maXJzdF90b2tlbihwX3ZhbHVlKTsNCiAgSUYgRVhJU1RTICgNCiAgICBTRUxFQ1QgMSBGUk9NIGpzb25iX2FycmF5X2VsZW1lbnRzKHBfdmFsdWUgLT4gJ3RpZXJzJykgQVMgdGllcg0KICAgIFdIRVJFIHRyaW0odGllciAtPj4gJ2xhYmVsJykgPSAnJw0KICAgICAgT1IgY2hhcl9sZW5ndGgodHJpbSh0aWVyIC0+PiAnbGFiZWwnKSkgPiAyMA0KICAgICAgT1IgQ09BTEVTQ0UodGllciAtPj4gJ2NvbG9yJywgJycpICF+ICdeI1swLTlBLUZhLWZdezZ9JCcNCiAgICAgIE9SIENPQUxFU0NFKGNoYXJfbGVuZ3RoKHRyaW0odGllciAtPj4gJ2Nvc3RfaGludCcpKSwgMCkgTk9UIEJFVFdFRU4gMSBBTkQgNTANCiAgICAgIE9SIGpzb25iX2FycmF5X2xlbmd0aCh0aWVyIC0+ICdtb2RlbHMnKSA9IDANCiAgICAgIE9SICh0aWVyIC0+PiAnc29ydF9vcmRlcicpOjpOVU1FUklDIDwgMA0KICAgICAgT1IgKHRpZXIgLT4+ICdzb3J0X29yZGVyJyk6Ok5VTUVSSUMgPD4gdHJ1bmMoKHRpZXIgLT4+ICdzb3J0X29yZGVyJyk6Ok5VTUVSSUMpDQogICkgVEhFTg0KICAgIFJBSVNFIEVYQ0VQVElPTiAnbGxtX21vZGVsX2NhdGFsb2cgY29udGFpbnMgaW52YWxpZCBQUkQgdGllciBmaWVsZHMnIFVTSU5HIEVSUkNPREUgPSAnMjIwMjMnOw0KICBFTkQgSUY7DQoNCiAgSUYgRVhJU1RTICgNCiAgICBTRUxFQ1QgMQ0KICAgIEZST00ganNvbmJfYXJyYXlfZWxlbWVudHMocF92YWx1ZSAtPiAndGllcnMnKSBBUyB0aWVyDQogICAgQ1JPU1MgSk9JTiBMQVRFUkFMIGpzb25iX2FycmF5X2VsZW1lbnRzKHRpZXIgLT4gJ21vZGVscycpIEFTIG1vZGVsDQogICAgV0hFUkUgQ09BTEVTQ0UobW9kZWwgLT4+ICdpZCcsICcnKSAhfiAnXlthLXowLTldKFthLXowLTkuXy1dKlthLXowLTldKT8kJw0KICAgICAgT1IgY2hhcl9sZW5ndGgobW9kZWwgLT4+ICdpZCcpID4gNjQNCiAgICAgIE9SIENPQUxFU0NFKG1vZGVsIC0+PiAncHJvdmlkZXJfbW9kZWxfaWQnLCAnJykgIX4gJ15bXls6c3BhY2U6XV0rJCcNCiAgICAgIE9SIGNoYXJfbGVuZ3RoKG1vZGVsIC0+PiAncHJvdmlkZXJfbW9kZWxfaWQnKSA+IDIwMA0KICAgICAgT1IgbW9kZWwgLT4+ICdvcGVucm91dGVyX21vZGVsX2lkJyA8PiBtb2RlbCAtPj4gJ3Byb3ZpZGVyX21vZGVsX2lkJw0KICAgICAgT1IgQ09BTEVTQ0UoY2hhcl9sZW5ndGgodHJpbShtb2RlbCAtPj4gJ2Rpc3BsYXlfbmFtZScpKSwgMCkgTk9UIEJFVFdFRU4gMSBBTkQgNDANCiAgICAgIE9SIENPQUxFU0NFKGNoYXJfbGVuZ3RoKHRyaW0obW9kZWwgLT4+ICd0YWdsaW5lJykpLCAwKSBOT1QgQkVUV0VFTiAxIEFORCA0MA0KICAgICAgT1IganNvbmJfdHlwZW9mKG1vZGVsIC0+ICdpc19mcmVlJykgSVMgRElTVElOQ1QgRlJPTSAnYm9vbGVhbicNCiAgICAgIE9SIG1vZGVsID8gJ21hcmt1cCcNCiAgICAgIE9SIG1vZGVsID8gJ2RlZHVjdF9tYXJrdXAnDQogICAgICBPUiAobW9kZWwgLT4+ICdzb3J0X29yZGVyJyk6Ok5VTUVSSUMgPCAwDQogICAgICBPUiAobW9kZWwgLT4+ICdzb3J0X29yZGVyJyk6Ok5VTUVSSUMgPD4gdHJ1bmMoKG1vZGVsIC0+PiAnc29ydF9vcmRlcicpOjpOVU1FUklDKQ0KICApIFRIRU4NCiAgICBSQUlTRSBFWENFUFRJT04gJ2xsbV9tb2RlbF9jYXRhbG9nIGNvbnRhaW5zIGludmFsaWQgUFJEIG1vZGVsIGZpZWxkcycgVVNJTkcgRVJSQ09ERSA9ICcyMjAyMyc7DQogIEVORCBJRjsNCg0KICBJRiAoU0VMRUNUIGNvdW50KCopIDw+IGNvdW50KERJU1RJTkNUIGNvbmNhdChtb2RlbCAtPj4gJ3Byb3ZpZGVyJywgRSdceDFmJywgbW9kZWwgLT4+ICdwcm92aWRlcl9tb2RlbF9pZCcpKQ0KICAgICAgRlJPTSBqc29uYl9hcnJheV9lbGVtZW50cyhwX3ZhbHVlIC0+ICd0aWVycycpIEFTIHRpZXINCiAgICAgIENST1NTIEpPSU4gTEFURVJBTCBqc29uYl9hcnJheV9lbGVtZW50cyh0aWVyIC0+ICdtb2RlbHMnKSBBUyBtb2RlbCkgVEhFTg0KICAgIFJBSVNFIEVYQ0VQVElPTiAnbGxtX21vZGVsX2NhdGFsb2cgcHJvdmlkZXIgbWFwcGluZ3MgbXVzdCBiZSB1bmlxdWUnIFVTSU5HIEVSUkNPREUgPSAnMjIwMjMnOw0KICBFTkQgSUY7DQpFTkQ7DQo='
DEDUCTION_B64='CkJFR0lOCiAgSUYgcF92YWx1ZSBJUyBOVUxMCiAgICAgT1IganNvbmJfdHlwZW9mKHBfdmFsdWUpIElTIERJU1RJTkNUIEZST00gJ29iamVjdCcKICAgICBPUiBqc29uYl90eXBlb2YocF92YWx1ZSAtPiAnZml4ZWREZWR1Y3Rpb24nKSBJUyBESVNUSU5DVCBGUk9NICdvYmplY3QnCiAgICAgT1IganNvbmJfdHlwZW9mKHBfdmFsdWUgLT4gJ2ZpeGVkRGVkdWN0aW9uJyAtPiAnZnJlZVF1b3RhRXhoYXVzdGVkJykKICAgICAgICBJUyBESVNUSU5DVCBGUk9NICdudW1iZXInCiAgICAgT1IganNvbmJfdHlwZW9mKHBfdmFsdWUgLT4gJ2ZpeGVkRGVkdWN0aW9uJyAtPiAnbGlnaHQnKSBJUyBESVNUSU5DVCBGUk9NICdudW1iZXInCiAgICAgT1IganNvbmJfdHlwZW9mKHBfdmFsdWUgLT4gJ2ZpeGVkRGVkdWN0aW9uJyAtPiAnc3RhbmRhcmQnKSBJUyBESVNUSU5DVCBGUk9NICdudW1iZXInCiAgICAgT1IganNvbmJfdHlwZW9mKHBfdmFsdWUgLT4gJ2ZpeGVkRGVkdWN0aW9uJyAtPiAncHJlbWl1bScpIElTIERJU1RJTkNUIEZST00gJ251bWJlcicKICAgICBPUiAocF92YWx1ZSAjPj4gJ3tmaXhlZERlZHVjdGlvbixmcmVlUXVvdGFFeGhhdXN0ZWR9Jyk6Ok5VTUVSSUMgPCAwCiAgICAgT1IgKHBfdmFsdWUgIz4+ICd7Zml4ZWREZWR1Y3Rpb24sbGlnaHR9Jyk6Ok5VTUVSSUMgPCAwCiAgICAgT1IgKHBfdmFsdWUgIz4+ICd7Zml4ZWREZWR1Y3Rpb24sc3RhbmRhcmR9Jyk6Ok5VTUVSSUMgPCAwCiAgICAgT1IgKHBfdmFsdWUgIz4+ICd7Zml4ZWREZWR1Y3Rpb24scHJlbWl1bX0nKTo6TlVNRVJJQyA8IDAgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OCiAgICAgICdsbG1fcHJpY2luZ19jb25maWcuZml4ZWREZWR1Y3Rpb24gbXVzdCBpbmNsdWRlIG5vbm5lZ2F0aXZlIGZyZWVRdW90YUV4aGF1c3RlZCwgbGlnaHQsIHN0YW5kYXJkIGFuZCBwcmVtaXVtIGFtb3VudHMnCiAgICAgIFVTSU5HIEVSUkNPREUgPSAnMjIwMjMnOwogIEVORCBJRjsKRU5EOwo='
setup() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS admin, app_core CASCADE;
CREATE SCHEMA admin; CREATE SCHEMA app_core;
CREATE TABLE app_core.runtime_config (key text PRIMARY KEY, value jsonb);
CREATE FUNCTION admin.validate_model_catalog_first_token(p_value jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE
  SET search_path TO 'pg_catalog' AS $$ BEGIN RETURN; END $$;
SQL
  { printf '%s' "CREATE FUNCTION admin.validate_model_catalog_prd(p_value jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path TO 'pg_catalog' AS \$prodfn\$"
    echo "$CATALOG_B64" | base64 -d
    printf '%s\n' '$prodfn$;'
    printf '%s' "CREATE FUNCTION admin.validate_fixed_llm_deduction_config(p_value jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path TO 'pg_catalog' AS \$prodfn\$"
    echo "$DEDUCTION_B64" | base64 -d
    printf '%s\n' '$prodfn$;'; } | psql_f >/dev/null
  psql_f >/dev/null <<'SQL'
INSERT INTO app_core.runtime_config VALUES
  ('llm_model_catalog', '{"version":3,"tiers":[{"tier":"light","label":"轻量","color":"#33AA77","cost_hint":"每轮约 1 星尘","sort_order":0,"models":[
     {"id":"flash","provider":"openrouter","provider_model_id":"deepseek/deepseek-v4-flash","openrouter_model_id":"deepseek/deepseek-v4-flash","display_name":"Flash","tagline":"快","is_free":false,"enabled":true,"sort_order":0},
     {"id":"lite","provider":"openrouter","provider_model_id":"google/gemini-3.1-flash-lite","openrouter_model_id":"google/gemini-3.1-flash-lite","display_name":"Lite","tagline":"省","is_free":false,"enabled":true,"sort_order":1}]},
   {"tier":"premium","label":"旗舰","color":"#AA3377","cost_hint":"每轮约 4 星尘","sort_order":1,"models":[
     {"id":"pro","provider":"openrouter","provider_model_id":"deepseek/deepseek-v4-pro-0813","openrouter_model_id":"deepseek/deepseek-v4-pro-0813","display_name":"Pro","tagline":"强","is_free":false,"enabled":true,"sort_order":0}]}]}'),
  ('llm_pricing_config', '{"version":2,"fixedDeduction":{"freeQuotaExhausted":10,"light":10,"standard":20,"premium":40}}');
SQL
}
rejects() { # label; SQL on stdin must raise 22023
  if out=$(psql_f 2>&1); then echo "FAIL: $1 should be rejected"; exit 1; fi
  [[ "$out" == *'must include'* || "$out" == *'invalid PRD model fields'* ]] || { echo "FAIL: $1: $out"; exit 1; }
  echo "ok: $1"
}

setup
check 'fixtures are the production bodies' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['af932ea8af0a02e9097cf766c64bc588', 'f0afd5fcef7d2222759de9dec2e8a1d4']
FROM pg_proc WHERE proname IN ('validate_model_catalog_prd', 'validate_fixed_llm_deduction_config');
SQL
rejects 'before: catalog without is_free is rejected' <<'SQL'
SELECT admin.validate_model_catalog_prd((SELECT value FROM app_core.runtime_config WHERE key = 'llm_model_catalog') #- '{tiers,0,models,0,is_free}');
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'2 validators now accept configs without is_free / freeQuotaExhausted'* && "$out" == *'both validate'* ]] ||
  { echo "FAIL: apply: $out"; exit 1; }
echo 'ok: patched and self-checked'
check 'patched bodies have the expected md5' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['dfb67c2f26afa5b1af2f8d085f5127fd', '8972ef63bed8d90960ad8ea56a219995']
FROM pg_proc WHERE proname IN ('validate_model_catalog_prd', 'validate_fixed_llm_deduction_config');
SQL
check 'catalog and pricing without the free-model fields validate' <<'SQL'
DO $$ BEGIN
  PERFORM admin.validate_model_catalog_prd((SELECT value FROM app_core.runtime_config WHERE key = 'llm_model_catalog') #- '{tiers,0,models,0,is_free}');
  PERFORM admin.validate_fixed_llm_deduction_config('{"fixedDeduction":{"light":10,"standard":20,"premium":40}}');
END $$;
SELECT true;
SQL
rejects 'non-boolean is_free still rejected' <<'SQL'
SELECT admin.validate_model_catalog_prd(jsonb_set((SELECT value FROM app_core.runtime_config WHERE key = 'llm_model_catalog'), '{tiers,0,models,0,is_free}', '1'));
SQL
rejects 'negative freeQuotaExhausted still rejected' <<'SQL'
SELECT admin.validate_fixed_llm_deduction_config('{"fixedDeduction":{"freeQuotaExhausted":-1,"light":10,"standard":20,"premium":40}}');
SQL
rejects 'missing light still rejected' <<'SQL'
SELECT admin.validate_fixed_llm_deduction_config('{"fixedDeduction":{"standard":20,"premium":40}}');
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'0 validators now accept'* ]] || { echo "FAIL: rerun: $out"; exit 1; }
echo 'ok: rerun is a no-op'
setup
psql_f -c "CREATE OR REPLACE FUNCTION admin.validate_fixed_llm_deduction_config(p_value jsonb) RETURNS void LANGUAGE plpgsql IMMUTABLE AS \$\$ BEGIN RETURN; END \$\$" >/dev/null
if out=$(psql_f <"$migration" 2>&1); then echo "FAIL: drifted body should be refused"; exit 1; fi
[[ "$out" == *'drifted (md5'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
check 'refusal left the catalog validator untouched' <<'SQL'
SELECT md5(prosrc) = 'f0afd5fcef7d2222759de9dec2e8a1d4' FROM pg_proc WHERE proname = 'validate_model_catalog_prd';
SQL
echo 'all checks passed'
