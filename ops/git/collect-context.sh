#!/bin/bash
# ops/git/collect-context.sh
# 两档采集源码上下文，输出结构化文本供 LLM 消费。
#
# 档 A（常驻核心，任何 diff 都采集）：
#   - 契约层全量：bridge-protocol / shared（api 契约 + 工具）
#   - 载荷配置：sync-engine/registry.yaml、backend/prisma/schema.prisma、frontend/next.config.mjs
#   - 桥接与同步执行链路：frontend lib/bridge + components/bridge、st-extension、
#     backend（鉴权桥/ST反代/LLM网关/历史反代等）、sync-engine（provisioner/watcher/queue）
#
# 档 B（按 diff 触达按需附带，无 diff 清单时全部附带）：
#   - cs        : CS 运营平台 + 增长归因 + Bot webhook（纯自研 REST，与桥接隔离）
#   - payment   : 支付 / 钱包 / 签到（含 LLM 计费依赖的钱包 repo）
#   - wishes    : 许愿池
#   - frontend-ui: 前端展示层（大厅/我的/充值等页面与展示组件）
#
# 用法:
#   bash ops/git/collect-context.sh                      # 全量（档 A + 全部档 B）
#   bash ops/git/collect-context.sh <changed-files.txt>  # 档 A + diff 触达的档 B 模块
#     <changed-files.txt>: 变更文件路径清单（每行一个，repo 相对路径），
#     通常由 review.sh 用 `git diff <base>...HEAD --name-only` 生成。

set -euo pipefail

DEFAULT_REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO_ROOT="${REVIEW_REPO_ROOT:-$DEFAULT_REPO_ROOT}"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

CHANGED_LIST="${1:-}"
if [ -n "$CHANGED_LIST" ] && [ ! -f "$CHANGED_LIST" ]; then
  echo "❌ changed-files 清单不存在: ${CHANGED_LIST}" >&2
  exit 1
fi

# 全部待输出文件路径（按 append 顺序去重后输出）
FILE_LIST="$(mktemp)"
trap 'rm -f "$FILE_LIST"' EXIT

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

add_file() {
  # 存在才登记，静默跳过已删除/未创建的路径
  local f="$1"
  [ -f "$f" ] && echo "$f" >> "$FILE_LIST" || true
}

# 档 B 模块开关：无 diff 清单 → 全开；有清单 → 触达正则命中才开
group_enabled() {
  local regex="$1"
  [ -z "$CHANGED_LIST" ] && return 0
  grep -qiE "$regex" "$CHANGED_LIST"
}

# ─── 档 A：常驻核心 ───

# 1) package.json（依赖检查）
PKGJSON_PACKAGES=("bridge-protocol" "shared" "backend" "frontend" "sync-engine" "st-extension" "cs-platform")

# 2) 载荷配置（行为真相所在的非 TS 文件）
collect_payload_configs() {
  add_file "${REPO_ROOT}/packages/sync-engine/registry.yaml"      # 同步规则清单（provision/watcher 声明式真相）
  add_file "${REPO_ROOT}/packages/backend/prisma/schema.prisma"   # DB 模型（repository 改动的对照物）
  add_file "${REPO_ROOT}/packages/frontend/next.config.mjs"       # 方案 Y rewrites（路由分发事故高发区）
}

