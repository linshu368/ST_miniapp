#!/bin/bash
# ops/git/collect-context.sh
# 采集源码上下文，输出结构化文本供 LLM 消费。输入分两块：
#
# ── 固定块（核心源码，每次审查恒定投喂）────────────────────────────
#   实测 ≈36k tokens（tiktoken cl100k，2026-07-14 基线，含 <file> 包裹与说明头；
#   72 文件/3813 行。核心清单变动后请重新实测并更新此数字）
#   A. 契约层全量：bridge-protocol/src + shared/src
#      —— 判定「绕过契约 / 重复定义协议字段」（架构铁律 2/4/5）的源头依据
#   B. 载荷配置：registry.yaml / schema.prisma / next.config.mjs
#      —— provision 规则、DB 模型、方案 Y rewrites 的声明式行为真相
#   C. 接线/编排骨架：各包的注册总表与协议端点（app.ts、entry.ts、
#      bridge-server/forwarders、platformAction 门面、provisioner 编排等）
#      —— 让 AI 建立「什么被注册到了哪里」的全局地图，替代整包源码
#
# ── 变量块（diff 圈定源码，按相关性排序 + 预算截断）──────────────────
#   diff 触达文件的全文（diff 只有 hunks，全文补齐上下文），交由
#   select-context-files.py 按 churn（改动行数）降序排序：与 diff 强相关者
#   排前面；总量超预算时从相关性最小的开始砍。预算由下列 env 推导：
#     变量预算 = REVIEW_TOKEN_LIMIT - REVIEW_RESERVED_TOKENS
#                - 固定块 tokens - REVIEW_TOKEN_MARGIN
#   REVIEW_RESERVED_TOKENS 由 review.sh 传入（提示词模板 + ARCHITECTURE.md
#   + diff 三块的 token），从而保证「模板 + 文档 + 固定块 + 变量块 + diff」
#   组装后的单次输入落在 REVIEW_TOKEN_LIMIT（默认 10 万）以内。
#
# 用法:
#   bash ops/git/collect-context.sh                      # 仅固定块
#   bash ops/git/collect-context.sh <numstat.txt>        # 固定块 + diff 圈定文件
#     <numstat.txt>: `git diff <base>...HEAD --numstat` 输出（也兼容 name-only）。
#
# 相关 env:
#   REVIEW_TOKEN_LIMIT      单次输入硬上限（默认 100000）
#   REVIEW_RESERVED_TOKENS  模板+文档+diff 已占用 token（默认 0）
#   REVIEW_TOKEN_MARGIN     估算误差安全余量（默认 3000）
#   REVIEW_MAX_FILE_TOKENS  单个圈定文件全文上限（默认 30000，见 selector）

set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
REPO_ROOT="${REVIEW_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

CHANGED_LIST="${1:-}"
if [ -n "$CHANGED_LIST" ] && [ ! -f "$CHANGED_LIST" ]; then
  echo "❌ 变更清单不存在: ${CHANGED_LIST}" >&2
  exit 1
fi

TOKEN_LIMIT="${REVIEW_TOKEN_LIMIT:-100000}"
RESERVED="${REVIEW_RESERVED_TOKENS:-0}"
MARGIN="${REVIEW_TOKEN_MARGIN:-3000}"

CORE_LIST="$(mktemp)"
SEL_OUT="$(mktemp)"
trap 'rm -f "$CORE_LIST" "$SEL_OUT"' EXIT

# ─── 辅助函数 ───

emit_file() {
  local filepath="$1"
  local relpath="${filepath#$REPO_ROOT/}"
  echo "<file path=\"${relpath}\">"
  cat "$filepath"
  echo ""
  echo "</file>"
  echo ""
}

add_core() {
  local f="${REPO_ROOT}/$1"
  [ -f "$f" ] && echo "$f" >> "$CORE_LIST" || echo "⚠️  核心文件缺失: $1" >&2
}

count_lines() {
  local n=0 l=0 f
  while IFS= read -r f; do
    n=$((n + 1))
    l=$((l + $(wc -l < "$f")))
  done < "$1"
  echo "$n $l"
}

# ─── 固定块 A：契约层全量 ───

find "${REPO_ROOT}/packages/bridge-protocol/src" \
     "${REPO_ROOT}/packages/shared/src" \
  -type f -name "*.ts" \
  -not -name "*.test.*" -not -name "*.spec.*" -not -name "*.d.ts" \
  -not -path "*/__tests__/*" -not -path "*/node_modules/*" \
  | sort >> "$CORE_LIST"

# ─── 固定块 B：载荷配置（声明式行为真相）───

add_core "packages/sync-engine/registry.yaml"
add_core "packages/backend/prisma/schema.prisma"
add_core "packages/frontend/next.config.mjs"

