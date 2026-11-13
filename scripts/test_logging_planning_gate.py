"""Planning gate regressions use temporary tasks; never mutate the active project task."""
import argparse
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / ".trellis/scripts"))
import logging_planning_gate as gate
import task
from common import task_store


def plan():
    return {
        "schema_version": 1, "mode": "required", "scope": ["Backend test route"],
        "integration_points": ["registerHttpObservation and safe Pino"],
        "events": [{"event": "operation.terminal", "operation": "http.request",
                    "levels": ["info", "warn", "error"], "outcomes": ["succeeded", "failed"],
                    "fields": ["http_status", "duration_ms"]}],
        "failure_paths": ["500 and disconnect"], "correlation": "Reuse request ALS context",
        "redaction": "Reject bodies and credentials", "alerting": "Off by default; reuse rules",
        "verification": ["Run logger and HTTP regression tests"],
    }


def task_data(logging):
    return {"status": "planning", "meta": {
        "module_impact": {"schema_version": 1, "mode": "no_module_change", "reason": "Tool fixture"},
        "mobile_performance": {"schema_version": 1, "mode": "not_applicable", "reason": "Tool fixture"},
        **({"logging_integration": logging} if logging is not None else {}),
    }}


class LoggingPlanningGateTests(unittest.TestCase):
    def test_required_and_justified_non_runtime_work(self):
        gate.validate_logging_integration(task_data(plan()))
        gate.validate_logging_integration(task_data({"schema_version": 1, "mode": "not_applicable",
                                                    "reason": "Only static documentation changes"}))

    def test_missing_pending_placeholder_and_malformed_fields_fail(self):
        cases = [None, {}, {"schema_version": 1, "mode": "pending"},
                 {"schema_version": 1, "mode": "not_applicable", "reason": "TBD"}]
        for key in ("scope", "integration_points", "failure_paths", "verification", "events",
                    "correlation", "redaction", "alerting"):
            value = plan()
            del value[key]
            cases.append(value)
        for key, bad in (("event", "private user message"), ("operation", "TODO"),
                         ("fields", []), ("levels", ["warning"]), ("outcomes", ["ok"])):
            value = plan()
            value["events"][0][key] = bad
            cases.append(value)
        cases.extend([{**plan(), "scope": ["Backend", "Backend"]},
                      {**plan(), "verification": ["TODO: tests"]},
                      {**plan(), "schema_version": True}])
        for value in cases:
            with self.subTest(value=value), self.assertRaises(gate.LoggingPlanningGateError):
                gate.validate_logging_integration(task_data(value))

    def test_start_rejects_before_state_pointer_or_hooks_in_both_session_modes(self):
        for context in (None, "test-session"):
            for logging in (None, {"schema_version": 1, "mode": "pending"}):
                with self.subTest(context=context, logging=logging), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    directory = root / ".trellis/tasks/fixture"
                    directory.mkdir(parents=True)
                    path = directory / "task.json"
                    original = json.dumps(task_data(logging))
                    path.write_text(original, encoding="utf-8")
                    with patch.object(task, "get_repo_root", return_value=root), \
                         patch.object(task, "resolve_context_key", return_value=context), \
                         patch.object(task, "set_active_task") as active, \
                         patch.object(task, "run_task_hooks") as hooks, redirect_stdout(io.StringIO()):
                        self.assertEqual(task.cmd_start(argparse.Namespace(dir=str(directory))), 1)
                    active.assert_not_called()
                    hooks.assert_not_called()
                    self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_valid_plan_starts_in_degraded_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / ".trellis/tasks/fixture"
            directory.mkdir(parents=True)
            path = directory / "task.json"
            path.write_text(json.dumps(task_data(plan())), encoding="utf-8")
            with patch.object(task, "get_repo_root", return_value=root), \
                 patch.object(task, "resolve_context_key", return_value=None), \
                 patch.object(task, "run_task_hooks"), redirect_stdout(io.StringIO()):
                self.assertEqual(task.cmd_start(argparse.Namespace(dir=str(directory))), 0)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["status"], "in_progress")

    def test_create_seeds_pending_declaration_and_prd(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = argparse.Namespace(title="Logging fixture", slug="logging-fixture", assignee="tester",
                                      priority="P2", meta=None, package=None, no_start=True,
                                      description="Local gate test", parent=None)
            with patch.object(task_store, "get_repo_root", return_value=root), \
                 patch.object(task_store, "get_developer", return_value="tester"), \
                 patch.object(task_store, "run_task_hooks"), \
                 redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(task_store.cmd_create(args), 0)
            path = next((root / ".trellis/tasks").glob("*/task.json"))
            value = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(value["meta"]["logging_integration"], {"schema_version": 1, "mode": "pending"})
            self.assertIn("logging_integration", (path.parent / "prd.md").read_text(encoding="utf-8"))
            with self.assertRaises(gate.LoggingPlanningGateError):
                gate.validate_logging_integration(value)

    def test_ci_selects_only_changed_active_planning_artifacts(self):
        self.assertEqual(gate.changed_plans([
            ".trellis/tasks/new/prd.md", ".trellis/tasks/new/design.md",
            ".trellis/tasks/old/implement.md", ".trellis/tasks/old/task.json",
            ".trellis/tasks/old/verification.md", ".trellis/tasks/archive/2026-11/old/task.json",
            "packages/backend/src/app.ts", "",
        ]), [".trellis/tasks/new/task.json", ".trellis/tasks/old/task.json"])

    def test_cli_fails_closed_for_missing_json_and_invalid_base(self):
        with tempfile.TemporaryDirectory() as tmp, redirect_stderr(io.StringIO()):
            self.assertEqual(gate.main(["--task", str(Path(tmp) / "missing.json")]), 1)
            with patch.object(gate.subprocess, "check_output", side_effect=OSError("missing base")):
                self.assertEqual(gate.main(["--base", "missing"]), 1)

    def test_ci_checks_selected_files_without_requiring_untouched_legacy_plans(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            selected = root / ".trellis/tasks/current/task.json"
            legacy = root / ".trellis/tasks/untouched/task.json"
            for path, value in ((selected, task_data(plan())), (legacy, task_data(None))):
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps(value), encoding="utf-8")
            for value, expected in ((task_data(plan()), 0), (task_data(None), 1)):
                selected.write_text(json.dumps(value), encoding="utf-8")
                with patch.object(gate, "__file__", str(root / ".trellis/scripts/logging_planning_gate.py")), \
                     patch.object(gate.subprocess, "check_output", side_effect=[
                         "1234567", b".trellis/tasks/current/prd.md\0"]), \
                     redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    self.assertEqual(gate.main(["--base", "base"]), expected)


if __name__ == "__main__":
    unittest.main()