# 3) 各包 src 采集（档 A 白名单；档 B 模块文件在此排除、由对应模块按需附带）
find_tier_a_files() {
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
    `# 永久排除：mock / 示例 / 开发脚本 / 纯 UI 库（无审查价值）` \
    -not -path "*/components/ui/*" \
    -not -path "*/components/examples/*" \
    -not -path "*/lib/mock-data/*" \
    -not -path "*/lib/api/mock-registry*" \
    -not -name "dev-fixtures.ts" \
    -not -path "*/scripts/*" \
    \
    `# 档 B: cs（CS 运营平台 + 增长归因 + Bot）` \
    -not -path "*/routes/cs-platform.ts" \
    -not -path "*/routes/growth.ts" \
    -not -path "*/routes/bot.ts" \
    -not -path "*/repositories/CsPlatformRepository.ts" \
    -not -path "*/lib/api/growth.ts" \
    \
    `# 档 B: payment（支付/钱包/签到）` \
    -not -path "*/routes/payment.ts" \
    -not -path "*/routes/wallet.ts" \
    -not -path "*/repositories/MiniappWalletRepository.ts" \
    -not -path "*/repositories/MiniappPaymentOrderRepository.ts" \
    -not -path "*/infrastructure/payment/*" \
    -not -path "*/features/payment/*" \
    -not -path "*/lib/api/payment.ts" \
    \
    `# 档 B: wishes（许愿池）` \
    -not -path "*/routes/wishes.ts" \
    -not -path "*/repositories/MiniappWishRoleRepository.ts" \
    -not -path "*/lib/api/wishes.ts" \
    \
    `# 档 B: frontend-ui（展示层）` \
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
    `# sync-engine 运维胶水 / registry 加载器（registry.yaml 本体已入载荷配置）` \
    -not -path "*/health/*" \
    -not -path "*/queue/metrics.ts" \
    -not -path "*/lib/logger.ts" \
    -not -path "*/lib/hash.ts" \
    -not -path "*/registry/schema.ts" \
    -not -path "*/registry/loader.ts"
}

# 档 A 采集的包（cs-platform 整包属档 B）
TIER_A_PACKAGES=("bridge-protocol" "shared" "backend" "frontend" "sync-engine" "st-extension")

collect_tier_a() {
  local pkg src_dir
  for pkg in "${TIER_A_PACKAGES[@]}"; do
    src_dir="${REPO_ROOT}/packages/${pkg}/src"
    [ -d "$src_dir" ] || continue
    find_tier_a_files "$src_dir" | sort >> "$FILE_LIST"
  done
}

# ─── 档 B：按需模块 ───

# 触达正则（对 changed-files 清单逐行 grep -iE；宁可过触发多附带，不可漏触发缺上下文）
GROUP_CS_REGEX='packages/cs-platform/|routes/(cs-platform|growth|bot)\.|CsPlatformRepository|api/(cs-platform|growth)\.|cs_platform|growth'
GROUP_PAYMENT_REGEX='payment|wallet|checkin|recharge|llm-proxy|model-tiers'
GROUP_WISHES_REGEX='wish'
GROUP_FRONTEND_UI_REGEX='app/\(main\)/|components/(characters|payment|nav)/|lib/(markdown|themes)/|(theme|font-scale|ui)-store|use-idle-dim'

collect_group_cs() {
  if [ -d "${REPO_ROOT}/packages/cs-platform/src" ]; then
    find "${REPO_ROOT}/packages/cs-platform/src" -type f \( -name "*.ts" -o -name "*.tsx" \) \
      -not -name "*.d.ts" -not -path "*/node_modules/*" | sort >> "$FILE_LIST"
  fi
  add_file "${REPO_ROOT}/packages/backend/src/routes/cs-platform.ts"
  add_file "${REPO_ROOT}/packages/backend/src/routes/growth.ts"
  add_file "${REPO_ROOT}/packages/backend/src/routes/bot.ts"
  add_file "${REPO_ROOT}/packages/backend/src/infrastructure/repositories/CsPlatformRepository.ts"
  add_file "${REPO_ROOT}/packages/frontend/src/lib/api/growth.ts"
}

collect_group_payment() {
  add_file "${REPO_ROOT}/packages/backend/src/routes/payment.ts"
  add_file "${REPO_ROOT}/packages/backend/src/routes/wallet.ts"
  add_file "${REPO_ROOT}/packages/backend/src/infrastructure/repositories/MiniappWalletRepository.ts"
  add_file "${REPO_ROOT}/packages/backend/src/infrastructure/repositories/MiniappPaymentOrderRepository.ts"
  add_file "${REPO_ROOT}/packages/backend/src/infrastructure/payment/JLPaymentGateway.ts"
  if [ -d "${REPO_ROOT}/packages/backend/src/features/payment" ]; then
    find "${REPO_ROOT}/packages/backend/src/features/payment" -type f -name "*.ts" | sort >> "$FILE_LIST"
  fi
  add_file "${REPO_ROOT}/packages/frontend/src/lib/api/payment.ts"
}

