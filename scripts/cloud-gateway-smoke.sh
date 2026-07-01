#!/usr/bin/env bash
# 云网关回归冒烟：校验 nginx（或经 Vercel 边缘）对 ST/backend 各路径的转发是否正常。
# 用法：scripts/cloud-gateway-smoke.sh <domain>   # domain 不带 scheme，例如 nginx-xxx.up.railway.app
#
# 两类校验：
#   check       <path> <expect>  精确码匹配（稳定公开的静态资源 / 公共端点，期望恒为该码）
#   check_route <path>           路由可达：只要不是网关自身的 404/502/503/504/000 即通过
#                                （200/302/401/403 都算“已正确转发到上游、由上游决定状态”）
set -uo pipefail
DOMAIN="${1:?Usage: $0 <gateway-domain>（不带 https://）}"
FAIL=0

check() {
  local path="$1" expect="$2" code
  code=$(curl -so /dev/null -m 15 -w '%{http_code}' "https://${DOMAIN}${path}")
  if [ "$code" = "$expect" ]; then
    echo "✅ ${path} → ${code}"
  else
    echo "❌ ${path} → ${code} (expected ${expect})"
    FAIL=1
  fi
}

check_route() {
  local path="$1" code
  code=$(curl -so /dev/null -m 15 -w '%{http_code}' "https://${DOMAIN}${path}")
  case "$code" in
    404 | 502 | 503 | 504 | 000)
      echo "❌ ${path} → ${code} (网关未正确转发到上游)"
      FAIL=1
      ;;
    *)
      echo "✅ ${path} → ${code} (已转发到上游)"
      ;;
  esac
}

echo "== 目标网关: ${DOMAIN} =="

# 注：/nginx-health 是 nginx 内部健康端点，仅在直连 nginx 域名时可达；
# 经 Vercel 边缘不会被 rewrite（属正常 404），故不纳入本脚本。

# ST 公共静态资源 / 根文件（登录前即可取，期望恒 200）
check       "/csrf-token"    "200"
check       "/script.js"     "200"
check       "/style.css"     "200"
check       "/lib.js"        "200"
check       "/favicon.ico"   "200"
check       "/manifest.json" "200"
check       "/login.html"    "200"

# ST 鉴权 / 重定向类端点：只校验“网关已正确转发到 ST”
check_route "/version"       # 未登录 → 403
check_route "/tavern"        # 未登录 → 302 → /login
check_route "/tavern/"
check_route "/login"         # ST 302 的落点；网关须能转发到 ST（不能 404）

# backend 平台 API（本环境 MOCK/bypass 下公开）
check       "/api/characters" "200"

if [ "$FAIL" -eq 0 ]; then
  echo "🎉 全部通过"
else
  echo "⚠️  存在失败项，请排查"
  exit 1
fi
