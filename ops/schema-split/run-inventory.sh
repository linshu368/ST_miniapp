#!/usr/bin/env bash
# Schema 划分一阶段 · 批次 A 双库只读盘点
#
# 连接串从仓库根的 .env.schema-split 读取（该文件被 .gitignore 忽略），
# 避免凭据出现在命令行和进程列表里。
#
# 输出：ops/schema-split/snapshots/<date>/{test,prod}/…
#   inventory.txt         全量分节输出
#   sections/<name>.txt   按节切分，便于 diff
#   functions.sql         全部函数完整定义
#
# 本脚本只执行 SELECT，不做任何写库动作。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env.schema-split"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE（存放 TEST_*/PROD_* 连接串）" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

SNAP_DATE="${SNAP_DATE:-$(date +%Y-%m-%d)}"
OUT_ROOT="$REPO_ROOT/ops/schema-split/snapshots/$SNAP_DATE"

run_one() {
  local label="$1" url="$2" expect_ref="$3"
  local out_dir="$OUT_ROOT/$label"

  if [[ "$url" != *"$expect_ref"* ]]; then
    echo "[$label] 连接串不含预期 project ref $expect_ref，中止" >&2
    return 1
  fi

  mkdir -p "$out_dir/sections"
  echo "[$label] 盘点中 -> $out_dir"

  psql "$url" -X -q -A -F '|' -f ops/schema-split/inventory.sql \
    > "$out_dir/inventory.txt" 2> "$out_dir/inventory.err"

  awk -v dir="$out_dir/sections" '
    /^===SECTION:/ {
      name = $0
      sub(/^===SECTION:/, "", name)
      sub(/===$/, "", name)
      file = dir "/" name ".txt"
      next
    }
    file { print > file }
  ' "$out_dir/inventory.txt"

  psql "$url" -X -q -t -A -f ops/schema-split/dump-functions.sql \
    > "$out_dir/functions.sql" 2>> "$out_dir/inventory.err"

  local errsize
  errsize=$(wc -c < "$out_dir/inventory.err" | tr -d ' ')
  echo "[$label] 完成；stderr ${errsize} 字节"
}

case "${1:-both}" in
  test) run_one test "$TEST_POOL_URL" zoqelpfhurwehlvypryl ;;
  prod) run_one prod "$PROD_DIRECT_URL" wbtsfzozlmurljvglhpn ;;
  both)
    run_one test "$TEST_POOL_URL" zoqelpfhurwehlvypryl
    run_one prod "$PROD_DIRECT_URL" wbtsfzozlmurljvglhpn
    ;;
  *) echo "用法: $0 [test|prod|both]" >&2; exit 2 ;;
esac

echo "快照目录：$OUT_ROOT"
