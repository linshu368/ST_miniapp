# 任务分解

## 状态说明

- Todo：未开始
- Doing：执行中
- Done：已完成并验证
- Blocked：等待外部输入
- Skipped：已记录理由并跳过

## 任务

| ID  | Status | Task                                  | Files / Scope                       | Depends On | Verification           |
| --- | ------ | ------------------------------------- | ----------------------------------- | ---------- | ---------------------- |
| T1  | Done   | 修复 package/database/shared 工程规范 | `.trellis/spec/**` 非 module 文件   | 基线审核   | 入口和细则无已知冲突   |
| T2  | Done   | 准备受影响 module payload             | `module-updates.json`、module specs | T1         | 声明 ID 与更新完全一致 |
| T3  | Done   | 校验模块知识和 spec 索引              | `.trellis/spec/modules-index.md`    | T2         | check/rebuild 无差异   |
| T4  | Doing  | 漂移回扫与人工审核                    | 全部变更                            | T3         | P0/P1 清零，P2 有结论  |

## 执行记录

- 只处理事实基线已确认的差异；新争议退回父任务裁决。
- `module_knowledge.py check` 与 `baseline-check` 已通过；等待最终统一人工审核。
