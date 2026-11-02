# 实施计划

1. 新增独立的移动端性能门禁校验器，定义版本、模式、字段类型和可操作错误信息。
2. 在新任务创建逻辑中写入 `pending` 默认值，并扩展 PRD 模板，展示 Android、iOS 页面 P95、接口 P95、观测来源和窗口的填写要求。
3. 在 `task.py start` 的任何状态写入前运行性能门禁；保留无字段历史任务兼容。
4. 更新根 `AGENTS.md`、Trellis workflow、process spec 和 tasks README，使功能开发、问题修改和方案设计均执行同一规则。
5. 新增回归测试并运行：
   - `python -m unittest discover -s .trellis/tests -p "test_*.py"`
   - `python -m compileall .trellis/scripts .trellis/tests`
   - `python ./.trellis/scripts/get_context.py --mode packages`
   - 用临时任务或单元测试确认失败不会把 `planning` 改成 `in_progress`。
6. 更新任务执行记录，检查最终 diff，使用 `task.py archive <task> --no-commit` 自动归档；不自动提交或推送。

## 风险与停止条件

- 若新校验会阻断没有新字段的历史任务，停止并修复兼容逻辑。
- 若页面或接口单侧任务被迫虚构不相关指标，停止并调整为允许 `null` 加说明。
- 若测试发现 `start` 在校验前已经写状态或活动指针，必须调整顺序后再继续。
- 不修改产品运行时、Sentry/Grafana 查询或现有性能口径实现。
