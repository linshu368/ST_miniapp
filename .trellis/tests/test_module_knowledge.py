from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from module_knowledge import (  # noqa: E402
    KnowledgeError,
    apply_for_archive,
    apply_task,
    baseline_check,
    rebuild_indexes,
    rollback,
    validate_module_impact,
)


def module_content(module_id: str = "backend.business.demo", title: str = "示例") -> str:
    scope, category, _ = module_id.split(".", 2)
    section_names = (
        "职责与边界", "当前状态", "入口与调用者", "关键实现链路",
        "数据、契约与外部依赖", "关键节点与约束", "验证方式", "已知缺口与待核验项", "关联模块",
    )
    sections = "\n\n".join(f"## {name}\n\n已核验。" for name in section_names)
    sections = sections.replace(
        "## 关键实现链路",
        "## 涉及文件\n\n| 路径 | 职责 |\n| --- | --- |\n| `.trellis/tasks/09-08-test/task.json` | 测试证据 |\n\n## 关键实现链路",
    )
    return f"""---
module_id: {module_id}
title: {title}
scope: {scope}
category: {category}
status: active
owners: [test]
last_verified_task: .trellis/tasks/archive/2026-09/test/
last_verified_at: 2026-09-08
---

# {title}

{sections}
"""


class ModuleKnowledgeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / ".trellis/spec").mkdir(parents=True)
        (self.root / ".trellis/tasks/09-08-test").mkdir(parents=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_task(self, impact: dict, updates: list[dict] | None = None) -> tuple[Path, dict]:
        task_dir = self.root / ".trellis/tasks/09-08-test"
        data = {"meta": {"module_impact": impact}}
        (task_dir / "task.json").write_text(json.dumps(data), encoding="utf-8")
        if updates is not None:
            (task_dir / "module-updates.json").write_text(
                json.dumps({"schema_version": 1, "updates": updates}), encoding="utf-8"
            )
        return task_dir, data

    def evidence(self) -> list[str]:
        return [".trellis/tasks/09-08-test/task.json"]

    def test_pending_is_blocked(self) -> None:
        with self.assertRaises(KnowledgeError):
            validate_module_impact({"meta": {"module_impact": {"schema_version": 1, "mode": "pending"}}})

    def test_create_apply_is_idempotent_at_content_level_and_rollback(self) -> None:
        target = ".trellis/spec/backend/app/modules/business/demo.md"
        content = module_content()
        task_dir, data = self.write_task(
            {"schema_version": 1, "mode": "changes", "modules": ["backend.business.demo"]},
            [{"operation": "create", "module_id": "backend.business.demo", "target": target, "content": content, "evidence": self.evidence()}],
        )
        manifest = apply_task(self.root, task_dir, data)
        self.assertEqual((self.root / target).read_text(encoding="utf-8"), content)
        self.assertIsNotNone(manifest)
        baseline_check(self.root)
        rollback(self.root, manifest)  # type: ignore[arg-type]
        self.assertFalse((self.root / target).exists())

    def test_update_rejects_stale_digest(self) -> None:
        target = self.root / ".trellis/spec/backend/app/modules/business/demo.md"
        target.parent.mkdir(parents=True)
        target.write_text(module_content(), encoding="utf-8")
        task_dir, data = self.write_task(
            {"schema_version": 1, "mode": "changes", "modules": ["backend.business.demo"]},
            [{"operation": "update", "module_id": "backend.business.demo", "target": target.relative_to(self.root).as_posix(), "expected_sha256": "0" * 64, "content": module_content(title="新标题"), "evidence": self.evidence()}],
        )
        with self.assertRaises(KnowledgeError):
            apply_task(self.root, task_dir, data)

    def test_baseline_rejects_missing_referenced_path(self) -> None:
        target = self.root / ".trellis/spec/backend/app/modules/business/demo.md"
        target.parent.mkdir(parents=True)
        target.write_text(
            module_content().replace(
                ".trellis/tasks/09-08-test/task.json", "packages/missing.ts"
            ),
            encoding="utf-8",
        )
        with self.assertRaises(KnowledgeError):
            baseline_check(self.root, require_indexes=False)

    def test_update_with_digest(self) -> None:
        target = self.root / ".trellis/spec/backend/app/modules/business/demo.md"
        target.parent.mkdir(parents=True)
        target.write_text(module_content(), encoding="utf-8")
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        task_dir, data = self.write_task(
            {"schema_version": 1, "mode": "changes", "modules": ["backend.business.demo"]},
            [{"operation": "update", "module_id": "backend.business.demo", "target": target.relative_to(self.root).as_posix(), "expected_sha256": digest, "content": module_content(title="新标题"), "evidence": self.evidence()}],
        )
        apply_task(self.root, task_dir, data)
        updated = target.read_text(encoding="utf-8")
        self.assertIn("新标题", updated)
        self.assertNotIn("## 变更记录", updated)

    def test_apply_for_archive_appends_change_history(self) -> None:
        target = self.root / ".trellis/spec/backend/app/modules/business/demo.md"
        target.parent.mkdir(parents=True)
        target.write_text(module_content(), encoding="utf-8")
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        task_dir, data = self.write_task(
            {"schema_version": 1, "mode": "changes", "modules": ["backend.business.demo"]},
            [
                {
                    "operation": "update",
                    "module_id": "backend.business.demo",
                    "target": target.relative_to(self.root).as_posix(),
                    "expected_sha256": digest,
                    "content": module_content(title="新标题"),
                    "change_summary": "补充归档历史记录",
                    "evidence": self.evidence(),
                }
            ],
        )
        data.update({"title": "测试任务"})
        (task_dir / "task.json").write_text(json.dumps(data), encoding="utf-8")
        apply_for_archive(task_dir, self.root)
        updated = target.read_text(encoding="utf-8")
        self.assertIn("新标题", updated)
        self.assertIn("## 变更记录", updated)
        self.assertIn("任务 `测试任务`", updated)
        self.assertIn("`.trellis/tasks/archive/", updated)
        self.assertIn("补充归档历史记录", updated)
        self.assertIn("commit：未记录", updated)
        baseline_check(self.root)

    def test_apply_for_archive_uses_default_change_summary(self) -> None:
        target = ".trellis/spec/backend/app/modules/business/demo.md"
        content = module_content()
        task_dir, data = self.write_task(
            {"schema_version": 1, "mode": "changes", "modules": ["backend.business.demo"]},
            [
                {
                    "operation": "create",
                    "module_id": "backend.business.demo",
                    "target": target,
                    "content": content,
                    "evidence": self.evidence(),
                }
            ],
        )
        apply_for_archive(task_dir, self.root)
        updated = (self.root / target).read_text(encoding="utf-8")
        self.assertIn("创建模块知识文档", updated)

    def test_path_traversal_is_rejected(self) -> None:
        task_dir, data = self.write_task(
            {"schema_version": 1, "mode": "changes", "modules": ["backend.business.demo"]},
            [{"operation": "create", "module_id": "backend.business.demo", "target": "../demo.md", "content": module_content(), "evidence": self.evidence()}],
        )
        with self.assertRaises(KnowledgeError):
            apply_task(self.root, task_dir, data)

    def test_rename_and_rollback(self) -> None:
        source = self.root / ".trellis/spec/backend/app/modules/business/demo.md"
        source.parent.mkdir(parents=True)
        source.write_text(module_content(), encoding="utf-8")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        target_raw = ".trellis/spec/backend/app/modules/business/renamed.md"
        task_dir, data = self.write_task(
            {
                "schema_version": 1,
                "mode": "changes",
                "modules": ["backend.business.renamed"],
            },
            [
                {
                    "operation": "rename",
                    "module_id": "backend.business.renamed",
                    "from_module_id": "backend.business.demo",
                    "from_target": source.relative_to(self.root).as_posix(),
                    "target": target_raw,
                    "expected_sha256": digest,
                    "content": module_content("backend.business.renamed", "已重命名"),
                    "evidence": self.evidence(),
                }
            ],
        )
        manifest = apply_task(self.root, task_dir, data)
        self.assertFalse(source.exists())
        self.assertTrue((self.root / target_raw).exists())
        rollback(self.root, manifest)  # type: ignore[arg-type]
        self.assertTrue(source.exists())
        self.assertFalse((self.root / target_raw).exists())

    def test_delete_requires_reason_and_applies(self) -> None:
        target = self.root / ".trellis/spec/backend/app/modules/business/demo.md"
        target.parent.mkdir(parents=True)
        target.write_text(module_content(), encoding="utf-8")
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        task_dir, data = self.write_task(
            {
                "schema_version": 1,
                "mode": "changes",
                "modules": ["backend.business.demo"],
            },
            [
                {
                    "operation": "delete",
                    "module_id": "backend.business.demo",
                    "target": target.relative_to(self.root).as_posix(),
                    "expected_sha256": digest,
                    "deletion_reason": "实现已删除",
                    "evidence": self.evidence(),
                }
            ],
        )
        apply_task(self.root, task_dir, data)
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
