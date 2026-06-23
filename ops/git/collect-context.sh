#!/bin/bash
# ops/git/collect-context.sh
# 采集四包 src 代码 + package.json，输出结构化文本供 LLM 消费
# 用法: bash ops/git/collect-context.sh > context.txt

set -euo pipefail

DEFAULT_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="${REVIEW_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
PACKAGES=("shared" "backend" "frontend" "sync-engine")

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

# 列出应纳入审查上下文的 src 文件（采集与统计共用同一套规则）
find_src_files() {
  local src_dir="$1"
  find "$src_dir" -type f \( -name "*.ts" -o -name "*.tsx" \) \
    -not -path "*/node_modules/*" \
    -not -path "*/.next/*" \
    -not -name "*.test.*" \
    -not -name "*.spec.*" \
    -not -name "*.d.ts" \
    -not -path "*/__test__/*" \
    -not -path "*/__tests__/*" \
    \
    `# 第一档：阶段一遗留 / 纯 UI·mock·开发脚本（低审查价值）` \
    -not -path "*/routes/sessions.ts" \
    -not -path "*/app/chat/*" \
    -not -path "*/components/chat/*" \
    -not -path "*/src/api/chat.ts" \
    -not -path "*/components/ui/*" \
    -not -path "*/components/examples/*" \
    -not -path "*/lib/mock-data/*" \
    -not -path "*/lib/api/mock-registry*" \
    -not -name "dev-fixtures.ts" \
    -not -path "*/scripts/*" \
    \
    `# 第二档：前端页面与展示层` \
    -not -path "*/app/(main)/*" \
    -not -path "*/components/characters/*" \
    -not -path "*/components/payment/*" \
    -not -path "*/components/nav/*" \
    -not -path "*/lib/markdown/*" \
    -not -path "*/lib/themes/*" \
    -not -path "*/stores/theme-store.ts" \
    -not -path "*/stores/font-scale-store.ts" \
    -not -path "*/stores/ui-store.ts" \
    -not -path "*/hooks/use-idle-dim.ts" \
    \
    `# 第三档：sync-engine 运维胶水 / registry 加载器` \
    -not -path "*/health/*" \
    -not -path "*/queue/metrics.ts" \
    -not -path "*/lib/logger.ts" \
    -not -path "*/lib/hash.ts" \
    -not -path "*/registry/schema.ts" \
    -not -path "*/registry/loader.ts"
}

# ─── 1. 各包的 package.json（用于依赖检查）───

echo "## package.json 文件"
echo ""

# 根 package.json
emit_file "${REPO_ROOT}/package.json"

for pkg in "${PACKAGES[@]}"; do
  pkg_json="${REPO_ROOT}/packages/${pkg}/package.json"
  if [ -f "$pkg_json" ]; then
    emit_file "$pkg_json"
  fi
done

# ─── 2. 各包的 src/ 目录 ───

echo "## 源代码"
echo ""

for pkg in "${PACKAGES[@]}"; do
  src_dir="${REPO_ROOT}/packages/${pkg}/src"

  if [ ! -d "$src_dir" ]; then
    echo "<!-- WARNING: packages/${pkg}/src/ 不存在，已跳过 -->"
    echo ""
    continue
  fi

  echo "### packages/${pkg}/src/"
  echo ""

  find_src_files "$src_dir" \
    | sort \
    | while read -r filepath; do
        emit_file "$filepath"
      done
done

# ─── 3. 统计 ───

total_files=0
total_lines=0

for pkg in "${PACKAGES[@]}"; do
  src_dir="${REPO_ROOT}/packages/${pkg}/src"
  [ -d "$src_dir" ] || continue

  while IFS= read -r f; do
    total_files=$((total_files + 1))
    lines=$(wc -l < "$f")
    total_lines=$((total_lines + lines))
  done < <(find_src_files "$src_dir")
done

echo "<!-- 统计: ${total_files} 个源文件, 共 ${total_lines} 行 -->"
