#!/usr/bin/env python3
"""从飞书新版文档读取代码审查 prompt 模板。"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


TIMEOUT_SECONDS = 20
REQUIRED_PLACEHOLDERS = (
    "{architecture_doc}",
    "{src_code}",
    "{git_diff}",
)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"未设置 {name} 环境变量")
    return value


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    payload: dict[str, str] | None = None,
) -> dict[str, Any]:
    body = None
    request_headers = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json; charset=utf-8"

    request = urllib.request.Request(
        url,
        data=body,
        headers=request_headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            response_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"飞书 API 请求失败（HTTP {exc.code}）: {error_body[:500]}"
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接飞书 API: {exc.reason}") from exc

    try:
        result = json.loads(response_body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("飞书 API 返回了无效 JSON") from exc

    if not isinstance(result, dict):
        raise RuntimeError("飞书 API 返回格式异常")
    if result.get("code") != 0:
        raise RuntimeError(
            f"飞书 API 返回错误 code={result.get('code')}: {result.get('msg', '未知错误')}"
        )
    return result


def fetch_prompt() -> str:
    app_id = require_env("FEISHU_APP_ID")
    app_secret = require_env("FEISHU_APP_SECRET")
    document_id = require_env("FEISHU_DOCUMENT_ID")
    base_url = os.environ.get("FEISHU_BASE_URL", "https://open.feishu.cn").rstrip("/")

    token_result = request_json(
        f"{base_url}/open-apis/auth/v3/tenant_access_token/internal",
        method="POST",
        payload={"app_id": app_id, "app_secret": app_secret},
    )
    access_token = token_result.get("tenant_access_token")
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError("飞书鉴权响应中缺少 tenant_access_token")

    encoded_document_id = urllib.parse.quote(document_id, safe="")
    document_result = request_json(
        f"{base_url}/open-apis/docx/v1/documents/{encoded_document_id}/raw_content",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    document_data = document_result.get("data")
    if not isinstance(document_data, dict):
        raise RuntimeError("飞书文档响应中缺少 data")
    content = document_data.get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("飞书文档内容为空")

    invalid_placeholders = [
        placeholder
        for placeholder in REQUIRED_PLACEHOLDERS
        if content.count(placeholder) != 1
    ]
    if invalid_placeholders:
        names = ", ".join(invalid_placeholders)
        raise RuntimeError(f"飞书 prompt 中以下占位符必须且只能出现一次: {names}")

    return content


def main() -> None:
    if len(sys.argv) != 2:
        print("用法: fetch-feishu-prompt.py <输出文件>", file=sys.stderr)
        sys.exit(2)

    try:
        prompt = fetch_prompt()
        with open(sys.argv[1], "w", encoding="utf-8") as output_file:
            output_file.write(prompt)
    except (OSError, RuntimeError) as exc:
        print(f"❌ 获取飞书 prompt 失败: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
