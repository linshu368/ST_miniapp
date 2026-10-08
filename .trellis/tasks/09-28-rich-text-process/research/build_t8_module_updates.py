#!/usr/bin/env python3
"""Build the reviewed T8 module-updates payload without applying it."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
TASK = ".trellis/tasks/09-28-rich-text-process/"
VERIFIED_AT = "2026-09-30"
SECTION = "AI 回复后处理（2026-09-30）"

UPDATES = {
    "frontend.business.conversation-ui": {
        "target": ".trellis/spec/frontend/app/modules/business/conversation-ui.md",
        "summary": "记录按消息版本加载不可变 artifact、流式原文与终态 renderer/choice 交互",
        "evidence": [
            "packages/frontend/src/components/chat/chat-message-bubble.tsx",
            "packages/frontend/src/lib/api/text-postprocess.ts",
            "packages/frontend/src/lib/text-postprocess/choice-gate.ts",
        ],
        "body": """消息从历史 DTO 或 SSE `start` 保留可选 `postprocess_version`，按最多 20 个去重版本批量读取并校验不可变 artifact。旧 `NULL`、缺失/非法快照或 Worker 失败只让对应消息展示完整原始 Markdown，不读时编译 source，也不选择最新版本替代。

流式阶段保持稳定的安全 Markdown，服务端终态后才挂载 `@miniapp/reply-renderer`。可信 choice 只在最新完整 assistant 回复上复用正常 `runTurn`，同步锁保证双击只发送一次；TEST/PR Telegram 真机已验收，Production 不由此自动开放。""",
    },
    "frontend.infrastructure.client-ui-foundation": {
        "target": ".trellis/spec/frontend/app/modules/infrastructure/client-ui-foundation.md",
        "summary": "记录 reply-renderer 共用 UI 边界与文本后处理查询职责",
        "evidence": [
            "packages/reply-renderer/src/ReplyRenderer.tsx",
            "packages/reply-renderer/src/postprocess.worker.ts",
            "packages/frontend/src/lib/api/text-postprocess.ts",
        ],
        "body": """`@miniapp/reply-renderer` 是 Frontend/Admin 的共用 React 展示边界，内部以 Worker 有界执行 artifact、Showdown 渲染 Markdown、DOMPurify 清理输出并隔离 CSS/可信交互。它不拥有 API、React Query、草稿/发布状态或 source compiler。

Frontend 的版本快照查询仍位于 `src/lib/api/`；renderer 输入由调用方完成 runtime validation，失败时保留原文。consumer build 必须验证 Next/Vite 两条路径。""",
    },
    "backend.business.conversation-generation": {
        "target": ".trellis/spec/backend/app/modules/business/conversation-generation.md",
        "summary": "记录文本后处理发布服务与开轮原子版本绑定",
        "evidence": [
            "packages/backend/src/routes/text-postprocess.ts",
            "packages/backend/src/features/text-postprocess/service.ts",
            "packages/backend/src/features/conversations/generate.ts",
            "packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts",
        ],
        "body": """Admin 草稿/发布/回滚由 `routes/text-postprocess.ts` 与 `features/text-postprocess/` 编排。发布/回滚在可终止 Worker 中编译并校验 artifact，再以 CAS 与 `request_id` 原子写快照、runtime 指针、release/audit；结果未知只查询原请求 outcome，不盲重试。

发送和重生成只调用数据库 current-postprocess RPC。RPC 在开轮事务内读取权威指针、校验不可变 artifact 并返回非空版本；异常发生在 LLM、计费和 SSE 之前且不留半写，无旧 RPC fallback。""",
    },
    "backend.infrastructure.runtime-data-security": {
        "target": ".trellis/spec/backend/app/modules/infrastructure/runtime-data-security.md",
        "summary": "记录文本后处理 repository、严格配置读取和日志安全边界",
        "evidence": [
            "packages/backend/src/features/text-postprocess/config.ts",
            "packages/backend/src/features/text-postprocess/repository.ts",
            "packages/backend/src/features/text-postprocess/validate-pool.ts",
        ],
        "body": """文本后处理 repository 使用按域 Supabase client 访问 `app_core`/`admin`/`experience` RPC；Admin 严格配置读取支持 AbortSignal，发布验证使用有界 Worker pool。对话热路径不维护进程内当前版本缓存，数据库开轮事务是唯一绑定真相。

