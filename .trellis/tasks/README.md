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
python ./.trellis/scripts/task.py archive <task-dir> --no-commit
```

## 功能模块现状声明

- 新任务的 `task.json.meta.module_impact` 默认是 `pending`，规划完成前改为 `changes` 或 `no_module_change`；否则 `task.py start` 会阻断。
- `changes` 必须列出稳定模块 ID，并在完成阶段提供经人工审核的 `module-updates.json`。可先运行 `python ./.trellis/scripts/module_knowledge.py check <task-dir>`。
- archive 会在移动任务前确定性应用模块更新并重建索引，但只修改工作区，绝不自动暂存、提交或推送。
- 所有新增、修改、删除必须在最终 diff 和验证结果经人工明确确认后才可 `git add` / `git commit`；push 需要独立授权。
