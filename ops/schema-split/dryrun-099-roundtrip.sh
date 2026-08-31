#!/usr/bin/env bash
# 099 往返空跑：在同一个事务里先跑 099 正文、再跑回滚脚本，最后 ROLLBACK。
#
# 为什么需要它：dryrun-099.sh 只验正向迁移。回滚脚本是「提交后失败」时唯一的退路，
# 执行计划 §六.2 明确禁止现场拼接回滚 SQL——那就必须在割接之前真跑一遍。
# 回滚脚本的起点是「099 已提交」的形态，所以只能接在 099 后面验，不能单独验。
#
# 做法：
#   · 099：去掉末尾 COMMIT 与事务外 NOTIFY，事务保持打开；
#   · 回滚脚本：去掉自己的 BEGIN（沿用同一个事务）与 NOTIFY，末尾 COMMIT 换成 ROLLBACK。
#   两份原文件都不改。两者的临时表分别用 _split_ / _unsplit_ 前缀，同事务内不冲突。
#
# 这一遍会真正走到：099 preflight → 搬对象 → 改写函数体/人群 SQL → 099 postflight
#                → 回滚 preflight → 搬回 → 改回 → DROP 四个新 schema → 回滚 postflight
# 然后整体 ROLLBACK。任何一步断言不过都会非零退出，库不变。
#
# 用法：ops/schema-split/dryrun-099-roundtrip.sh [test|prod]   （默认 test）
#
# 注意：空跑期间会拿到 22 张表的 ACCESS EXCLUSIVE 锁直到 ROLLBACK，且比
# dryrun-099.sh 持有更久（多跑一遍反向）。在 test 上没问题；
# 对 prod 只应在维护窗口内做。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGET="${1:-test}"
FORWARD="packages/shared/migrations/099_schema_split_phase1.sql"
BACKWARD="packages/shared/migrations/099_schema_split_phase1_rollback.sql"

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

TMP="$(mktemp -t dryrun-099-roundtrip.XXXXXX.sql)"
trap 'rm -f "$TMP"' EXIT

{
  echo "-- ==================== 正向：099（不提交） ===================="
  sed -e 's/^COMMIT;$/-- 往返空跑：099 不提交，事务继续/' \
      -e "s/^NOTIFY pgrst, 'reload schema';\$/-- NOTIFY 已在空跑中跳过/" \
      "$FORWARD"

  echo
  echo "-- ==================== 反向：099 回滚（末尾 ROLLBACK） ===================="
  sed -e 's/^BEGIN;$/-- 往返空跑：沿用 099 的同一个事务/' \
      -e 's/^COMMIT;$/ROLLBACK;  -- 往返空跑：不提交/' \
      -e "s/^NOTIFY pgrst, 'reload schema';\$/-- NOTIFY 已在空跑中跳过/" \
      "$BACKWARD"

  cat <<'EOF'

-- ==================== 收尾复核（事务已 ROLLBACK） ====================
\echo '--- 事务外复核：库应完全回到空跑开始前的形态 ---'
SELECT count(*) FILTER (WHERE relkind = 'r') AS miniapp_tables,
       count(*) FILTER (WHERE relkind = 'v') AS miniapp_views
  FROM pg_class WHERE relnamespace = 'miniapp'::regnamespace;
SELECT count(*) AS miniapp_functions
  FROM pg_proc WHERE pronamespace = 'miniapp'::regnamespace;
SELECT count(*) AS leaked_new_schemas
  FROM pg_namespace WHERE nspname IN ('app_core','miniapp_features','experience','billing');
SELECT count(*) AS personas_referencing_miniapp
  FROM cs_platform.personas WHERE sql_text ~ 'miniapp\.';
EOF
} > "$TMP"

# 安全闸：临时文件必须只剩一个 BEGIN、一个 ROLLBACK、零个 COMMIT
n_begin=$(grep -c '^BEGIN;$' "$TMP")
n_commit=$(grep -c '^COMMIT;$' "$TMP")
n_rollback=$(grep -c '^ROLLBACK;' "$TMP")
if [[ "$n_begin" -ne 1 || "$n_commit" -ne 0 || "$n_rollback" -ne 1 ]]; then
  echo "改写失败：BEGIN=$n_begin COMMIT=$n_commit ROLLBACK=$n_rollback（应为 1/0/1），中止以避免误提交" >&2
  exit 1
fi

echo "=== 099 forward + rollback round-trip @ ${TARGET} (ROLLBACK at end) ==="
psql "$URL" -X -v ON_ERROR_STOP=1 -f "$TMP"
rc=$?

echo
if [[ "${rc}" -eq 0 ]]; then
  echo "round-trip passed: 099 与回滚脚本的 preflight / 搬迁 / 改写 / postflight 全部通过；已回滚。"
else
  echo "round-trip failed (exit ${rc}). transaction rolled back; database unchanged."
fi
exit "${rc}"
