#!/usr/bin/env python3
"""Require an explicit logging integration plan before task execution."""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

PLAN_FILES = {"task.json", "prd.md", "design.md", "implement.md", "task.md"}
LEVELS = {"info", "warn", "error", "fatal", "debug", "trace"}
OUTCOMES = {"succeeded", "rejected", "failed", "timed_out", "cancelled", "interrupted",
            "degraded", "skipped", "unknown", "pending"}
NAME = re.compile(r"[a-zA-Z0-9_.:/-]{1,160}\Z")
PLACEHOLDER = re.compile(r"^(?:tbd|todo|pending|待定|待补充)(?:$|\s|[:：])", re.I)
TABLE_RULE = re.compile(r":?-{2,}:?\Z")


class LoggingPlanningGateError(ValueError):
    """The logging plan is missing, unfinished or malformed."""


def _text(value: object, field: str) -> None:
    if not isinstance(value, str) or not value.strip() or PLACEHOLDER.match(value.strip()):
        raise LoggingPlanningGateError(f"logging_integration.{field} 必须填写具体内容，不能留占位")


def _items(data: dict, field: str, prefix: str = "") -> list[str]:
    value = data.get(field)
    if not isinstance(value, list) or not value:
        raise LoggingPlanningGateError(f"logging_integration.{prefix}{field} 必须为非空数组")
    for item in value:
        _text(item, f"{prefix}{field}")
    if len(value) != len(set(value)):
        raise LoggingPlanningGateError(f"logging_integration.{prefix}{field} 不能重复")
    return value


def validate_logging_integration(task_data: dict) -> dict:
    """No missing-field grandfathering: resuming an old task requires a current plan too."""
    meta = task_data.get("meta")
    gate = meta.get("logging_integration") if isinstance(meta, dict) else None
    if not isinstance(gate, dict) or type(gate.get("schema_version")) is not int or gate["schema_version"] != 1:
        raise LoggingPlanningGateError("缺少有效 meta.logging_integration(schema_version=1)")
    mode = gate.get("mode")
    if mode == "not_applicable":
        _text(gate.get("reason"), "reason")
        return gate
    if mode != "required":
        raise LoggingPlanningGateError("logging_integration 仍为 pending 或 mode 非法；必须完成接入评估")
    for field in ("scope", "integration_points", "failure_paths", "verification"):
        _items(gate, field)
    for field in ("correlation", "redaction", "alerting"):
        _text(gate.get(field), field)
    events = gate.get("events")
    if not isinstance(events, list) or not events:
        raise LoggingPlanningGateError("logging_integration.events 必须描述新增或复用的事件")
    for index, event in enumerate(events):
        prefix = f"events[{index}]."
        if not isinstance(event, dict):
            raise LoggingPlanningGateError(f"logging_integration.{prefix}必须为对象")
        for field in ("event", "operation"):
            value = event.get(field)
            _text(value, prefix + field)
            if not NAME.fullmatch(value):
                raise LoggingPlanningGateError(f"logging_integration.{prefix}{field} 必须使用稳定事件名")
        for field, allowed in (("levels", LEVELS), ("outcomes", OUTCOMES)):
            if not set(_items(event, field, prefix)).issubset(allowed):
                raise LoggingPlanningGateError(f"logging_integration.{prefix}{field} 包含非法值")
        _items(event, "fields", prefix)
    return gate


def plan_task_dir(raw: str) -> str | None:
    path = PurePosixPath(raw)
    if (len(path.parts) == 4 and path.parts[:2] == (".trellis", "tasks")
            and path.parts[2] != "archive" and path.name in PLAN_FILES):
        return str(path.parent)
    return None


def changed_plans(paths: list[str]) -> list[str]:
    """Only touched active planning artifacts; historical archives are not retroactively gated."""
    result = set()
    for raw in paths:
        directory = plan_task_dir(raw)
        if directory:
            result.add(f"{directory}/task.json")
    return sorted(result)


def formatting_only_change(name: str, before: str | None, after: str | None) -> bool:
    """Reflow is not a resumed task. A missing side, or any real text change, still is."""
    if before is None or after is None:
        return False
    if name.endswith(".json"):
        try:
            return json.loads(before) == json.loads(after)
        except json.JSONDecodeError:
            return False
    return [_prose_token(token) for token in before.split()] == [_prose_token(token) for token in after.split()]


def _prose_token(token: str) -> str:
    # Prettier widens markdown table rules (`--` to `---`) when it pads a column.
    return "-" if TABLE_RULE.fullmatch(token) else token


def git_blob(root: Path, rev: str, rel: str) -> str | None:
    proc = subprocess.run(
        ["git", "show", "--no-ext-diff", "--end-of-options", f"{rev}:{rel}"],
        cwd=root, capture_output=True, check=False,
    )
    if proc.returncode != 0:
        return None
    try:
        return proc.stdout.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def substantive_plan_files(root: Path, base: str, changed_paths: list[str]) -> list[str]:
    """Skip tasks whose planning diff is only alignment, wrapping, or a JSON reprint."""
    grouped: dict[str, list[str]] = {}
    for raw in changed_paths:
        directory = plan_task_dir(raw)
        if directory:
            grouped.setdefault(directory, []).append(raw)
    selected = []
    for directory, files in sorted(grouped.items()):
        if any(not formatting_only_change(
            PurePosixPath(rel).name,
            git_blob(root, base, rel),
            git_blob(root, "HEAD", rel),
        ) for rel in files):
            selected.append(f"{directory}/task.json")
    return selected


def check_file(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise LoggingPlanningGateError("task.json 必须为对象")
    validate_logging_integration(data)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--task", help="Task directory or task.json path")
    choice.add_argument("--base", help="Compare active planning changes against a Git commit")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    try:
        if args.task:
            target = Path(args.task)
            target = target if target.is_absolute() else root / target
            files = [target / "task.json" if target.is_dir() else target]
        else:
            base = subprocess.check_output(
                ["git", "rev-parse", "--verify", "--end-of-options", args.base + "^{commit}"],
                cwd=root, text=True,
            ).strip()
            raw = subprocess.check_output(
                ["git", "diff", "--no-renames", "--name-only", "--diff-filter=AM", "-z", base, "HEAD", "--", ".trellis/tasks"],
                cwd=root,
            ).decode("utf-8")
            files = [root / name for name in substantive_plan_files(root, base, raw.split("\0"))]
        errors = []
        for path in files:
            try:
                check_file(path)
            except (OSError, ValueError) as exc:
                errors.append(f"{path}: {exc}")
        if errors:
            raise LoggingPlanningGateError("\n".join(errors))
        print(f"OK: logging integration planning gate ({len(files)} task(s))")
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
