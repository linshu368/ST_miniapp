# 父任务分解

## 状态说明

- Todo：未开始
- Doing：执行中
- Done：已完成并验证
- Blocked：等待外部输入
- Skipped：已记录理由并跳过

## 任务

| ID  | Status | Task                                | Files / Scope                      | Depends On | Verification                        |
| --- | ------ | ----------------------------------- | ---------------------------------- | ---------- | ----------------------------------- |
| P1  | Done   | 审核并完成事实基线子任务            | `09-11-system-fact-baseline-audit` | -          | 漂移清单有证据、优先级和处理归属    |
| P2  | Done   | 审核并完成 package spec/module 同步 | `09-11-package-spec-module-sync`   | P1         | spec 索引与模块知识校验通过         |
| P3  | Done   | 审核并完成根文档/工作流门禁收口     | `09-11-docs-workflow-gate-sync`    | P1, P2     | 规则措辞一致、入口文档无已知漂移    |
| P4  | Doing  | 跨子任务集成审查                    | 全部变更                           | P1, P2, P3 | 全局扫描、格式检查和最终人工 review |

## 执行记录

- 父任务默认不直接实施；按 P1 → P2 → P3 顺序分别 `task.py start`。
- 每个子任务完成后先审核与归档，再启动依赖它的子任务。
- 本轮按用户授权连续完成子任务，统一保留未提交 diff 供最终人工审核；未执行自动归档、提交或推送。
