# Trellis Tasks

Active tasks live here. Create a task with:

```bash
python ./.trellis/scripts/task.py create "<title>" --slug <slug>
```

The script creates `.trellis/tasks/{MM-DD-slug}/` with `task.json`, `prd.md`, and context manifests.

For complex ST_miniapp work, add:

- `design.md` — technical design, data flow, contracts, migration and rollback shape
- `implement.md` — ordered checklist, validation commands, risky files and rollout notes

Archive completed tasks with:

```bash
python ./.trellis/scripts/task.py archive <task-dir>
```
