# 增加 Android/iOS 性能 P95 规划门禁

## Goal

为后续功能开发、问题修改和方案设计建立可执行的 Trellis 规划门禁，确保任务进入实施前已经分别评估 Android、iOS 的页面加载性能以及相关接口 P95，而不是只在规范中口头提醒。

## Requirements

- 新建任务必须默认生成 `meta.mobile_performance` 声明，初始状态为 `pending`。
- `task.py start` 必须在写入活动任务和切换状态前校验该声明；`pending` 或结构不完整时阻断启动。
- 有页面或接口性能影响的任务必须声明受影响页面与接口、Android/iOS 页面 P95 基线和目标、接口 P95 基线和目标、数据来源及验证窗口。
- 页面或接口某一侧确实不涉及时，允许使用 `null`，但必须在 `notes` 中解释边界；页面和接口不能同时为空。
- 确实不影响移动端页面加载或接口性能的任务可声明 `not_applicable`，但必须提供具体理由，确保完成过显式评估。
- 只对本次变更后新建、带 `meta.mobile_performance` 的任务强制校验；缺少该字段的历史任务保持兼容。
- 同步更新根 `AGENTS.md`、Trellis workflow/process/tasks 文档和新任务 PRD 模板，避免脚本规则与文字规则漂移。
- 错误信息必须指出缺失字段和修复方向，不得自动填充虚构 P95 数值。

## Acceptance Criteria

- [ ] 新建任务的 `task.json` 含 `meta.mobile_performance = {"schema_version": 1, "mode": "pending"}`。
- [ ] 新建任务 PRD 模板包含 Android、iOS 页面加载 P95、接口 P95、数据来源/窗口和验证方案的填写区。
- [ ] `pending`、非法模式、空受影响范围、缺失双端指标或验证信息时，`task.py start` 以非零状态退出且不改变任务状态。
- [ ] `required` 声明完整时允许启动；页面或接口单侧不适用时可用 `null` 并在 `notes` 解释。
- [ ] `not_applicable` 且理由具体时允许启动；空理由被拒绝。
- [ ] 无该字段的历史任务仍可启动。
- [ ] 自动化测试覆盖创建默认值、主要失败路径、两个合法模式和历史兼容。
- [ ] Trellis 相关测试、上下文生成及适用的格式/静态检查通过。

## Notes

- 本任务不读取或改写生产性能数据；门禁只要求规划者记录真实可用的基线，查询无样本时必须明确写“无可见样本”并制定上线后验证方案。
- 普通接口 P95 与 SSE 首字/完整流指标应遵循项目既有口径，不能用完整 SSE 连接时长冒充首字响应。
