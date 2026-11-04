# 降复杂度 P2：埋点与死代码清理

## Goal

TBD.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Android/iOS 性能 P95 门禁

- 受影响页面：TBD（不涉及时填“无”）
- 受影响接口：TBD（不涉及时填“无”）
- Android 页面加载 P95：基线 TBD ms / 目标 TBD ms
- iOS 页面加载 P95：基线 TBD ms / 目标 TBD ms
- 接口 P95：基线 TBD ms / 目标 TBD ms
- 数据来源与观测窗口：TBD
- 发布后验证、无可见样本/低样本及不适用说明：TBD

规划完成后同步填写 `task.json.meta.mobile_performance`：有影响使用 `required`，确实不影响移动端页面加载和接口性能时使用 `not_applicable` 并填写具体理由。门禁未完成时 `task.py start` 会阻断。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design, `implement.md` for execution planning, and `task.md` for the executable task breakdown before `task.py start`.
