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
- 新任务的 `task.json.meta.mobile_performance` 同样默认是 `pending`。功能开发、问题修改和方案设计必须选择：
  - `required`：列出受影响页面/接口，分别填写 Android、iOS 页面加载 P95 与接口 P95 的基线、目标、来源、窗口和验证说明；无可见样本用 `null`，不得补零或推测。
  - `not_applicable`：确认不影响移动端页面加载或接口性能，并填写具体 `reason`。
- 页面不受影响时 Android/iOS 页面指标均填 `null`；接口不受影响时接口指标填 `null`。页面和接口不能同时为空，任何 `null`、低样本或双端差异都要在 `notes` 说明。

`required` 示例：

```json
{
  "schema_version": 1,
  "mode": "required",
  "pages": ["/characters"],
  "apis": ["GET /api/v1/characters"],
  "android": {
    "page_p95_baseline_ms": 4200,
    "page_p95_target_ms": 3000
  },
  "ios": {
    "page_p95_baseline_ms": null,
    "page_p95_target_ms": 3000
  },
  "api": {
    "p95_baseline_ms": 900,
    "p95_target_ms": 700
  },
  "measurement": {
    "source": "Sentry production + Grafana",
    "window": "上线前 7 天；上线后 24 小时与 7 天复核"
  },
  "notes": "iOS 基线无可见样本；按 release 复核。"
}
```

完全不适用时使用 `{"schema_version": 1, "mode": "not_applicable", "reason": "具体原因"}`。

- `changes` 必须列出稳定模块 ID，并在完成阶段提供经人工审核的 `module-updates.json`。可先运行 `python ./.trellis/scripts/module_knowledge.py check <task-dir>`。
- archive 会在移动任务前确定性应用模块更新并重建索引，但只修改工作区，绝不自动暂存、提交或推送。
- 所有新增、修改、删除必须在最终 diff 和验证结果经人工明确确认后才可 `git add` / `git commit`；push 需要独立授权。
