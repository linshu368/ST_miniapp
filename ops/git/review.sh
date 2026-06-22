#!/bin/bash
# ops/git/review.sh
# 组装 prompt 并调用 Claude API 生成审查报告
# 用法:
#   bash ops/git/review.sh              # 默认对比 main
#   bash ops/git/review.sh dev          # 指定基准分支

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ─── 加载本地环境变量 ───
ENV_FILE="${SCRIPT_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  echo "📂 加载环境变量: ${ENV_FILE}" >&2
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "⚠️  未找到 ${ENV_FILE}，将使用已有环境变量" >&2
fi

BASE_BRANCH="${1:-main}"

# ─── 1. 加载 prompt 模板 ───

PROMPT_DIR="${SCRIPT_DIR}/prompts"
PROMPT_FILE="${PROMPT_DIR}/diff_review.md"
ARCHITECTURE_FILE="${REPO_ROOT}/docs/ARCHITECTURE.md"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "❌ 找不到 prompt 文件: ${PROMPT_FILE}" >&2
  exit 1
fi

if [ ! -f "$ARCHITECTURE_FILE" ]; then
  echo "❌ 找不到架构文档: ${ARCHITECTURE_FILE}" >&2
  exit 1
fi

# ─── 2. 采集输入数据 ───

echo "📐 采集架构文档..." >&2
ARCHITECTURE_DOC=$(cat "$ARCHITECTURE_FILE")

echo "📦 采集代码上下文..." >&2
SRC_CODE=$("$SCRIPT_DIR/collect-context.sh")

echo "📝 采集 git diff (对比 ${BASE_BRANCH})..." >&2
GIT_DIFF=$("$SCRIPT_DIR/collect-diff.sh" "$BASE_BRANCH")

# ─── 3. 占位符替换，组装完整 prompt ───

TMP_ARCH=$(mktemp)
TMP_SRC=$(mktemp)
TMP_DIFF=$(mktemp)
TMP_PROMPT=$(mktemp)
trap 'rm -f "$TMP_ARCH" "$TMP_SRC" "$TMP_DIFF" "$TMP_PROMPT" "$TMP_REQ"' EXIT

printf '%s' "$ARCHITECTURE_DOC" > "$TMP_ARCH"
printf '%s' "$SRC_CODE" > "$TMP_SRC"
printf '%s' "$GIT_DIFF" > "$TMP_DIFF"

python3 <<'PY' "$PROMPT_FILE" "$TMP_ARCH" "$TMP_SRC" "$TMP_DIFF" "$TMP_PROMPT"
import sys

prompt_file, arch_file, src_file, diff_file, out_file = sys.argv[1:6]

template = open(prompt_file, encoding="utf-8").read()
architecture_doc = open(arch_file, encoding="utf-8").read()
src_code = open(src_file, encoding="utf-8").read()
git_diff = open(diff_file, encoding="utf-8").read()

filled = template.replace("{architecture_doc}", architecture_doc)
filled = filled.replace("{src_code}", src_code)
filled = filled.replace("{git_diff}", git_diff)

missing = [name for name, token in [
    ("architecture_doc", "{architecture_doc}"),
    ("src_code", "{src_code}"),
    ("git_diff", "{git_diff}"),
] if token in filled]

if missing:
    print(f"❌ prompt 占位符未替换: {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)

open(out_file, "w", encoding="utf-8").write(filled)
PY

SYSTEM_PROMPT=$(cat "$TMP_PROMPT")
USER_MESSAGE="开始"

# ─── 4. 构建 API 请求 ───

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "❌ 未设置 ANTHROPIC_API_KEY 环境变量" >&2
  echo "   export ANTHROPIC_API_KEY=sk-ant-..." >&2
  exit 1
fi

echo "🤖 调用 Claude API..." >&2

escape_json() {
  python3 -c "
import json, sys
print(json.dumps(sys.stdin.read()))
" <<< "$1"
}

SYSTEM_ESCAPED=$(escape_json "$SYSTEM_PROMPT")
USER_ESCAPED=$(escape_json "$USER_MESSAGE")

API_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}/v1/messages"
IS_OPENAI_FORMAT=0

