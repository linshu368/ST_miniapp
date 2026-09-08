#!/usr/bin/env python3
"""Trellis 功能模块知识校验与确定性同步工具（仅操作工作区，不操作 Git）。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

SCHEMA_VERSION = 1
MODULE_ID_RE = re.compile(
    r"^(frontend|backend|admin|cs-platform|shared|database)\.(business|infrastructure|shared)\.[a-z0-9]+(?:-[a-z0-9]+)*$"
)
REQUIRED_SECTIONS = (
    "职责与边界",
    "当前状态",
    "入口与调用者",
    "涉及文件",
    "关键实现链路",
    "数据、契约与外部依赖",
    "关键节点与约束",
    "验证方式",
    "已知缺口与待核验项",
    "关联模块",
)
ALLOWED_STATUS = {"active", "partial", "deprecated", "planned-removal"}
ALLOWED_MODES = {"pending", "changes", "no_module_change", "legacy_exempt"}
ALLOWED_OPERATIONS = {"create", "update", "rename", "delete"}
MAX_UPDATES = 100
MAX_CONTENT_BYTES = 256 * 1024


class KnowledgeError(Exception):
    """可向用户安全展示的校验错误。"""


@dataclass(frozen=True)
class ModuleDoc:
    path: Path
    metadata: dict[str, str]
    content: str

    @property
    def module_id(self) -> str:
        return self.metadata["module_id"]


def repo_root_from(start: Path | None = None) -> Path:
    current = (start or Path.cwd()).resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".trellis").is_dir():
            return candidate
    raise KnowledgeError("找不到包含 .trellis 的仓库根目录")


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temp_path = Path(raw)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def _safe_repo_path(root: Path, raw: str, *, modules_only: bool = False) -> Path:
    if not raw or Path(raw).is_absolute() or ".." in Path(raw).parts:
        raise KnowledgeError(f"非法仓库相对路径: {raw!r}")
    path = (root / raw).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as exc:
        raise KnowledgeError(f"路径越出仓库: {raw}") from exc
    if modules_only:
        spec_root = (root / ".trellis/spec").resolve()
        try:
            relative = path.relative_to(spec_root)
        except ValueError as exc:
            raise KnowledgeError(f"模块目标不在 .trellis/spec: {raw}") from exc
        if "modules" not in relative.parts or path.suffix != ".md" or path.name == "index.md":
            raise KnowledgeError(f"模块目标不符合 modules/<分类>/<slug>.md: {raw}")
    if path.exists() and path.is_symlink():
        raise KnowledgeError(f"拒绝写入符号链接: {raw}")
    return path


def parse_frontmatter(content: str, path: Path) -> dict[str, str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        raise KnowledgeError(f"{path}: 缺少 frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError as exc:
        raise KnowledgeError(f"{path}: frontmatter 未闭合") from exc
    metadata: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip():
            continue
        key, separator, value = line.partition(":")
        if not separator or not key.strip() or not value.strip():
            raise KnowledgeError(f"{path}: 非法 frontmatter 行: {line}")
        metadata[key.strip()] = value.strip().strip("'\"")
    return metadata


def validate_module_content(root: Path, target: Path, content: str) -> ModuleDoc:
    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise KnowledgeError(f"{target}: 模块文档超过 {MAX_CONTENT_BYTES} 字节")
    metadata = parse_frontmatter(content, target)
    required_meta = {"module_id", "title", "scope", "category", "status", "last_verified_task", "last_verified_at"}
    missing = sorted(required_meta - metadata.keys())
    if missing:
        raise KnowledgeError(f"{target}: 缺少元数据 {', '.join(missing)}")
    module_id = metadata["module_id"]
    if not MODULE_ID_RE.fullmatch(module_id):
        raise KnowledgeError(f"{target}: 非法 module_id: {module_id}")
    scope, category, slug = module_id.split(".", 2)
    expected_suffix = Path(scope if scope != "database" else "database")
    relative = target.resolve().relative_to((root / ".trellis/spec").resolve())
    if relative.parts[0] != expected_suffix.name or relative.parts[-3:] != (
        "modules",
        category,
        f"{slug}.md",
    ):
        raise KnowledgeError(f"{target}: module_id 与目标路径不一致")
    if metadata["scope"] != scope or metadata["category"] != category:
        raise KnowledgeError(f"{target}: scope/category 与 module_id 不一致")
    if metadata["status"] not in ALLOWED_STATUS:
        raise KnowledgeError(f"{target}: 非法 status: {metadata['status']}")
    for section in REQUIRED_SECTIONS:
        if f"## {section}" not in content:
            raise KnowledgeError(f"{target}: 缺少章节“{section}”")
    files_section = content.split("## 涉及文件", 1)[1].split("\n## ", 1)[0]
    referenced_paths = re.findall(
        r"`((?:packages|docs|ops|scripts|\.github|\.trellis)/[^`]+)`",
        files_section,
    )
    if not referenced_paths:
        raise KnowledgeError(f"{target}: 涉及文件章节没有仓库相对路径")
    for raw_path in referenced_paths:
        if not _safe_repo_path(root, raw_path).exists():
            raise KnowledgeError(f"{target}: 涉及文件路径不存在: {raw_path}")
    return ModuleDoc(target, metadata, content)


def iter_module_docs(root: Path) -> list[ModuleDoc]:
    docs: list[ModuleDoc] = []
    for path in sorted((root / ".trellis/spec").glob("**/modules/*/*.md")):
        if path.name == "index.md":
            continue
        docs.append(validate_module_content(root, path, path.read_text(encoding="utf-8")))
    return docs


def render_indexes(root: Path, docs: list[ModuleDoc]) -> dict[Path, bytes]:
    by_scope: dict[str, list[ModuleDoc]] = {}
    for doc in docs:
        by_scope.setdefault(doc.metadata["scope"], []).append(doc)
    outputs: dict[Path, bytes] = {}
    scope_roots = {
        "frontend": ".trellis/spec/frontend/app/modules",
        "backend": ".trellis/spec/backend/app/modules",
        "admin": ".trellis/spec/admin/app/modules",
        "cs-platform": ".trellis/spec/cs-platform/app/modules",
        "shared": ".trellis/spec/shared/contracts/modules",
        "database": ".trellis/spec/database/supabase/modules",
    }
    global_lines = ["# 功能模块现状索引", "", "本文件由 `module_knowledge.py rebuild-index` 确定性生成，请勿手工编辑。", ""]
    for scope in sorted(scope_roots):
        scope_docs = sorted(by_scope.get(scope, []), key=lambda item: item.module_id)
        lines = [f"# {scope} 功能模块现状", "", "按业务、基础设施和公共能力分类；正文只描述当前实现事实。", ""]
        global_lines.extend((f"## {scope}", ""))
        for category in ("business", "infrastructure", "shared"):
            selected = [doc for doc in scope_docs if doc.metadata["category"] == category]
            if not selected:
                continue
            lines.extend((f"## {category}", ""))
            for doc in selected:
                relative = doc.path.relative_to(root / scope_roots[scope]).as_posix()
                lines.append(f"- [{doc.metadata['title']}]({relative}) — `{doc.module_id}` · `{doc.metadata['status']}`")
                global_path = doc.path.relative_to(root / ".trellis/spec").as_posix()
                global_lines.append(f"- [{doc.metadata['title']}]({global_path}) — `{doc.module_id}` · `{category}` · `{doc.metadata['status']}`")
            lines.append("")
        if not scope_docs:
            lines.extend(("_暂无已核验模块。_", ""))
            global_lines.extend(("_暂无已核验模块。_", ""))
        else:
            global_lines.append("")
        outputs[root / scope_roots[scope] / "index.md"] = ("\n".join(lines).rstrip() + "\n").encode("utf-8")
    outputs[root / ".trellis/spec/modules-index.md"] = ("\n".join(global_lines).rstrip() + "\n").encode("utf-8")
    return outputs


def baseline_check(root: Path, *, require_indexes: bool = True) -> list[ModuleDoc]:
    docs = iter_module_docs(root)
    seen: dict[str, Path] = {}
    for doc in docs:
        if doc.module_id in seen:
            raise KnowledgeError(f"重复 module_id {doc.module_id}: {seen[doc.module_id]} / {doc.path}")
        seen[doc.module_id] = doc.path
    if require_indexes:
        for path, expected in render_indexes(root, docs).items():
            if not path.is_file() or path.read_bytes() != expected:
                raise KnowledgeError(f"索引缺失或漂移: {path.relative_to(root)}；请运行 rebuild-index")
    return docs


def validate_module_impact(task_data: dict, *, allow_pending: bool = False) -> dict:
    impact = task_data.get("meta", {}).get("module_impact") if isinstance(task_data.get("meta"), dict) else None
    if not isinstance(impact, dict) or impact.get("schema_version") != SCHEMA_VERSION:
        raise KnowledgeError("task.json 缺少有效 meta.module_impact(schema_version=1)")
    mode = impact.get("mode")
    if mode not in ALLOWED_MODES or (mode == "pending" and not allow_pending):
        raise KnowledgeError("module_impact 仍为 pending 或 mode 非法；规划完成后必须声明 changes/no_module_change")
    if mode == "changes":
        modules = impact.get("modules")
        if not isinstance(modules, list) or not modules or any(not isinstance(item, str) or not MODULE_ID_RE.fullmatch(item) for item in modules):
            raise KnowledgeError("changes 模式必须声明非空合法 modules")
        if len(modules) != len(set(modules)):
            raise KnowledgeError("module_impact.modules 存在重复项")
    elif mode in {"no_module_change", "legacy_exempt"} and not str(impact.get("reason", "")).strip():
        raise KnowledgeError(f"{mode} 必须填写 reason")
    return impact


def load_task(root: Path, raw: str) -> tuple[Path, dict]:
    candidate = Path(raw)
    task_dir = candidate if candidate.is_absolute() else root / candidate
    if not task_dir.is_dir():
        matches = list((root / ".trellis/tasks").glob(f"*-{raw}")) + list((root / ".trellis/tasks").glob(raw))
        if len(matches) == 1:
            task_dir = matches[0]
    task_json = task_dir / "task.json"
    if not task_json.is_file():
        raise KnowledgeError(f"任务不存在或缺少 task.json: {raw}")
    return task_dir.resolve(), json.loads(task_json.read_text(encoding="utf-8"))


def validate_task_updates(root: Path, task_dir: Path, task_data: dict) -> tuple[dict, list[dict]]:
    impact = validate_module_impact(task_data)
    if impact["mode"] != "changes":
        if (task_dir / "module-updates.json").exists():
            raise KnowledgeError("非 changes 模式不得存在 module-updates.json")
        return impact, []
    updates_path = task_dir / "module-updates.json"
    if not updates_path.is_file():
        raise KnowledgeError("changes 模式缺少 module-updates.json")
    payload = json.loads(updates_path.read_text(encoding="utf-8"))
    updates = payload.get("updates")
    if payload.get("schema_version") != SCHEMA_VERSION or not isinstance(updates, list) or not updates:
        raise KnowledgeError("module-updates.json schema_version/updates 非法")
    if len(updates) > MAX_UPDATES:
        raise KnowledgeError(f"单任务更新数超过 {MAX_UPDATES}")
    declared = set(impact["modules"])
    actual: set[str] = set()
    for update in updates:
        if not isinstance(update, dict) or update.get("operation") not in ALLOWED_OPERATIONS:
            raise KnowledgeError("更新项 operation 非法")
        module_id = update.get("module_id")
        if not isinstance(module_id, str) or not MODULE_ID_RE.fullmatch(module_id):
            raise KnowledgeError(f"更新项 module_id 非法: {module_id!r}")
        actual.add(module_id)
        target = _safe_repo_path(root, str(update.get("target", "")), modules_only=True)
        operation = update["operation"]
        expected = update.get("expected_sha256")
        if operation == "create":
            if target.exists():
                raise KnowledgeError(f"create 目标已存在: {update['target']}")
        elif operation == "rename":
            if target.exists():
                raise KnowledgeError(f"rename 新目标已存在: {update['target']}")
            source = _safe_repo_path(
                root, str(update.get("from_target", "")), modules_only=True
            )
            if not source.is_file():
                raise KnowledgeError(f"rename 源目标不存在: {update.get('from_target')}")
            if not isinstance(expected, str) or sha256_bytes(source.read_bytes()) != expected:
                raise KnowledgeError(f"rename 源摘要冲突: {update.get('from_target')}")
            from_module_id = update.get("from_module_id")
            if not isinstance(from_module_id, str) or not MODULE_ID_RE.fullmatch(
                from_module_id
            ):
                raise KnowledgeError("rename 必须提供合法 from_module_id")
        else:
            if not target.is_file():
                raise KnowledgeError(f"{operation} 目标不存在: {update['target']}")
            if not isinstance(expected, str) or sha256_bytes(target.read_bytes()) != expected:
                raise KnowledgeError(f"目标摘要冲突: {update['target']}")
        if operation in {"create", "update", "rename"}:
            content = update.get("content")
            if not isinstance(content, str):
                raise KnowledgeError(f"{operation} 缺少 content")
            doc = validate_module_content(root, target, content)
            if doc.module_id != module_id:
                raise KnowledgeError(f"content.module_id 与更新项不一致: {module_id}")
        if operation == "delete" and not (str(update.get("deletion_reason", "")).strip() or update.get("replacement_module_id")):
            raise KnowledgeError("delete 必须提供 deletion_reason 或 replacement_module_id")
        evidence_items = update.get("evidence")
        if not isinstance(evidence_items, list) or not evidence_items:
            raise KnowledgeError(f"{operation} 必须提供非空 evidence")
        for evidence in evidence_items:
            evidence_path = _safe_repo_path(root, str(evidence))
            if not evidence_path.exists():
                raise KnowledgeError(f"证据路径不存在: {evidence}")
    if actual != declared:
        raise KnowledgeError(f"声明模块与更新模块不一致: declared={sorted(declared)}, actual={sorted(actual)}")
    return impact, updates


class RepoLock:
    def __init__(self, root: Path, timeout: float = 5.0):
        self.path = root / ".trellis/.runtime/module-sync.lock"
        self.timeout = timeout

    def __enter__(self) -> "RepoLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump({"pid": os.getpid(), "created_at": datetime.now().isoformat()}, handle)
                return self
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise KnowledgeError(f"等待模块同步锁超时: {self.path}")
                time.sleep(0.1)

    def __exit__(self, *_: object) -> None:
        self.path.unlink(missing_ok=True)


def apply_task(root: Path, task_dir: Path, task_data: dict) -> Path | None:
    _, updates = validate_task_updates(root, task_dir, task_data)
    if not updates:
        return None
    with RepoLock(root):
        # 锁内再次校验 expected_sha，防止 check/apply 间并发覆盖。
        _, updates = validate_task_updates(root, task_dir, task_data)
        rollback_dir = root / ".trellis/.runtime/module-rollbacks"
        rollback_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = rollback_dir / f"{task_dir.name}-{int(time.time() * 1000)}.json"
        entries: list[dict] = []
        try:
            for update in updates:
                target = _safe_repo_path(root, update["target"], modules_only=True)
                operation = update["operation"]
                changed_paths = [update["target"]]
                if operation == "rename":
                    changed_paths.insert(0, update["from_target"])
                for raw_path in changed_paths:
                    changed = _safe_repo_path(root, raw_path, modules_only=True)
                    before = changed.read_bytes() if changed.exists() else None
                    entries.append(
                        {
                            "target": raw_path,
                            "existed": before is not None,
                            "content_hex": before.hex() if before is not None else "",
                        }
                    )
                if operation == "delete":
                    target.unlink()
                else:
                    if operation == "rename":
                        _safe_repo_path(
                            root, update["from_target"], modules_only=True
                        ).unlink()
                    _atomic_write(target, update["content"].encode("utf-8"))
            _atomic_write(manifest_path, json.dumps({"schema_version": 1, "entries": entries}, ensure_ascii=False, indent=2).encode("utf-8"))
            docs = baseline_check(root, require_indexes=False)
            for path, content in render_indexes(root, docs).items():
                _atomic_write(path, content)
            baseline_check(root)
            return manifest_path
        except Exception:
            for entry in reversed(entries):
                target = _safe_repo_path(root, entry["target"], modules_only=True)
                if entry["existed"]:
                    _atomic_write(target, bytes.fromhex(entry["content_hex"]))
                else:
                    target.unlink(missing_ok=True)
            raise


def rollback(root: Path, manifest: Path) -> None:
    payload = json.loads(manifest.read_text(encoding="utf-8"))
    with RepoLock(root):
        for entry in reversed(payload.get("entries", [])):
            target = _safe_repo_path(root, entry["target"], modules_only=True)
            if entry["existed"]:
                _atomic_write(target, bytes.fromhex(entry["content_hex"]))
            else:
                target.unlink(missing_ok=True)
        docs = baseline_check(root, require_indexes=False)
        for path, content in render_indexes(root, docs).items():
            _atomic_write(path, content)


def rebuild_indexes(root: Path) -> None:
    docs = baseline_check(root, require_indexes=False)
    for path, content in render_indexes(root, docs).items():
        _atomic_write(path, content)


def check_task(task_dir: Path, root: Path | None = None) -> None:
    root = root or repo_root_from(task_dir)
    resolved, task_data = load_task(root, str(task_dir))
    validate_task_updates(root, resolved, task_data)
    baseline_check(root)


def apply_for_archive(task_dir: Path, root: Path | None = None) -> Path | None:
    root = root or repo_root_from(task_dir)
    resolved, task_data = load_task(root, str(task_dir))
    return apply_task(root, resolved, task_data)


def main() -> int:
    parser = argparse.ArgumentParser(description="Trellis 功能模块知识校验与同步（不执行 Git 操作）")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("baseline-check")
    sub.add_parser("rebuild-index")
    for name in ("check", "apply"):
        command = sub.add_parser(name)
        command.add_argument("task")
    rollback_parser = sub.add_parser("rollback")
    rollback_parser.add_argument("manifest")
    args = parser.parse_args()
    try:
        root = repo_root_from()
        if args.command == "baseline-check":
            docs = baseline_check(root)
            print(f"OK: {len(docs)} 个模块文档通过校验")
        elif args.command == "rebuild-index":
            rebuild_indexes(root)
            print("OK: 模块索引已重建（工作区未提交）")
        elif args.command == "check":
            task_dir, task_data = load_task(root, args.task)
            validate_task_updates(root, task_dir, task_data)
            baseline_check(root)
            print(f"OK: {task_dir.name} 模块声明与载荷通过校验")
        elif args.command == "apply":
            task_dir, task_data = load_task(root, args.task)
            manifest = apply_task(root, task_dir, task_data)
            print(f"OK: 已应用到工作区；rollback={manifest}" if manifest else "OK: 任务显式声明无模块变更")
        else:
            rollback(root, _safe_repo_path(root, args.manifest))
            print("OK: 已恢复模块文件（工作区未提交）")
        return 0
    except (KnowledgeError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())