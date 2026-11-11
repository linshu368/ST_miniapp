#!/usr/bin/env python3
"""归档长期无改动的 Trellis 任务（默认 14 天）。

为什么单独做：`task.py archive` 会先校验并写回 module-updates.json，但任务往往完成后
没有及时归档，期间别的任务改过同一份 spec，payload 摘要过期，归档被永久卡住，
活跃目录越堆越多，AI 搜索时大量命中过时的设计稿。

规则：
- 只看 Git 中该任务目录最后一次提交的日期；从未提交过的任务目录不处理。
- 还有活跃子任务的父任务不处理。
- 优先走正常的 `task.py archive`；仅当 module knowledge 门禁失败时，按同样方式
  标记 completed 并移入 archive/YYYY-MM/，失败原因写进 task.json 的 notes，
  不改 spec。

用法：
  python3 .trellis/scripts/archive_stale.py            # 只列出将被归档的任务
  python3 .trellis/scripts/archive_stale.py --apply    # 执行归档（不会自动提交）
  python3 .trellis/scripts/archive_stale.py --days 30 --apply
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TASKS = ROOT / ".trellis" / "tasks"
TASK_PY = ROOT / ".trellis" / "scripts" / "task.py"
GATE_FAILURE = "module knowledge pre-archive check failed"


def last_commit_date(task_dir: Path) -> date | None:
    out = subprocess.run(
        ["git", "log", "-1", "--format=%cs", "--", str(task_dir.relative_to(ROOT))],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.strip()
    return date.fromisoformat(out) if out else None


def read_task(task_dir: Path) -> dict:
    path = task_dir / "task.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def archive_without_module_gate(task_dir: Path, reason: str) -> None:
    data = read_task(task_dir)
    if data:
        today = date.today().isoformat()
        note = f"{today} archive_stale：module knowledge 门禁未通过，未写回 spec（{reason}）"
        data["status"] = "completed"
        data["completedAt"] = today
        data["notes"] = f"{data['notes']}\n{note}".strip() if data.get("notes") else note
        (task_dir / "task.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    month_dir = TASKS / "archive" / date.today().strftime("%Y-%m")
    month_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(task_dir), str(month_dir / task_dir.name))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=14, help="最后一次提交距今超过多少天才归档（默认 14）")
    parser.add_argument("--apply", action="store_true", help="执行归档；不带时只列出")
    args = parser.parse_args()
    cutoff = date.today() - timedelta(days=args.days)

    active = sorted(p for p in TASKS.iterdir() if p.is_dir() and p.name != "archive")
    active_names = {p.name for p in active}
    candidates = []
    for task_dir in active:
        if read_task(task_dir).get("status") == "paused":
            continue
        last = last_commit_date(task_dir)
        if last is None or last >= cutoff:
            continue
        open_children = [c for c in read_task(task_dir).get("children", []) if c in active_names]
        if open_children:
            print(f"skip {task_dir.name}: 仍有活跃子任务 {', '.join(open_children)}")
            continue
        candidates.append((task_dir, last))

    if not candidates:
        print(f"没有超过 {args.days} 天未改动的任务")
        return 0
    for task_dir, last in candidates:
        if not args.apply:
            print(f"would archive {task_dir.name}（最后改动 {last}）")
            continue
        result = subprocess.run(
            [sys.executable, str(TASK_PY), "archive", task_dir.name],
            cwd=ROOT, capture_output=True, text=True,
        )
        if result.returncode == 0:
            print(f"archived {task_dir.name}")
        elif GATE_FAILURE in result.stderr:
            reason = result.stderr.split(GATE_FAILURE, 1)[1].strip(": \n\x1b[0m")
            archive_without_module_gate(task_dir, reason)
            print(f"archived {task_dir.name}（跳过过期的 module knowledge：{reason}）")
        else:
            print(f"failed {task_dir.name}: {result.stderr.strip()}", file=sys.stderr)
    if args.apply:
        print("已在工作区完成归档，请检查 git diff 后再提交。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
