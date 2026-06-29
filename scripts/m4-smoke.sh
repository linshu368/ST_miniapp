#!/usr/bin/env bash
set -euo pipefail

# M4 smoke test — drives the whole stack through the nginx gateway (host:8080).
# Every path below is DERIVED FROM ops/nginx/nginx.conf location blocks:
#
#   /                    -> `location /`              -> upstream frontend (catch-all)
#   /api/payment/plans   -> `location ^~ /api/payment/` -> upstream backend
#                           (no-auth route; falls back to default plans when
#                            Supabase is unreachable, so it returns 200 even with
#                            placeholder creds — backend's own /health is NOT proxied)
#   /tavern/             -> `location = /tavern/`       -> upstream st (proxy_pass http://st/)
#   /provision-api/health-> `location ^~ /provision-api/` -> upstream provision
#                           (proxy_pass http://provision/ strips the prefix ->
#                            st-backend:9091/health)
#
# curl -f exits non-zero on HTTP >= 400; 2xx/3xx pass (set -e then fails the script).

BASE=http://localhost:8080

curl -fsS -o /dev/null -w "frontend   /                      %{http_code}\n" "$BASE/"
curl -fsS -o /dev/null -w "backend    /api/payment/plans     %{http_code}\n" "$BASE/api/payment/plans"
curl -fsS -o /dev/null -w "st         /tavern/               %{http_code}\n" "$BASE/tavern/"
curl -fsS -o /dev/null -w "provision  /provision-api/health  %{http_code}\n" "$BASE/provision-api/health"

echo "OK"
