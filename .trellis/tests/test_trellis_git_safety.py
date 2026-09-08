from __future__ import annotations

import ast
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from common.tasks import iter_active_tasks, load_task


class TrellisGitSafetyTest(unittest.TestCase):
    def test_runtime_scripts_do_not_invoke_commit_or_push(self) -> None:
        scripts = Path(__file__).resolve().parents[1] / "scripts"
        violations: list[str] = []
        for path in scripts.rglob("*.py"):
            if path.name == "safe_commit.py":
                # 保留为人工确认后的显式工具原语，运行时 task/session 不得调用。
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, (ast.List, ast.Tuple)) or not node.elts:
                    continue
                first = node.elts[0]
                if isinstance(first, ast.Constant) and first.value in {"commit", "push"}:
                    violations.append(f"{path}:{node.lineno}:{first.value}")
        self.assertEqual(violations, [], f"发现自动 Git 写操作旁路: {violations}")

    def test_session_and_archive_do_not_call_safe_git_add(self) -> None:
        scripts = Path(__file__).resolve().parents[1] / "scripts"
        for relative in ("add_session.py", "common/task_store.py"):
            content = (scripts / relative).read_text(encoding="utf-8")
            self.assertNotIn("safe_git_add(", content)

    def test_auto_commit_defaults_to_false(self) -> None:
        config = (Path(__file__).resolve().parents[1] / "scripts/common/config.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("DEFAULT_SESSION_AUTO_COMMIT = False", config)
        self.assertNotIn("return True\n", config.split("def get_session_auto_commit", 1)[1].split("def get_codex", 1)[0])

    def test_task_enumeration_skips_inaccessible_delete_pending_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            tasks_dir = Path(temp_dir)
            stale_dir = tasks_dir / "delete-pending"
            stale_dir.mkdir()
            original_is_file = Path.is_file

            def is_file_with_windows_error(path: Path) -> bool:
                if path.parent == stale_dir:
                    raise PermissionError("simulated delete-pending directory")
                return original_is_file(path)

            with patch.object(Path, "is_file", is_file_with_windows_error):
                self.assertIsNone(load_task(stale_dir))
                self.assertEqual(list(iter_active_tasks(tasks_dir)), [])


if __name__ == "__main__":
    unittest.main()