日志只允许环境、版本、request id、规则/诊断计数、耗时与结果摘要，禁止 source、artifact/聊天正文、token、session 和原始数据库错误。""",
    },
    "admin.business.operations": {
        "target": ".trellis/spec/admin/app/modules/business/operations.md",
        "summary": "记录 Demo 复现的回复富文本三栏工作台及草稿发布恢复语义",
        "evidence": [
            "packages/admin/src/components/TextPostprocessView.tsx",
            "packages/admin/src/lib/textPostprocessWorkbench.ts",
            "packages/admin/src/lib/textPostprocessPreview.ts",
        ],
        "body": """Admin 导航新增「回复富文本规则」三栏工作台：规则列表、编辑器与真实效果预览；支持五类模板、flags/稳定 ID、匹配/捕获诊断、受限 HTML/CSS、375px/自适应预览、模拟流式、历史 Drawer 和独立 System Instructions 入口。

保存只更新草稿，明确发布才切换正式版本；发布/回滚使用 CAS 与 `request_id`，结果未知通过请求恢复。预览和最终展示复用 shared 编译规则与 `ReplyRenderer`；TEST Preview 与真机验收已通过，未覆盖项和 Production 保持独立门禁。""",
    },
    "admin.infrastructure.admin-client-auth": {
        "target": ".trellis/spec/admin/app/modules/infrastructure/admin-client-auth.md",
        "summary": "记录文本后处理 Admin API、环境隔离与结果未知恢复",
        "evidence": [
            "packages/admin/src/lib/textPostprocessApi.ts",
            "packages/admin/src/lib/environment.ts",
            "packages/admin/src/App.tsx",
        ],
        "body": """`textPostprocessApi.ts` 统一处理目标环境 base URL、Supabase session、5 秒读取/写入超时、shared envelope/schema 与稳定错误。环境切换或卸载后迟到响应不得覆盖当前工作台，TEST/Production session 与请求状态隔离。

发布/回滚结果未知保留原输入和 `request_id`，通过 request lookup 回读权威 outcome；写操作不自动重试。浏览器只使用公开 `VITE_*` 和 anon key，service-role/数据库 URI 不进入 Admin。""",
    },
    "shared.business.conversation-contracts": {
        "target": ".trellis/spec/shared/contracts/modules/business/conversation-contracts.md",
        "summary": "记录文本后处理 source/artifact、版本批次与消息版本契约",
        "evidence": [
            "packages/shared/src/api/text-postprocess.ts",
            "packages/shared/src/text-postprocess/compile.ts",
            "packages/shared/src/text-postprocess/validate-artifact.ts",
            "packages/shared/src/api/conversations.ts",
        ],
        "body": """`api/text-postprocess.ts` 定义版本化 source/artifact、诊断、Admin state/mutation/request lookup 和最多 20 版本批次读取；`ChatMessage`/SSE `start` 增加向后兼容的可选 `postprocess_version`。旧缺失字段按 `NULL`，不得推断当前版本。

