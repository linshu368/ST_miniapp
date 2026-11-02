from __future__ import annotations

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import task as task_cli  # noqa: E402
from common import task_store  # noqa: E402
from mobile_performance_gate import (  # noqa: E402
    MobilePerformanceGateError,
    validate_mobile_performance,
)


def task_with_gate(gate: dict) -> dict:
    return {"meta": {"mobile_performance": gate}}


def valid_required_gate(*, pages: bool = True, apis: bool = True) -> dict:
    return {
        "schema_version": 1,
        "mode": "required",
        "pages": ["/characters"] if pages else [],
        "apis": ["GET /api/v1/characters"] if apis else [],
        "android": {
            "page_p95_baseline_ms": 4200 if pages else None,
            "page_p95_target_ms": 3000 if pages else None,
        },
        "ios": {
            "page_p95_baseline_ms": None,
            "page_p95_target_ms": 3000 if pages else None,
        },
        "api": {
            "p95_baseline_ms": 900 if apis else None,
            "p95_target_ms": 700 if apis else None,
        },
        "measurement": {
            "source": "Sentry production + Grafana",
            "window": "上线前 7 天；上线后 24 小时与 7 天",
        },
        "notes": "iOS 基线无可见样本；按 release 复核，不涉及项使用 null。",
    }


class MobilePerformanceGateTest(unittest.TestCase):
    def test_legacy_task_without_declaration_remains_compatible(self) -> None:
        self.assertIsNone(validate_mobile_performance({"meta": {}}))

    def test_pending_is_rejected(self) -> None:
        with self.assertRaisesRegex(MobilePerformanceGateError, "pending"):
            validate_mobile_performance(
                task_with_gate({"schema_version": 1, "mode": "pending"})
            )

    def test_not_applicable_requires_reason(self) -> None:
        with self.assertRaisesRegex(MobilePerformanceGateError, "reason"):
            validate_mobile_performance(
                task_with_gate(
                    {"schema_version": 1, "mode": "not_applicable", "reason": ""}
                )
            )

        gate = {
            "schema_version": 1,
            "mode": "not_applicable",
            "reason": "仅整理历史归档文件，不改变页面或接口。",
        }
        self.assertEqual(validate_mobile_performance(task_with_gate(gate)), gate)

    def test_required_accepts_page_api_and_single_side_scopes(self) -> None:
        for pages, apis in ((True, True), (True, False), (False, True)):
            with self.subTest(pages=pages, apis=apis):
                gate = valid_required_gate(pages=pages, apis=apis)
                self.assertEqual(validate_mobile_performance(task_with_gate(gate)), gate)

    def test_required_rejects_empty_scope(self) -> None:
        gate = valid_required_gate(pages=False, apis=False)
        with self.assertRaisesRegex(MobilePerformanceGateError, "不能同时为空"):
            validate_mobile_performance(task_with_gate(gate))

    def test_required_rejects_missing_platform_target(self) -> None:
        gate = valid_required_gate()
        gate["ios"]["page_p95_target_ms"] = None
        with self.assertRaisesRegex(MobilePerformanceGateError, "ios.page_p95_target_ms"):
            validate_mobile_performance(task_with_gate(gate))

    def test_required_rejects_metrics_for_unaffected_side(self) -> None:
        gate = valid_required_gate(pages=False, apis=True)
        gate["android"]["page_p95_target_ms"] = 3000
        with self.assertRaisesRegex(MobilePerformanceGateError, "都必须为 null"):
            validate_mobile_performance(task_with_gate(gate))

    def test_required_rejects_invalid_numbers_and_missing_measurement(self) -> None:
        gate = valid_required_gate()
        gate["api"]["p95_baseline_ms"] = float("nan")
        with self.assertRaisesRegex(MobilePerformanceGateError, "正数或 null"):
            validate_mobile_performance(task_with_gate(gate))

        gate = valid_required_gate()
        gate["measurement"]["window"] = ""
        with self.assertRaisesRegex(MobilePerformanceGateError, "measurement.window"):
            validate_mobile_performance(task_with_gate(gate))

    def test_create_seeds_pending_gate_and_prd_checklist(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tasks_dir = root / ".trellis" / "tasks"
            args = argparse.Namespace(
                title="测试移动端门禁",
                slug="mobile-gate-test",
                description="验证新任务默认声明",
                meta=None,
                package=None,
                assignee="tester",
                priority="P2",
                base_branch="main",
                parent=None,
                no_start=True,
            )
            with (
                patch.object(task_store, "get_repo_root", return_value=root),
                patch.object(task_store, "get_tasks_dir", return_value=tasks_dir),
                patch.object(task_store, "is_monorepo", return_value=False),
                patch.object(task_store, "get_developer", return_value="tester"),
                patch.object(task_store, "generate_task_date_prefix", return_value="11-02"),
                patch.object(task_store, "run_git", return_value=(0, "main\n", "")),
                patch.object(task_store, "resolve_default_branch", return_value="main"),
                patch.object(task_store, "_has_subagent_platform", return_value=False),
            ):
                self.assertEqual(task_store.cmd_create(args), 0)

            task_dir = tasks_dir / "11-02-mobile-gate-test"
            task_data = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
            self.assertEqual(
                task_data["meta"]["mobile_performance"],
                {"schema_version": 1, "mode": "pending"},
            )
            prd = (task_dir / "prd.md").read_text(encoding="utf-8")
            self.assertIn("## Android/iOS 性能 P95 门禁", prd)
            self.assertIn("Android 页面加载 P95", prd)
            self.assertIn("iOS 页面加载 P95", prd)
            self.assertIn("接口 P95", prd)

    def test_start_rejection_does_not_change_status(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            task_dir = root / ".trellis" / "tasks" / "11-02-test"
            task_dir.mkdir(parents=True)
            task_json = task_dir / "task.json"
            task_json.write_text(
                json.dumps(
                    {
                        "status": "planning",
                        "meta": {
                            "module_impact": {
                                "schema_version": 1,
                                "mode": "no_module_change",
                                "reason": "测试任务不更新模块事实。",
                            },
                            "mobile_performance": {
                                "schema_version": 1,
                                "mode": "pending",
                            },
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with (
                patch.object(task_cli, "get_repo_root", return_value=root),
                patch.object(task_cli, "resolve_task_dir", return_value=task_dir),
            ):
                result = task_cli.cmd_start(argparse.Namespace(dir=str(task_dir)))

            self.assertEqual(result, 1)
            stored = json.loads(task_json.read_text(encoding="utf-8"))
            self.assertEqual(stored["status"], "planning")

    def test_start_accepts_completed_mobile_performance_review(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            task_dir = root / ".trellis" / "tasks" / "11-02-test"
            task_dir.mkdir(parents=True)
            task_json = task_dir / "task.json"
            task_json.write_text(
                json.dumps(
                    {
                        "status": "planning",
                        "meta": {
                            "module_impact": {
                                "schema_version": 1,
                                "mode": "no_module_change",
                                "reason": "测试任务不更新模块事实。",
                            },
                            "mobile_performance": valid_required_gate(),
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with (
                patch.object(task_cli, "get_repo_root", return_value=root),
                patch.object(task_cli, "resolve_task_dir", return_value=task_dir),
                patch.object(task_cli, "resolve_context_key", return_value=None),
            ):
                result = task_cli.cmd_start(argparse.Namespace(dir=str(task_dir)))

            self.assertEqual(result, 0)
            stored = json.loads(task_json.read_text(encoding="utf-8"))
            self.assertEqual(stored["status"], "in_progress")


if __name__ == "__main__":
    unittest.main()
