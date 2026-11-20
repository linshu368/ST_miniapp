#!/usr/bin/env bash
# Disposable PG17 only. No remote URI, host ports or real user data.
# Verifies 20261120_db_reorg_p6a3_voice_latency_contract.sql as a NON-superuser:
# - fixtures are the production bodies of billing.charge_voice_usage / settle_voice_generation (md5 checked);
# - while the backend still writes latency_ms (recent rows) the functions are patched but the column is kept;
# - after the writes stop the column is dropped; the patched functions give the same outcome as the originals
#   (paid via settle, paid via charge, free trial, invalid free trial: status, charge, wallet, ledger);
# - md5s after the patch; rerun is a no-op; a drifted function is refused and the column kept.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
migration="$task_root/packages/shared/migrations/20261120_db_reorg_p6a3_voice_latency_contract.sql"
task_container="st-db-reorg-p6a3-${RANDOM}-$$"
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
# production definitions (base64: charge_voice_usage keeps its CRLF line endings)
CHARGE_DEF_B64='Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gYmlsbGluZy5jaGFyZ2Vfdm9pY2VfdXNhZ2UocF9jaGFyZ2Vfa2V5IHV1aWQsIHBfdXNlcl9pZCB1dWlkLCBwX2F1ZGlvX2lkIHV1aWQsIHBfYW1vdW50IG51bWVyaWMsIHBfbWV0YWRhdGEganNvbmIgREVGQVVMVCAne30nOjpqc29uYikKIFJFVFVSTlMganNvbmIKIExBTkdVQUdFIHBscGdzcWwKIFNFQ1VSSVRZIERFRklORVIKIFNFVCBzZWFyY2hfcGF0aCBUTyAncGdfY2F0YWxvZycKQVMgJGZ1bmN0aW9uJA0KREVDTEFSRQ0KICB2X2F1ZGlvIGV4cGVyaWVuY2UuY2hhdF9tZXNzYWdlX2F1ZGlvOw0KICB2X3dhbGxldCBiaWxsaW5nLnVzZXJfd2FsbGV0czsNCiAgdl9hbW91bnQgTlVNRVJJQygxNCwxKSA6PSByb3VuZChHUkVBVEVTVChDT0FMRVNDRShwX2Ftb3VudCwgMCksIDApLCAxKTsNCiAgdl9hdmFpbGFibGUgTlVNRVJJQygxNCwxKTsNCiAgdl9ib251cyBOVU1FUklDKDE0LDEpOw0KICB2X21haW4gTlVNRVJJQygxNCwxKTsNCiAgdl9sZWRnZXIgVVVJRDsNCkJFR0lODQogIElGIHBfY2hhcmdlX2tleSBJUyBOVUxMIE9SIHBfYXVkaW9faWQgSVMgTlVMTCBPUiBwX2NoYXJnZV9rZXkgPD4gcF9hdWRpb19pZA0KICAgICBPUiBwX3VzZXJfaWQgSVMgTlVMTCBPUiB2X2Ftb3VudCA8PSAwIFRIRU4NCiAgICBSQUlTRSBFWENFUFRJT04gJ2ludmFsaWQgdm9pY2UgdXNhZ2UgY2hhcmdlIGlucHV0JyBVU0lORyBFUlJDT0RFID0gJzIyMDIzJzsNCiAgRU5EIElGOw0KDQogIFNFTEVDVCAqIElOVE8gdl9hdWRpbyBGUk9NIGV4cGVyaWVuY2UuY2hhdF9tZXNzYWdlX2F1ZGlvDQogIFdIRVJFIGlkID0gcF9hdWRpb19pZCBGT1IgVVBEQVRFOw0KICBJRiBOT1QgRk9VTkQgT1Igdl9hdWRpby51c2VyX2lkIDw+IHBfdXNlcl9pZCBUSEVODQogICAgUkFJU0UgRVhDRVBUSU9OICd2b2ljZSBhdHRlbXB0IG5vdCBmb3VuZCBvciBvd25lciBtaXNtYXRjaCcgVVNJTkcgRVJSQ09ERSA9ICc0MjUwMSc7DQogIEVORCBJRjsNCiAgSUYgdl9hdWRpby5kZWJpdF9sZWRnZXJfaWQgSVMgTk9UIE5VTEwgVEhFTg0KICAgIFNFTEVDVCAqIElOVE8gdl93YWxsZXQgRlJPTSBiaWxsaW5nLnVzZXJfd2FsbGV0cyBXSEVSRSB1c2VyX2lkID0gcF91c2VyX2lkOw0KICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoJ2NoYXJnZV9zdGF0dXMnLCdhbHJlYWR5X2NoYXJnZWQnLCd3YWxsZXQnLHRvX2pzb25iKHZfd2FsbGV0KSwNCiAgICAgICdsZWRnZXJfaWQnLHZfYXVkaW8uZGViaXRfbGVkZ2VyX2lkKTsNCiAgRU5EIElGOw0KICBJRiB2X2F1ZGlvLnN0YXR1cyA8PiAncGVuZGluZycgVEhFTg0KICAgIFJBSVNFIEVYQ0VQVElPTiAndm9pY2UgYXR0ZW1wdCBpcyBub3QgcGVuZGluZycgVVNJTkcgRVJSQ09ERSA9ICc1NTAwMCc7DQogIEVORCBJRjsNCg0KICBJTlNFUlQgSU5UTyBiaWxsaW5nLnVzZXJfd2FsbGV0cyh1c2VyX2lkKSBWQUxVRVMocF91c2VyX2lkKSBPTiBDT05GTElDVCh1c2VyX2lkKSBETyBOT1RISU5HOw0KICBTRUxFQ1QgKiBJTlRPIHZfd2FsbGV0IEZST00gYmlsbGluZy51c2VyX3dhbGxldHMgV0hFUkUgdXNlcl9pZCA9IHBfdXNlcl9pZCBGT1IgVVBEQVRFOw0KICB2X2F2YWlsYWJsZSA6PSB2X3dhbGxldC5tYWluX2NyZWRpdHMgKyB2X3dhbGxldC5ib251c19jcmVkaXRzOw0KICBJRiB2X2F2YWlsYWJsZSA8IHZfYW1vdW50IFRIRU4NCiAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdjaGFyZ2Vfc3RhdHVzJywnaW5zdWZmaWNpZW50X2JhbGFuY2UnLCd3YWxsZXQnLHRvX2pzb25iKHZfd2FsbGV0KSwNCiAgICAgICdyZXF1aXJlZCcsdl9hbW91bnQsJ2F2YWlsYWJsZScsdl9hdmFpbGFibGUpOw0KICBFTkQgSUY7DQoNCiAgdl9ib251cyA6PSBMRUFTVCh2X3dhbGxldC5ib251c19jcmVkaXRzLCB2X2Ftb3VudCk7DQogIHZfbWFpbiA6PSB2X2Ftb3VudCAtIHZfYm9udXM7DQogIFVQREFURSBiaWxsaW5nLnVzZXJfd2FsbGV0cyBTRVQgYm9udXNfY3JlZGl0cz1ib251c19jcmVkaXRzLXZfYm9udXMsDQogICAgbWFpbl9jcmVkaXRzPW1haW5fY3JlZGl0cy12X21haW4sIHVwZGF0ZWRfYXQ9bm93KCkNCiAgV0hFUkUgdXNlcl9pZD1wX3VzZXJfaWQgUkVUVVJOSU5HICogSU5UTyB2X3dhbGxldDsNCg0KICBJTlNFUlQgSU5UTyBiaWxsaW5nLndhbGxldF9sZWRnZXIodXNlcl9pZCxlbnRyeV90eXBlLGFtb3VudCxtYWluX2RlbHRhLGJvbnVzX2RlbHRhLA0KICAgIGJhbGFuY2VfbWFpbixiYWxhbmNlX2JvbnVzLHJlZmVyZW5jZV90eXBlLHJlZmVyZW5jZV9pZCxtZXRhZGF0YSkNCiAgVkFMVUVTKHBfdXNlcl9pZCwnY2hhdF9kZWJpdCcsLXZfYW1vdW50LC12X21haW4sLXZfYm9udXMsdl93YWxsZXQubWFpbl9jcmVkaXRzLA0KICAgIHZfd2FsbGV0LmJvbnVzX2NyZWRpdHMsJ3ZvaWNlX3VzYWdlJyxwX2F1ZGlvX2lkOjpURVhULENPQUxFU0NFKHBfbWV0YWRhdGEsJ3t9Jzo6SlNPTkIpKQ0KICBSRVRVUk5JTkcgaWQgSU5UTyB2X2xlZGdlcjsNCg0KICBVUERBVEUgZXhwZXJpZW5jZS5jaGF0X21lc3NhZ2VfYXVkaW8gU0VUIGlzX2FjdGl2ZT1mYWxzZSwgdXBkYXRlZF9hdD1ub3coKQ0KICBXSEVSRSBtZXNzYWdlX2lkPXZfYXVkaW8ubWVzc2FnZV9pZCBBTkQgaXNfYWN0aXZlPXRydWUgQU5EIGlkPD5wX2F1ZGlvX2lkOw0KDQogIFVQREFURSBleHBlcmllbmNlLmNoYXRfbWVzc2FnZV9hdWRpbyBTRVQgc3RhdHVzPSdyZWFkeScsIGlzX2FjdGl2ZT10cnVlLA0KICAgIC0tIG1ldGFkYXRhIOe8uuWtl+auteaIluaYvuW8j+S8oCBKU09OIG51bGwg5pe25LiN5b6X5riF56m65YmN5bqP6Zi25q615bey57uP6JC95bqT55qE57uT5p6c44CCDQogICAgc3Bva2VuX3RleHQ9Q09BTEVTQ0UocF9tZXRhZGF0YS0+PidzcG9rZW5fdGV4dCcsIHNwb2tlbl90ZXh0KSwNCiAgICBzcG9rZW5fY2hhcnM9Y2hhcl9sZW5ndGgoQ09BTEVTQ0UocF9tZXRhZGF0YS0+PidzcG9rZW5fdGV4dCcsIHNwb2tlbl90ZXh0LCAnJykpLA0KICAgIHN0b3JhZ2VfcGF0aD1DT0FMRVNDRShwX21ldGFkYXRhLT4+J3N0b3JhZ2VfcGF0aCcsIHN0b3JhZ2VfcGF0aCksDQogICAgYXVkaW9fdXJsPUNPQUxFU0NFKHBfbWV0YWRhdGEtPj4nYXVkaW9fdXJsJywgYXVkaW9fdXJsKSwNCiAgICBkdXJhdGlvbl9tcz1DT0FMRVNDRShOVUxMSUYocF9tZXRhZGF0YS0+PidkdXJhdGlvbl9tcycsJycpOjpJTlRFR0VSLCBkdXJhdGlvbl9tcyksDQogICAgbGF0ZW5jeV9tcz1DT0FMRVNDRShOVUxMSUYocF9tZXRhZGF0YS0+PidsYXRlbmN5X21zJywnJyk6OklOVEVHRVIsIGxhdGVuY3lfbXMpLCBlcnJvcl9jb2RlPU5VTEwsDQogICAgY3JlZGl0c19jaGFyZ2VkPXZfYW1vdW50LCBkZWJpdF9sZWRnZXJfaWQ9dl9sZWRnZXIsIGNoYXJnZWRfYXQ9bm93KCksIHVwZGF0ZWRfYXQ9bm93KCkNCiAgV0hFUkUgaWQ9cF9hdWRpb19pZDsNCg0KICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KCdjaGFyZ2Vfc3RhdHVzJywnY2hhcmdlZCcsJ3dhbGxldCcsdG9fanNvbmIodl93YWxsZXQpLCdsZWRnZXJfaWQnLHZfbGVkZ2VyKTsNCkVORDsNCiRmdW5jdGlvbiQK'
SETTLE_DEF_B64='Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gYmlsbGluZy5zZXR0bGVfdm9pY2VfZ2VuZXJhdGlvbihwX2F1ZGlvX2lkIHV1aWQsIHBfdXNlcl9pZCB1dWlkLCBwX2Ftb3VudCBudW1lcmljLCBwX21ldGFkYXRhIGpzb25iIERFRkFVTFQgJ3t9Jzo6anNvbmIpCiBSRVRVUk5TIGpzb25iCiBMQU5HVUFHRSBwbHBnc3FsCiBTRUNVUklUWSBERUZJTkVSCiBTRVQgc2VhcmNoX3BhdGggVE8gJ3BnX2NhdGFsb2cnCkFTICRmdW5jdGlvbiQKREVDTEFSRQogIHZfYXVkaW8gZXhwZXJpZW5jZS5jaGF0X21lc3NhZ2VfYXVkaW8lUk9XVFlQRTsKICB2X3dhbGxldCBiaWxsaW5nLnVzZXJfd2FsbGV0cyVST1dUWVBFOwogIHZfYW1vdW50IE5VTUVSSUMoMTQsMSkgOj0gcm91bmQoR1JFQVRFU1QoQ09BTEVTQ0UocF9hbW91bnQsIDApLCAwKSwgMSk7CiAgdl9kZWJpdCBKU09OQjsKICB2X3RyaWFsIEpTT05COwogIHZfbGVkZ2VyIFVVSUQ7CkJFR0lOCiAgSUYgcF9hdWRpb19pZCBJUyBOVUxMIE9SIHBfdXNlcl9pZCBJUyBOVUxMIE9SIHZfYW1vdW50IDw9IDAgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdpbnZhbGlkIHZvaWNlIHNldHRsZW1lbnQgaW5wdXQnIFVTSU5HIEVSUkNPREUgPSAnMjIwMjMnOwogIEVORCBJRjsKCiAgU0VMRUNUICogSU5UTyB2X2F1ZGlvCiAgRlJPTSBleHBlcmllbmNlLmNoYXRfbWVzc2FnZV9hdWRpbwogIFdIRVJFIGlkID0gcF9hdWRpb19pZAogIEZPUiBVUERBVEU7CgogIElGIE5PVCBGT1VORCBPUiB2X2F1ZGlvLnVzZXJfaWQgPD4gcF91c2VyX2lkIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAndm9pY2UgYXR0ZW1wdCBub3QgZm91bmQgb3Igb3duZXIgbWlzbWF0Y2gnIFVTSU5HIEVSUkNPREUgPSAnNDI1MDEnOwogIEVORCBJRjsKCiAgSU5TRVJUIElOVE8gYmlsbGluZy51c2VyX3dhbGxldHModXNlcl9pZCkKICBWQUxVRVMgKHBfdXNlcl9pZCkKICBPTiBDT05GTElDVCh1c2VyX2lkKSBETyBOT1RISU5HOwoKICBJRiB2X2F1ZGlvLnN0YXR1cyA9ICdyZWFkeScgVEhFTgogICAgU0VMRUNUICogSU5UTyB2X3dhbGxldCBGUk9NIGJpbGxpbmcudXNlcl93YWxsZXRzIFdIRVJFIHVzZXJfaWQgPSBwX3VzZXJfaWQ7CiAgICBJRiB2X2F1ZGlvLmJpbGxpbmdfbW9kZSA9ICdmcmVlX3RyaWFsJyBUSEVOCiAgICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoCiAgICAgICAgJ2NoYXJnZV9zdGF0dXMnLCAnYWxyZWFkeV9mcmVlX3RyaWFsX2NvbnN1bWVkJywKICAgICAgICAnd2FsbGV0JywgdG9fanNvbmIodl93YWxsZXQpLAogICAgICAgICdsZWRnZXJfaWQnLCBOVUxMCiAgICAgICk7CiAgICBFTkQgSUY7CiAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KAogICAgICAnY2hhcmdlX3N0YXR1cycsICdhbHJlYWR5X2NoYXJnZWQnLAogICAgICAnd2FsbGV0JywgdG9fanNvbmIodl93YWxsZXQpLAogICAgICAnbGVkZ2VyX2lkJywgdl9hdWRpby5kZWJpdF9sZWRnZXJfaWQKICAgICk7CiAgRU5EIElGOwoKICBJRiB2X2F1ZGlvLnN0YXR1cyA8PiAncGVuZGluZycgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICd2b2ljZSBhdHRlbXB0IGlzIG5vdCBwZW5kaW5nJyBVU0lORyBFUlJDT0RFID0gJzU1MDAwJzsKICBFTkQgSUY7CgogIElGIHZfYXVkaW8uYmlsbGluZ19tb2RlID0gJ2ZyZWVfdHJpYWwnIFRIRU4KICAgIHZfdHJpYWwgOj0gYmlsbGluZy5jb25zdW1lX2ZlYXR1cmVfZnJlZV90cmlhbChwX3VzZXJfaWQsICd2b2ljZScsIHBfYXVkaW9faWQ6OnRleHQpOwogICAgSUYgQ09BTEVTQ0UoKHZfdHJpYWwgLT4+ICdvaycpOjpib29sZWFuLCBmYWxzZSkgSVMgTk9UIFRSVUUgVEhFTgogICAgICBVUERBVEUgZXhwZXJpZW5jZS5jaGF0X21lc3NhZ2VfYXVkaW8KICAgICAgU0VUIHN0YXR1cyA9ICdmYWlsZWQnLAogICAgICAgICAgZXJyb3JfY29kZSA9ICd2b2ljZV9mcmVlX3RyaWFsX2ludmFsaWQnLAogICAgICAgICAgbGF0ZW5jeV9tcyA9IENPQUxFU0NFKE5VTExJRihwX21ldGFkYXRhIC0+PiAnbGF0ZW5jeV9tcycsICcnKTo6aW50ZWdlciwgbGF0ZW5jeV9tcyksCiAgICAgICAgICB1cGRhdGVkX2F0ID0gbm93KCkKICAgICAgV0hFUkUgaWQgPSBwX2F1ZGlvX2lkOwogICAgICBTRUxFQ1QgKiBJTlRPIHZfd2FsbGV0IEZST00gYmlsbGluZy51c2VyX3dhbGxldHMgV0hFUkUgdXNlcl9pZCA9IHBfdXNlcl9pZDsKICAgICAgUkVUVVJOIGpzb25iX2J1aWxkX29iamVjdCgKICAgICAgICAnY2hhcmdlX3N0YXR1cycsICdmcmVlX3RyaWFsX2ludmFsaWQnLAogICAgICAgICd3YWxsZXQnLCB0b19qc29uYih2X3dhbGxldCkKICAgICAgKTsKICAgIEVORCBJRjsKCiAgICBVUERBVEUgZXhwZXJpZW5jZS5jaGF0X21lc3NhZ2VfYXVkaW8KICAgIFNFVCBpc19hY3RpdmUgPSBmYWxzZSwKICAgICAgICB1cGRhdGVkX2F0ID0gbm93KCkKICAgIFdIRVJFIG1lc3NhZ2VfaWQgPSB2X2F1ZGlvLm1lc3NhZ2VfaWQKICAgICAgQU5EIGlzX2FjdGl2ZSA9IHRydWUKICAgICAgQU5EIGlkIDw+IHBfYXVkaW9faWQ7CgogICAgVVBEQVRFIGV4cGVyaWVuY2UuY2hhdF9tZXNzYWdlX2F1ZGlvCiAgICBTRVQgc3RhdHVzID0gJ3JlYWR5JywKICAgICAgICBpc19hY3RpdmUgPSB0cnVlLAogICAgICAgIHNwb2tlbl90ZXh0ID0gQ09BTEVTQ0UocF9tZXRhZGF0YSAtPj4gJ3Nwb2tlbl90ZXh0Jywgc3Bva2VuX3RleHQpLAogICAgICAgIHNwb2tlbl9jaGFycyA9IGNoYXJfbGVuZ3RoKENPQUxFU0NFKHBfbWV0YWRhdGEgLT4+ICdzcG9rZW5fdGV4dCcsIHNwb2tlbl90ZXh0LCAnJykpLAogICAgICAgIHN0b3JhZ2VfcGF0aCA9IENPQUxFU0NFKHBfbWV0YWRhdGEgLT4+ICdzdG9yYWdlX3BhdGgnLCBzdG9yYWdlX3BhdGgpLAogICAgICAgIGF1ZGlvX3VybCA9IENPQUxFU0NFKHBfbWV0YWRhdGEgLT4+ICdhdWRpb191cmwnLCBhdWRpb191cmwpLAogICAgICAgIGR1cmF0aW9uX21zID0gQ09BTEVTQ0UoTlVMTElGKHBfbWV0YWRhdGEgLT4+ICdkdXJhdGlvbl9tcycsICcnKTo6aW50ZWdlciwgZHVyYXRpb25fbXMpLAogICAgICAgIGxhdGVuY3lfbXMgPSBDT0FMRVNDRShOVUxMSUYocF9tZXRhZGF0YSAtPj4gJ2xhdGVuY3lfbXMnLCAnJyk6OmludGVnZXIsIGxhdGVuY3lfbXMpLAogICAgICAgIGVycm9yX2NvZGUgPSBOVUxMLAogICAgICAgIGNyZWRpdHNfY2hhcmdlZCA9IDAsCiAgICAgICAgZGViaXRfbGVkZ2VyX2lkID0gTlVMTCwKICAgICAgICBjaGFyZ2VkX2F0ID0gTlVMTCwKICAgICAgICB1cGRhdGVkX2F0ID0gbm93KCkKICAgIFdIRVJFIGlkID0gcF9hdWRpb19pZDsKCiAgICBTRUxFQ1QgKiBJTlRPIHZfd2FsbGV0IEZST00gYmlsbGluZy51c2VyX3dhbGxldHMgV0hFUkUgdXNlcl9pZCA9IHBfdXNlcl9pZDsKICAgIFJFVFVSTiBqc29uYl9idWlsZF9vYmplY3QoCiAgICAgICdjaGFyZ2Vfc3RhdHVzJywKICAgICAgQ0FTRSBXSEVOIHZfdHJpYWwgLT4+ICdzdGF0dXMnID0gJ2FscmVhZHlfY29uc3VtZWQnCiAgICAgICAgVEhFTiAnYWxyZWFkeV9mcmVlX3RyaWFsX2NvbnN1bWVkJwogICAgICAgIEVMU0UgJ2ZyZWVfdHJpYWxfY29uc3VtZWQnCiAgICAgIEVORCwKICAgICAgJ3dhbGxldCcsIHRvX2pzb25iKHZfd2FsbGV0KSwKICAgICAgJ2xlZGdlcl9pZCcsIE5VTEwKICAgICk7CiAgRU5EIElGOwoKICBCRUdJTgogICAgdl9kZWJpdCA6PSBiaWxsaW5nLmFwcGx5X3dhbGxldF9kZWJpdCgKICAgICAgcF91c2VyX2lkLAogICAgICBwX2F1ZGlvX2lkOjp0ZXh0LAogICAgICAnbWFpbl9vbmx5JywKICAgICAgdl9hbW91bnQsCiAgICAgICdjaGF0X2RlYml0JywKICAgICAgJ3ZvaWNlX3VzYWdlJywKICAgICAgcF9hdWRpb19pZDo6dGV4dCwKICAgICAgQ09BTEVTQ0UocF9tZXRhZGF0YSwgJ3t9Jzo6anNvbmIpCiAgICApOwogIEVYQ0VQVElPTiBXSEVOIFNRTFNUQVRFICdQMDAwMScgVEhFTgogICAgSUYgU1FMRVJSTSA9ICdNQUlOX0NSRURJVFNfSU5TVUZGSUNJRU5UJyBUSEVOCiAgICAgIFNFTEVDVCAqIElOVE8gdl93YWxsZXQgRlJPTSBiaWxsaW5nLnVzZXJfd2FsbGV0cyBXSEVSRSB1c2VyX2lkID0gcF91c2VyX2lkOwogICAgICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KAogICAgICAgICdjaGFyZ2Vfc3RhdHVzJywgJ2luc3VmZmljaWVudF9iYWxhbmNlJywKICAgICAgICAnd2FsbGV0JywgdG9fanNvbmIodl93YWxsZXQpLAogICAgICAgICdyZXF1aXJlZCcsIHZfYW1vdW50LAogICAgICAgICdhdmFpbGFibGUnLCBDT0FMRVNDRSh2X3dhbGxldC5tYWluX2NyZWRpdHMsIDApCiAgICAgICk7CiAgICBFTkQgSUY7CiAgICBSQUlTRTsKICBFTkQ7CgogIHZfbGVkZ2VyIDo9IE5VTExJRih2X2RlYml0IC0+PiAnbGVkZ2VyX2lkJywgJycpOjp1dWlkOwogIFNFTEVDVCAqIElOVE8gdl93YWxsZXQgRlJPTSBiaWxsaW5nLnVzZXJfd2FsbGV0cyBXSEVSRSB1c2VyX2lkID0gcF91c2VyX2lkOwoKICBVUERBVEUgZXhwZXJpZW5jZS5jaGF0X21lc3NhZ2VfYXVkaW8KICBTRVQgaXNfYWN0aXZlID0gZmFsc2UsCiAgICAgIHVwZGF0ZWRfYXQgPSBub3coKQogIFdIRVJFIG1lc3NhZ2VfaWQgPSB2X2F1ZGlvLm1lc3NhZ2VfaWQKICAgIEFORCBpc19hY3RpdmUgPSB0cnVlCiAgICBBTkQgaWQgPD4gcF9hdWRpb19pZDsKCiAgVVBEQVRFIGV4cGVyaWVuY2UuY2hhdF9tZXNzYWdlX2F1ZGlvCiAgU0VUIHN0YXR1cyA9ICdyZWFkeScsCiAgICAgIGlzX2FjdGl2ZSA9IHRydWUsCiAgICAgIHNwb2tlbl90ZXh0ID0gQ09BTEVTQ0UocF9tZXRhZGF0YSAtPj4gJ3Nwb2tlbl90ZXh0Jywgc3Bva2VuX3RleHQpLAogICAgICBzcG9rZW5fY2hhcnMgPSBjaGFyX2xlbmd0aChDT0FMRVNDRShwX21ldGFkYXRhIC0+PiAnc3Bva2VuX3RleHQnLCBzcG9rZW5fdGV4dCwgJycpKSwKICAgICAgc3RvcmFnZV9wYXRoID0gQ09BTEVTQ0UocF9tZXRhZGF0YSAtPj4gJ3N0b3JhZ2VfcGF0aCcsIHN0b3JhZ2VfcGF0aCksCiAgICAgIGF1ZGlvX3VybCA9IENPQUxFU0NFKHBfbWV0YWRhdGEgLT4+ICdhdWRpb191cmwnLCBhdWRpb191cmwpLAogICAgICBkdXJhdGlvbl9tcyA9IENPQUxFU0NFKE5VTExJRihwX21ldGFkYXRhIC0+PiAnZHVyYXRpb25fbXMnLCAnJyk6OmludGVnZXIsIGR1cmF0aW9uX21zKSwKICAgICAgbGF0ZW5jeV9tcyA9IENPQUxFU0NFKE5VTExJRihwX21ldGFkYXRhIC0+PiAnbGF0ZW5jeV9tcycsICcnKTo6aW50ZWdlciwgbGF0ZW5jeV9tcyksCiAgICAgIGVycm9yX2NvZGUgPSBOVUxMLAogICAgICBjcmVkaXRzX2NoYXJnZWQgPSB2X2Ftb3VudCwKICAgICAgZGViaXRfbGVkZ2VyX2lkID0gdl9sZWRnZXIsCiAgICAgIGNoYXJnZWRfYXQgPSBub3coKSwKICAgICAgdXBkYXRlZF9hdCA9IG5vdygpCiAgV0hFUkUgaWQgPSBwX2F1ZGlvX2lkOwoKICBSRVRVUk4ganNvbmJfYnVpbGRfb2JqZWN0KAogICAgJ2NoYXJnZV9zdGF0dXMnLAogICAgQ0FTRSBXSEVOIHZfZGViaXQgLT4+ICdzdGF0dXMnID0gJ2FscmVhZHlfZGViaXRlZCcKICAgICAgVEhFTiAnYWxyZWFkeV9jaGFyZ2VkJwogICAgICBFTFNFICdjaGFyZ2VkJwogICAgRU5ELAogICAgJ3dhbGxldCcsIHRvX2pzb25iKHZfd2FsbGV0KSwKICAgICdsZWRnZXJfaWQnLCB2X2xlZGdlcgogICk7CkVORDsKJGZ1bmN0aW9uJAo='
fixture() {
  psql_f >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS experience, billing CASCADE;
CREATE SCHEMA experience; CREATE SCHEMA billing;
CREATE TABLE experience.chat_message_audio (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, message_id uuid NOT NULL, status text NOT NULL, is_active boolean NOT NULL,
  debit_ledger_id uuid, billing_mode text, spoken_text text, spoken_chars integer, storage_path text, audio_url text,
  duration_ms integer, latency_ms integer, error_code text, credits_charged numeric NOT NULL DEFAULT 0, charged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.user_wallets (
  user_id uuid PRIMARY KEY, main_credits numeric(14,1) NOT NULL DEFAULT 0, bonus_credits numeric(14,1) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE billing.wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, entry_type text, amount numeric(14,1), main_delta numeric(14,1),
  bonus_delta numeric(14,1), balance_main numeric(14,1), balance_bonus numeric(14,1), reference_type text, reference_id text, metadata jsonb);
CREATE FUNCTION billing.apply_wallet_debit(p_user uuid, p_key text, p_mode text, p_amount numeric, p_entry text,
  p_ref_type text, p_ref_id text, p_meta jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE w billing.user_wallets; v uuid;
BEGIN
  SELECT * INTO w FROM billing.user_wallets WHERE user_id = p_user FOR UPDATE;
  IF w.main_credits < p_amount THEN RAISE EXCEPTION 'MAIN_CREDITS_INSUFFICIENT' USING ERRCODE = 'P0001'; END IF;
  UPDATE billing.user_wallets SET main_credits = main_credits - p_amount WHERE user_id = p_user RETURNING * INTO w;
  INSERT INTO billing.wallet_ledger (user_id, entry_type, amount, main_delta, bonus_delta, balance_main, balance_bonus, reference_type, reference_id, metadata)
  VALUES (p_user, p_entry, -p_amount, -p_amount, 0, w.main_credits, w.bonus_credits, p_ref_type, p_ref_id, p_meta) RETURNING id INTO v;
  RETURN jsonb_build_object('status', 'debited', 'ledger_id', v);
END $f$;
-- free trial: users whose id ends in 3 have none left
CREATE FUNCTION billing.consume_feature_free_trial(p_user uuid, p_feature text, p_key text) RETURNS jsonb LANGUAGE sql
  AS $f$ SELECT jsonb_build_object('ok', right(p_user::text, 1) <> '3', 'status', 'consumed') $f$;
-- two identical sets (A = original functions, B = patched): paid via settle, paid via charge, free trial, invalid free trial
INSERT INTO billing.user_wallets (user_id, main_credits, bonus_credits) VALUES
  ('00000000-0000-0000-00aa-000000000001', 100, 0), ('00000000-0000-0000-00aa-000000000002', 50, 10),
  ('00000000-0000-0000-00aa-000000000003', 0, 0),
  ('00000000-0000-0000-00bb-000000000001', 100, 0), ('00000000-0000-0000-00bb-000000000002', 50, 10),
  ('00000000-0000-0000-00bb-000000000003', 0, 0);
INSERT INTO experience.chat_message_audio (id, user_id, message_id, status, is_active, billing_mode)
SELECT ('00000000-0000-0000-' || s || '01-00000000000' || k)::uuid, ('00000000-0000-0000-00' || s || '-00000000000' || u)::uuid,
       ('00000000-0000-0000-' || s || '02-00000000000' || k)::uuid, 'pending', true, mode
FROM (VALUES ('aa'), ('bb')) AS sets(s),
     (VALUES (1, 1, 'paid'), (2, 2, 'paid'), (3, 1, 'free_trial'), (4, 3, 'free_trial')) AS r(k, u, mode);
SQL
  echo "$CHARGE_DEF_B64" | base64 -d | psql_f >/dev/null
  echo "$SETTLE_DEF_B64" | base64 -d | psql_f >/dev/null
}
run_set() { # $1 = aa | bb
  psql_f >/dev/null <<SQL
SELECT billing.settle_voice_generation('00000000-0000-0000-${1}01-000000000001', '00000000-0000-0000-00${1}-000000000001', 15,
  '{"spoken_text":"hello","duration_ms":"900","latency_ms":"1234","storage_path":"p1","audio_url":"u1"}');
SELECT billing.charge_voice_usage('00000000-0000-0000-${1}01-000000000002', '00000000-0000-0000-00${1}-000000000002',
  '00000000-0000-0000-${1}01-000000000002', 15, '{"spoken_text":"hi","duration_ms":"700","latency_ms":"999"}');
SELECT billing.settle_voice_generation('00000000-0000-0000-${1}01-000000000003', '00000000-0000-0000-00${1}-000000000001', 15,
  '{"spoken_text":"free","latency_ms":"555"}');
SELECT billing.settle_voice_generation('00000000-0000-0000-${1}01-000000000004', '00000000-0000-0000-00${1}-000000000003', 15,
  '{"latency_ms":"777"}');
SQL
}
outcome() { # canonical outcome of a set, ids stripped of the set marker
  psql_f -At -c "SELECT string_agg(x, ' | ' ORDER BY x) FROM (
    SELECT right(id::text, 1) || ':' || status || ':' || COALESCE(error_code, '-') || ':' || credits_charged || ':' ||
           (debit_ledger_id IS NOT NULL) || ':' || is_active || ':' || COALESCE(spoken_text, '-') || ':' || COALESCE(duration_ms::text, '-') AS x
      FROM experience.chat_message_audio WHERE id::text LIKE '00000000-0000-0000-${1}01-%'
    UNION ALL
    SELECT 'w' || right(user_id::text, 1) || ':' || main_credits || ':' || bonus_credits FROM billing.user_wallets WHERE user_id::text LIKE '%-00${1}-%'
    UNION ALL
    SELECT 'l' || right(user_id::text, 1) || ':' || entry_type || ':' || amount || ':' || main_delta || ':' || bonus_delta || ':' || reference_type
      FROM billing.wallet_ledger WHERE user_id::text LIKE '%-00${1}-%') s"
}

fixture
check 'fixtures are the production bodies' <<'SQL'
SELECT array_agg(md5(prosrc) ORDER BY proname) = ARRAY['641552b7d5e3e89f51bb734233e2d637', '32795fc21cf7ff9b7e8d7eac0d2e1b70']
FROM pg_proc WHERE proname IN ('charge_voice_usage', 'settle_voice_generation');
SQL
run_set aa
before=$(outcome aa)
check 'original functions write latency_ms' <<'SQL'
SELECT count(*) = 4 FROM experience.chat_message_audio WHERE id::text LIKE '00000000-0000-0000-aa01-%' AND latency_ms IS NOT NULL;
SQL
if out=$(psql_f <"$migration" 2>&1); then echo 'FAIL: dropped while the backend still writes'; exit 1; fi
[[ "$out" == *'2 voice billing functions no longer write latency_ms'* && "$out" == *'release the backend first'* ]] ||
  { echo "FAIL: guard output: $out"; exit 1; }
check 'recent writes: functions patched, column kept' <<'SQL'
SELECT (SELECT array_agg(md5(prosrc) ORDER BY proname) FROM pg_proc WHERE proname IN ('charge_voice_usage', 'settle_voice_generation'))
       = ARRAY['aaf7970d3b2e76cfb35d9d15a67734fb', '44fa84e5e62252aaa672a828a3633a02']
  AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_message_audio'::regclass AND attname = 'latency_ms' AND NOT attisdropped);
SQL
psql_f -c "UPDATE experience.chat_message_audio SET updated_at = now() - interval '1 hour'" >/dev/null
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'0 voice billing functions'* && "$out" == *'chat_message_audio.latency_ms dropped'* ]] || { echo "FAIL: apply output: $out"; exit 1; }
echo 'ok: writes stopped: column dropped'
run_set bb
after=$(outcome bb)
[[ "$before" == "$after" && -n "$after" ]] || { echo "FAIL: outcomes differ"; echo "before: $before"; echo "after:  $after"; exit 1; }
echo 'ok: patched functions give the same status, charge, wallet and ledger on all four paths'
check 'no function references latency_ms; four paths really ran' <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_proc WHERE prosrc ~ '\mlatency_ms\M')
  AND (SELECT count(*) = 3 FROM experience.chat_message_audio WHERE id::text LIKE '00000000-0000-0000-bb01-%' AND status = 'ready')
  AND (SELECT count(*) = 2 FROM billing.wallet_ledger WHERE user_id::text LIKE '%-00bb-%');
SQL
out=$(psql_f <"$migration" 2>&1)
[[ "$out" == *'0 voice billing functions'* && "$out" == *'already dropped'* ]] || { echo "FAIL: rerun output: $out"; exit 1; }
echo 'ok: rerun is a no-op'

fixture
psql_f >/dev/null <<'SQL'
DO $d$ BEGIN
  EXECUTE replace(pg_get_functiondef('billing.charge_voice_usage(uuid,uuid,uuid,numeric,jsonb)'::regprocedure),
                  'invalid voice usage charge input', 'invalid voice usage charge input!');
END $d$;
SQL
if out=$(psql_f <"$migration" 2>&1); then echo 'FAIL: drifted function not refused'; exit 1; fi
[[ "$out" == *'drifted'* ]] || { echo "FAIL: drift message: $out"; exit 1; }
check 'refusal kept the column and the other function' <<'SQL'
SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'experience.chat_message_audio'::regclass AND attname = 'latency_ms' AND NOT attisdropped)
  AND (SELECT md5(prosrc) = '32795fc21cf7ff9b7e8d7eac0d2e1b70' FROM pg_proc WHERE proname = 'settle_voice_generation');
SQL
echo 'all checks passed'
