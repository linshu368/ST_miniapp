# 任务分解

## 状态说明

- Todo：未开始
- Doing：执行中
- Done：已完成并验证
- Blocked：等待外部输入
- Skipped：已记录理由并跳过

## 任务

| ID  | Status | Task                              | Files / Scope                         | Depends On | Verification                   |
| --- | ------ | --------------------------------- | ------------------------------------- | ---------- | ------------------------------ |
| T1  | Done   | 同步 README/ARCHITECTURE/实施方案 | 根文档                                | 前两子任务 | 当前事实与入口一致             |
| T2  | Done   | 统一注释门禁                      | workflow、agents、skill、process/spec | T1         | 复杂注释/简单豁免语义一致      |
| T3  | Done   | 统一测试创建与验证门禁            | 同上                                  | T2         | 不自动建 test，但验证 required |
| T4  | Doing  | 流程回归、漂移扫描和人工审核      | 全部变更                              | T3         | 检查通过且无失效入口           |

## 执行记录

- 若修改 workflow-state tag body，必须同步 required walkthrough 并运行 Trellis regression。
- workflow-state body 已同步实施门禁；格式、模块基线、migration/legacy guard 与失效入口扫描已通过，等待最终人工审核。