collect_group_wishes() {
  add_file "${REPO_ROOT}/packages/backend/src/routes/wishes.ts"
  add_file "${REPO_ROOT}/packages/backend/src/infrastructure/repositories/MiniappWishRoleRepository.ts"
  add_file "${REPO_ROOT}/packages/frontend/src/lib/api/wishes.ts"
}

collect_group_frontend_ui() {
  local fe="${REPO_ROOT}/packages/frontend/src"
  local dirs=()
  local d
  for d in \
    "${fe}/app/(main)" \
    "${fe}/components/characters" \
    "${fe}/components/payment" \
    "${fe}/components/nav" \
    "${fe}/lib/markdown" \
    "${fe}/lib/themes"; do
    [ -d "$d" ] && dirs+=("$d")
  done
  if [ "${#dirs[@]}" -gt 0 ]; then
    find "${dirs[@]}" -type f \( -name "*.ts" -o -name "*.tsx" \) \
      -not -name "*.test.*" -not -name "*.d.ts" | sort >> "$FILE_LIST"
  fi
  add_file "${fe}/stores/theme-store.ts"
  add_file "${fe}/stores/font-scale-store.ts"
  add_file "${fe}/stores/ui-store.ts"
  add_file "${fe}/hooks/use-idle-dim.ts"
}

# ─── 组装 ───

collect_payload_configs
collect_tier_a

ENABLED_GROUPS=()
if group_enabled "$GROUP_CS_REGEX"; then
  ENABLED_GROUPS+=("cs")
  collect_group_cs
fi
if group_enabled "$GROUP_PAYMENT_REGEX"; then
  ENABLED_GROUPS+=("payment")
  collect_group_payment
fi
if group_enabled "$GROUP_WISHES_REGEX"; then
  ENABLED_GROUPS+=("wishes")
  collect_group_wishes
fi
if group_enabled "$GROUP_FRONTEND_UI_REGEX"; then
  ENABLED_GROUPS+=("frontend-ui")
  collect_group_frontend_ui
fi

# ─── 输出 ───

echo "## 采集模式"
echo ""
if [ -z "$CHANGED_LIST" ]; then
  echo "全量模式（档 A 常驻核心 + 全部档 B 模块）"
else
  echo "diff 感知模式（档 A 常驻核心 + diff 触达的档 B 模块）"
  echo ""
  echo "- 本次附带的档 B 模块: ${ENABLED_GROUPS[*]:-（无，diff 未触达任何按需模块）}"
  echo "- 未附带模块（cs/payment/wishes/frontend-ui 中的其余项）的源码不在本上下文中；"
  echo "  若 diff 与其无关这是预期行为，请勿臆测其内容。"
fi
echo ""

echo "## package.json 文件"
echo ""
emit_file "${REPO_ROOT}/package.json"
for pkg in "${PKGJSON_PACKAGES[@]}"; do
  pkg_json="${REPO_ROOT}/packages/${pkg}/package.json"
  [ -f "$pkg_json" ] && emit_file "$pkg_json"
done

echo "## 源代码与载荷配置"
echo ""

total_files=0
total_lines=0
while IFS= read -r filepath; do
  emit_file "$filepath"
  total_files=$((total_files + 1))
  lines=$(wc -l < "$filepath")
  total_lines=$((total_lines + lines))
done < <(awk '!seen[$0]++' "$FILE_LIST")

echo "<!-- 统计: ${total_files} 个源文件, 共 ${total_lines} 行; 档B模块: ${ENABLED_GROUPS[*]:-none} -->"
