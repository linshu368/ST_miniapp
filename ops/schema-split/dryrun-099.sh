#!/usr/bin/env bash
# 099 空跑：把迁移完整执行一遍，然后 ROLLBACK。
#
# 为什么值得单独做一次：099 的正确性大半在 preflight/postflight 断言、函数体正则改写
# 和人群 SQL 改写里，这些只有真跑一遍才能验。而 099 全程单事务，ROLLBACK 之后
# 库回到执行前形态（新建的 schema、搬走的表、改写的函数体、UPDATE 的 personas 全部撤销）。
#
# 做法：把迁移文件末尾的 COMMIT 换成 ROLLBACK，并去掉事务外的 NOTIFY，
# 生成一份临时副本执行。原文件不动。
#
# 用法：ops/schema-split/dryrun-099.sh [test|prod]   （默认 test）
#
# 注意：空跑期间会拿到 22 张表的 ACCESS EXCLUSIVE 锁直到 ROLLBACK。
# 在 test 上没问题；对 prod 只应在维护窗口内做。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-test}"
MIGRATION="packages/shared/migrations/099_schema_split_phase1.sql"

ENV_FILE="$REPO_ROOT/.env.schema-split"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

case "$TARGET" in
  test) URL="$TEST_POOL_URL"; EXPECT_REF=zoqelpfhurwehlvypryl ;;
  prod) URL="$PROD_DIRECT_URL"; EXPECT_REF=wbtsfzozlmurljvglhpn ;;
  *) echo "用法: $0 [test|prod]" >&2; exit 2 ;;
esac

if [[ "$URL" != *"$EXPECT_REF"* ]]; then
  echo "连接串不含预期 project ref $EXPECT_REF，中止" >&2
  exit 1
fi

TMP="$(mktemp -t dryrun-099.XXXXXX.sql)"
trap 'rm -f "$TMP"' EXIT

# 末尾的 COMMIT 改 ROLLBACK；NOTIFY 注释掉（它在事务外，会真的发出去）
sed -e 's/^COMMIT;$/ROLLBACK;  -- 空跑：不提交/' \
    -e "s/^NOTIFY pgrst, 'reload schema';$/-- NOTIFY 已在空跑中跳过/" \
    "$MIGRATION" > "$TMP"

if ! grep -q '^ROLLBACK;' "$TMP"; then
  echo "改写失败：临时文件里没有 ROLLBACK，中止（避免误提交）" >&2
  exit 1
fi
if grep -q '^COMMIT;' "$TMP"; then
  echo "改写失败：临时文件里仍有 COMMIT，中止" >&2
  exit 1
fi

echo "=== 099 dry-run @ ${TARGET} (ROLLBACK at end) ==="
psql "$URL" -X -v ON_ERROR_STOP=1 -f "$TMP"
rc=$?

echo
if [[ "${rc}" -eq 0 ]]; then
  echo "dry-run passed: preflight / move / rewrite / personas / postflight all succeeded; rolled back."
else
  echo "dry-run failed (exit ${rc}). transaction rolled back; database unchanged."
fi
exit "${rc}"