if [[ "${ANTHROPIC_BASE_URL:-}" == *"/chat/completions"* ]]; then
    API_URL="${ANTHROPIC_BASE_URL}"
    IS_OPENAI_FORMAT=1
elif [[ "$API_URL" != *"/v1/messages"* && "$API_URL" != *"/chat/completions"* ]]; then
    API_URL="${API_URL%/}/v1/messages"
fi

TMP_REQ=$(mktemp)

if [ $IS_OPENAI_FORMAT -eq 1 ]; then
  MODEL_NAME="${OPENAI_MODEL:-anthropic/claude-opus-4.6}"

  cat <<EOF > "$TMP_REQ"
{
  "model": "${MODEL_NAME}",
  "messages": [
    {
      "role": "system",
      "content": ${SYSTEM_ESCAPED}
    },
    {
      "role": "user",
      "content": ${USER_ESCAPED}
    }
  ]
}
EOF

else
  MODEL_NAME="${ANTHROPIC_MODEL:-claude-3-opus-20240229}"

  cat <<EOF > "$TMP_REQ"
{
  "model": "${MODEL_NAME}",
  "max_tokens": 8192,
  "system": ${SYSTEM_ESCAPED},
  "messages": [
    {
      "role": "user",
      "content": ${USER_ESCAPED}
    }
  ]
}
EOF
fi

# ─── 5. 调用 API ───

RESPONSE_RAW=$(curl -s -w "\n%{http_code}" "$API_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "Authorization: Bearer ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -d @"$TMP_REQ")

HTTP_CODE=$(echo "$RESPONSE_RAW" | tail -n1)
RESPONSE=$(echo "$RESPONSE_RAW" | sed '$d')

# ─── 6. 提取输出 ───

ERROR_TYPE=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    if 'error' in r and isinstance(r['error'], dict) and 'type' in r['error']:
        print(r['error']['type'])
    elif 'error' in r and isinstance(r['error'], dict) and 'message' in r['error']:
        print('openai_error: ' + r['error']['message'])
    elif 'error' in r:
        print('error_string')
    else:
        print('')
except:
    print('parse_error')
" 2>/dev/null || echo "parse_error")

if [ -n "$ERROR_TYPE" ] && [ "$ERROR_TYPE" != "" ]; then
  echo "❌ API 返回错误 (HTTP 状态码: $HTTP_CODE):" >&2
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE" >&2

  if [ "$HTTP_CODE" = "403" ]; then
    echo "💡 提示: 403 Forbidden 错误通常是因为：" >&2
    echo "   1. 终端没有走代理，Anthropic 官方 API 屏蔽了当前 IP (如中国大陆 IP)。" >&2
    echo "      尝试在终端执行: export https_proxy=http://127.0.0.1:您的代理端口" >&2
    echo "   2. 如果您使用的是第三方代理 API，请设置 ANTHROPIC_BASE_URL 环境变量:" >&2
    echo "      export ANTHROPIC_BASE_URL=https://您的代理域名" >&2
  fi

  exit 1
fi

if [ "$HTTP_CODE" != "200" ]; then
  echo "❌ 请求失败，HTTP 状态码不是 200 (当前为: $HTTP_CODE)" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

echo "$RESPONSE" | python3 -c "
import json, sys
r = json.load(sys.stdin)
if 'content' in r and isinstance(r['content'], list):
    for block in r['content']:
        if block.get('type') == 'text':
            print(block['text'])
elif 'choices' in r and isinstance(r['choices'], list) and len(r['choices']) > 0:
    choice = r['choices'][0]
    if 'message' in choice and 'content' in choice['message']:
        print(choice['message']['content'])
"
