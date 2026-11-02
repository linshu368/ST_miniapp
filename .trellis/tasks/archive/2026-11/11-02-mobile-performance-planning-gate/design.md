# Android/iOS 性能 P95 规划门禁设计

## 规则落点

新增 `task.json.meta.mobile_performance`，结构版本为 1。新任务由 `cmd_create` 写入 `pending`；`cmd_start` 在活动任务指针和状态变更之前调用独立校验器。

合法模式如下：

- `required`：任务会影响移动端页面加载或接口性能，必须填写影响范围、指标和验证信息。
- `not_applicable`：任务不影响移动端页面加载或接口性能，必须填写具体理由。
- `pending`：仅表示尚未完成规划，不能进入 `in_progress`。

`required` 使用以下最小结构：

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
    "page_p95_baseline_ms": 3500,
    "page_p95_target_ms": 3000
  },
  "api": {
    "p95_baseline_ms": 900,
    "p95_target_ms": 700
  },
  "measurement": {
    "source": "Sentry production + Grafana",
    "window": "上线前 7 天基线；上线后 24 小时与 7 天复核"
  },
  "notes": "发布按 release 对比；无样本时记录无可见样本。"
}
```

页面不受影响时，`pages` 可为空，Android/iOS 的四个页面指标填写 `null`；接口不受影响时，`apis` 可为空，接口两项指标填写 `null`。页面与接口不能同时为空。`notes` 必须解释任何 `null`、低样本或无可见样本，以及相应的上线后验证办法。所有有效毫秒值必须是大于 0 的有限数字。

## 复用调研

- 复用 `task_store.cmd_create` 的 `meta.setdefault`，与现有 `module_impact` 同位置生成默认声明。
- 复用 `task.cmd_start` 在状态写入前的前置校验顺序，避免校验失败后留下半启动状态。
- 复用 `module_knowledge` 的“独立校验函数 + 明确异常类型”模式，但性能门禁职责独立，不耦合模块知识归档。
- 复用现有 PRD/task 模板生成函数和 `unittest` 测试体系。
- 不复用 `implement.jsonl/check.jsonl` 校验：它们解决子代理上下文，不承载结构化性能指标。

## 可靠性设计

- **原子性**：所有性能校验在活动指针和 `status` 写入前完成；失败不产生部分状态。
- **超时/重试/幂等**：校验只读取内存中的 JSON，无外部调用，不需要超时或重试；重复校验结果一致。
- **并发/事务**：沿用现有单文件任务写入模型，不增加并发写入；门禁只读。
- **降级与兼容**：历史任务没有该字段时视为旧版兼容，不批量改写；新任务因默认含字段而必须通过门禁。
- **容量/限流**：校验数据规模固定且很小，不涉及容量与限流。
- **可观测性**：CLI 错误明确指出字段路径和合法模式；不打印密钥或业务数据。

## 最小充分方案

新增一个无依赖校验模块，并在创建和启动两个既有入口接线。数据仍以 `task.json` 为唯一状态源，不增加配置文件、数据库、公开服务 API 或外部依赖。拒绝通过解析 PRD 自由文本做门禁，因为易受标题和格式变化影响；也不自动查询 Sentry/Grafana，避免把权限、网络或无样本误判为无法规划。

## 演进与恢复

新字段存在即代表采用新规则，缺失则为历史任务。发布顺序是先落校验器与创建默认值，再由文档指导填写。若门禁需要紧急回滚，可同时移除 `cmd_start` 调用与 `cmd_create` 默认值；已生成的额外 metadata 对旧代码无害。后续结构演进必须提升 `schema_version` 并显式提供兼容策略，不能静默改变含义。

## 可验证性

单元测试覆盖默认生成片段、`pending` 阻断、双端字段缺失、空范围、非法/非正数指标、合法页面任务、合法接口任务、合法混合任务、`not_applicable` 理由和历史任务兼容。再运行全部 Trellis 测试、上下文生成和 Python 编译检查。人工检查错误输出是否能直接指导填写，并确认失败发生在任务状态变更之前。