`text-postprocess/` 提供确定性编译、artifact 再校验和分段 apply：只允许有界正则、可信 capture/slot、受限 HTML AST 与作用域 CSS，禁止脚本/事件属性/外部资源。apply 失败返回完整原文，不输出部分污染结果。""",
    },
    "database.business.conversation-storage": {
        "target": ".trellis/spec/database/supabase/modules/business/conversation-storage.md",
        "summary": "记录消息版本 FK、不可变快照与 current-postprocess 原子开轮",
        "evidence": [
            "packages/shared/migrations/20260928_text_postprocess_versions.sql",
            "packages/shared/migrations/20260928_chat_history_postprocess_version.sql",
            "packages/shared/migrations/20260930_bind_current_text_postprocess_on_turn_start.sql",
        ],
        "body": """`experience.chat_history.postprocess_version` 可空引用 `app_core.text_postprocess_versions`；旧行不回填。新发送/重生成使用 `experience.start_chat_history_*_with_current_postprocess`，在会话锁事务内读取 runtime 正式指针、校验 source/artifact 快照并写入非空版本。

同一发布并发只会看到完整旧版或新版；配置缺失、协议错版、指针/快照错配或 RPC 未部署均整轮失败且零 history 半写。旧显式 wrapper 的 `NULL=不绑定` 仅供旧 Backend 兼容。""",
    },
    "database.infrastructure.schema-security": {
        "target": ".trellis/spec/database/supabase/modules/infrastructure/schema-security.md",
        "summary": "记录文本后处理跨域归属、不可变授权和迁移发布顺序",
        "evidence": [
            "packages/shared/migrations/20260928_text_postprocess_versions.sql",
            "packages/shared/migrations/20260929_fix_text_postprocess_snapshot_fk_lock.sql",
            "packages/shared/migrations/20260930_bind_current_text_postprocess_on_turn_start.sql",
            "packages/shared/migrations/README.md",
        ],
        "body": """文本后处理按真相拆域：`admin` 保存草稿/发布请求/审计，`app_core` 保存不可变正式 source/artifact 与 runtime 指针，`experience.chat_history` 保存消息绑定版本。发布 RPC 是快照唯一写入方；`ENABLE ALWAYS` 触发器拒绝直接 UPDATE/DELETE/TRUNCATE。

外键 `SELECT FOR KEY SHARE` 需要 owner 最小列级 UPDATE 权限，不能只验证 SELECT。current-postprocess RPC 由 postgres 拥有、`SECURITY DEFINER`、固定 search_path，仅 service_role/postgres 可执行。发布顺序为 migrations → Backend → consumers；Production 单文件执行仍需独立批准。""",
    },
}


def updated_content(raw: bytes, body: str) -> str:
    content = raw.decode("utf-8-sig")
    if re.search(r"^last_verified_task:", content, flags=re.MULTILINE):
        content = re.sub(
            r"^last_verified_task:.*$",
            f"last_verified_task: {TASK}",
            content,
            count=1,
            flags=re.MULTILINE,
        )
    else:
        content = content.replace(
            "last_verified_at:", f"last_verified_task: {TASK}\nlast_verified_at:", 1
        )
    content = re.sub(
        r"^last_verified_at:.*$",
        f"last_verified_at: {VERIFIED_AT}",
        content,
        count=1,
        flags=re.MULTILINE,
    )
    content = re.sub(
        rf"\n## {re.escape(SECTION)}\n.*?(?=\n## |\Z)",
        "",
        content,
        flags=re.DOTALL,
    )
    addition = f"\n## {SECTION}\n\n{body.strip()}\n"
    marker = "\n## 变更记录"
    if marker in content:
        content = content.replace(marker, addition + marker, 1)
    else:
        content = content.rstrip() + addition
    return content.rstrip() + "\n"


def main() -> None:
    payload = {"schema_version": 1, "updates": []}
    for module_id, spec in UPDATES.items():
        target = ROOT / spec["target"]
        raw = target.read_bytes()
        payload["updates"].append(
            {
                "operation": "update",
                "module_id": module_id,
                "target": spec["target"],
                "expected_sha256": hashlib.sha256(raw).hexdigest(),
                "content": updated_content(raw, spec["body"]),
                "change_summary": spec["summary"],
                "evidence": spec["evidence"],
            }
        )
    destination = ROOT / TASK / "module-updates.json"
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
