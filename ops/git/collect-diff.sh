#!/bin/bash
set -euo pipefail

BASE_BRANCH="${1:-main}"
DEFAULT_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="${REVIEW_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
cd "$REPO_ROOT"

# 兼容 GitHub Actions 的 detached HEAD
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" = "HEAD" ]; then
  CURRENT_BRANCH="${GITHUB_HEAD_REF:-detached-HEAD}"
fi

# 统一排除规则，复用同一组 pathspec
PATHSPEC=(
  -- .
  ':(exclude)pnpm-lock.yaml'
  ':(exclude)*.lock'
  ':(exclude)**/.DS_Store'
  ':(exclude)*.png' ':(exclude)*.jpg' ':(exclude)*.jpeg'
  ':(exclude)*.gif' ':(exclude)*.svg' ':(exclude)*.ico'
  ':(exclude)*.woff' ':(exclude)*.woff2' ':(exclude)*.ttf' ':(exclude)*.eot'
)

echo "## Diff 元信息"
echo ""
echo "- 当前分支: \`${CURRENT_BRANCH}\`"
echo "- 对比基准: \`${BASE_BRANCH}\`"
echo "- 生成时间: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

echo "## 变更文件清单"
echo ""
echo '```'
git diff "${BASE_BRANCH}"...HEAD --stat "${PATHSPEC[@]}"
echo '```'
echo ""

echo "## 完整 Diff"
echo ""
echo '<diff>'
git diff "${BASE_BRANCH}"...HEAD "${PATHSPEC[@]}"
echo '</diff>'