#!/bin/bash
# ops/git/review.sh
# 组装 prompt 并调用 Claude API 生成审查报告
# 用法:
#   bash ops/git/review.sh                    # 默认对比 main，使用前端 prompt
#   bash ops/git/review.sh main frontend      # 指定基准分支和 prompt 类型
#   bash ops/git/review.sh main backend       # 使用后端 prompt

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
PROMPT_TYPE="${2:-frontend}"    # frontend 或 backend

# ─── 1. 选择 system prompt ───

PROMPT_DIR="${SCRIPT_DIR}/prompts"
SYSTEM_PROMPT_FILE="${PROMPT_DIR}/${PROMPT_TYPE}.md"

if [ ! -f "$SYSTEM_PROMPT_FILE" ]; then
  echo "❌ 找不到 prompt 文件: ${SYSTEM_PROMPT_FILE}" >&2
  echo "   可用的 prompt: $(ls "${PROMPT_DIR}"/*.md 2>/dev/null | xargs -I{} basename {})" >&2
  exit 1
fi

SYSTEM_PROMPT=$(cat "$SYSTEM_PROMPT_FILE")

# ─── 2. 采集代码上下文和 diff ───

echo "📦 采集代码上下文..." >&2
CONTEXT=$("$SCRIPT_DIR/collect-context.sh")

echo "📝 采集 git diff (对比 ${BASE_BRANCH})..." >&2
DIFF=$("$SCRIPT_DIR/collect-diff.sh" "$BASE_BRANCH")

# ─── 3. 组装 user message ───

USER_MESSAGE="# 本次审查输入

${DIFF}

# 完整代码上下文

${CONTEXT}"

# ─── 4. 构建 API 请求 ───

# 需要环境变量 ANTHROPIC_API_KEY
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "❌ 未设置 ANTHROPIC_API_KEY 环境变量" >&2
  echo "   export ANTHROPIC_API_KEY=sk-ant-..." >&2
  exit 1
fi

echo "🤖 调用 Claude API..." >&2

# 转义 JSON 特殊字符
escape_json() {
  python3 -c "
import json, sys
print(json.dumps(sys.stdin.read()))
" <<< "$1"
}

SYSTEM_ESCAPED=$(escape_json "$SYSTEM_PROMPT")
USER_ESCAPED=$(escape_json "$USER_MESSAGE")

# 判断要请求的接口格式 (Anthropic 原生格式 vs OpenAI 兼容格式)
API_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}/v1/messages"
IS_OPENAI_FORMAT=0

if [[ "${ANTHROPIC_BASE_URL:-}" == *"/chat/completions"* ]]; then
    API_URL="${ANTHROPIC_BASE_URL}"
    IS_OPENAI_FORMAT=1
elif [[ "$API_URL" != *"/v1/messages"* && "$API_URL" != *"/chat/completions"* ]]; then
    API_URL="${API_URL%/}/v1/messages"
fi

# 创建临时文件来存储请求体，避免 "Argument list too long" 错误
TMP_REQ=$(mktemp)
# 确保脚本退出时自动删除临时文件
trap 'rm -f "$TMP_REQ"' EXIT

if [ $IS_OPENAI_FORMAT -eq 1 ]; then
  # OpenAI 兼容格式 (如 OpenRouter, 多数中转 API)
  # 优先使用环境变量 OPENAI_MODEL，未设置则使用默认值
  MODEL_NAME="${OPENAI_MODEL:-anthropic/claude-opus-4.6}"
  
  # 把 System prompt 放到 messages 数组里，并写入临时文件
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
  # Anthropic 官方格式
  # 优先使用环境变量 ANTHROPIC_MODEL，未设置则使用默认值
  MODEL_NAME="${ANTHROPIC_MODEL:-claude-3-opus-20240229}"
  
  # 写入临时文件
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

# 因为某些兼容代理API可能不支持 anthropic-version header 或者 x-api-key (它们用 Authorization: Bearer)，
# 我们统一携带两者。
# 注意这里使用 -d @"$TMP_REQ" 从文件中读取 payload
RESPONSE_RAW=$(curl -s -w "\n%{http_code}" "$API_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "Authorization: Bearer ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -d @"$TMP_REQ")

HTTP_CODE=$(echo "$RESPONSE_RAW" | tail -n1)
RESPONSE=$(echo "$RESPONSE_RAW" | sed '$d')

# ─── 6. 提取输出 ───

# 打印调试信息，帮助定位问题
# echo "DEBUG: API_URL: $API_URL" >&2
# echo "DEBUG: HTTP_CODE: $HTTP_CODE" >&2
# echo "DEBUG: RESPONSE: $RESPONSE" >&2

# 检查是否有错误
# 兼容不同API的返回格式（Anthropic原生格式 vs OpenAI兼容格式）
ERROR_TYPE=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    # Anthropic error format
    if 'error' in r and isinstance(r['error'], dict) and 'type' in r['error']:
        print(r['error']['type'])
    # OpenAI error format (often used by proxies)
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
  # 尝试格式化 JSON，如果失败就原样输出
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

# 提取文本内容 (兼容 Anthropic 格式和 OpenAI 格式)
echo "$RESPONSE" | python3 -c "
import json, sys
r = json.load(sys.stdin)
# Anthropic format
if 'content' in r and isinstance(r['content'], list):
    for block in r['content']:
        if block.get('type') == 'text':
            print(block['text'])
# OpenAI format
elif 'choices' in r and isinstance(r['choices'], list) and len(r['choices']) > 0:
    choice = r['choices'][0]
    if 'message' in choice and 'content' in choice['message']:
        print(choice['message']['content'])
"