# ─── 固定块 C：接线/编排骨架 ───

add_core "packages/backend/src/app.ts"
add_core "packages/backend/src/platform/config.ts"
add_core "packages/st-extension/src/entry.ts"
add_core "packages/st-extension/src/bridge-server.ts"
add_core "packages/st-extension/src/handshake.ts"
add_core "packages/st-extension/src/mirror-state.ts"
add_core "packages/st-extension/src/forwarders/index.ts"
add_core "packages/frontend/src/app/providers.tsx"
add_core "packages/frontend/src/lib/bridge/index.ts"
add_core "packages/frontend/src/lib/bridge/platform-action.ts"
add_core "packages/frontend/src/lib/bridge/hooks.ts"
add_core "packages/frontend/src/lib/bridge/singleton.ts"
add_core "packages/frontend/src/lib/bridge/state-machine.ts"
add_core "packages/frontend/src/stores/st-mirror.ts"
add_core "packages/sync-engine/src/lib/config.ts"
add_core "packages/sync-engine/src/provisioner/index.ts"

# 固定块去重（保持顺序）
awk '!seen[$0]++' "$CORE_LIST" > "${CORE_LIST}.uniq" && mv "${CORE_LIST}.uniq" "$CORE_LIST"

# ─── 变量块：相关性排序 + 预算截断（委托 select-context-files.py）───

VAR_BUDGET=0
CORE_TOKENS=0
if [ -n "$CHANGED_LIST" ]; then
  CORE_TOKENS=$(python3 "$SELF_DIR/estimate_tokens.py" --list "$CORE_LIST")
  VAR_BUDGET=$(( TOKEN_LIMIT - RESERVED - CORE_TOKENS - MARGIN ))
  [ "$VAR_BUDGET" -lt 0 ] && VAR_BUDGET=0
  python3 "$SELF_DIR/select-context-files.py" \
    "$CHANGED_LIST" "$REPO_ROOT" "$CORE_LIST" "$VAR_BUDGET" > "$SEL_OUT" 2>/dev/null || true
fi

# ─── 输出 ───

read -r core_files core_lines <<< "$(count_lines "$CORE_LIST")"
kept_files=$(grep -c '^KEEP' "$SEL_OUT" 2>/dev/null) || kept_files=0
dropped_files=$(grep -c '^DROP' "$SEL_OUT" 2>/dev/null) || dropped_files=0

echo "## 上下文采集说明"
echo ""
echo "本上下文由两块组成："
echo ""
echo "1. **固定块（核心源码）**：契约层全量（bridge-protocol/shared）+ 载荷配置"
echo "   （registry.yaml/schema.prisma/next.config.mjs）+ 各包接线骨架。约 ${CORE_TOKENS:-36k} tokens。"
if [ -n "$CHANGED_LIST" ]; then
  echo "2. **变量块（diff 圈定源码）**：diff 触达文件全文，按改动行数（相关性）降序排列；"
  echo "   受预算约束（约 ${VAR_BUDGET} tokens），超预算的低相关文件已从末尾砍除。"
  echo "   本次保留 ${kept_files} 个、丢弃 ${dropped_files} 个。"
else
  echo "2. **变量块（diff 圈定源码）**：本次未提供 diff 清单，仅输出固定块。"
fi
echo ""
echo "未包含/被砍的源码：不代表不存在。各模块职责与路由/表清单见 ARCHITECTURE.md；"
echo "如实现细节未在上下文中且无法从契约/骨架推断，请标注「需人工核对」而非臆测。"

# 被砍文件清单（相关性排序，便于人工判断是否需要单独补看）
if [ "$dropped_files" -gt 0 ]; then
  echo ""
  echo "以下 diff 触达文件因预算/体积未附全文（仅见 diff）："
  while IFS=$'\t' read -r tag reason toks churn rel; do
    [ "$tag" = "DROP" ] || continue
    echo "- ${rel}（reason=${reason}, ~${toks}tok, churn=${churn}）"
  done < "$SEL_OUT"
fi
echo ""

echo "## 固定块：核心源码"
echo ""
while IFS= read -r f; do emit_file "$f"; done < "$CORE_LIST"

if [ "$kept_files" -gt 0 ]; then
  echo "## 变量块：diff 圈定源码（触达文件全文，按相关性降序）"
  echo ""
  while IFS=$'\t' read -r tag toks churn rel; do
    [ "$tag" = "KEEP" ] || continue
    emit_file "${REPO_ROOT}/${rel}"
  done < <(grep '^KEEP' "$SEL_OUT")
fi

echo "<!-- 统计: 固定块 ${core_files} 文件/${core_lines} 行 (~${CORE_TOKENS}tok); 圈定保留 ${kept_files}/丢弃 ${dropped_files}; 变量预算 ${VAR_BUDGET}tok -->"
