# 任务拆解

## 状态说明

- Todo：未开始
- Doing：进行中
- Done：已完成并验证
- Blocked：被外部条件阻塞
- Skipped：有记录地跳过

## 任务列表

| ID  | 状态 | 任务                                                                                                                            | 文件 / 范围                                                                                                                      | 依赖   | 验证方式                                                                 |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| T1  | Done | 梳理 backend / frontend 的 CLAUDE 规则清单，并映射到 Trellis spec、agent、workflow、process 落点                                | `packages/backend/CLAUDE.md`、`packages/frontend/CLAUDE.md`、`.trellis/spec/*`、`.trellis/agents/*`、`.trellis/workflow.md`      | -      | 已完成规则清单梳理，并按 package spec / agent / process 三类落点实施     |
| T2  | Done | 在规划与后续实现中纳入“Markdown 全中文可读、结合现有组件与功能、优先复用/扩展/高可用、实现简洁、补齐注释/文档/测试”的新增硬规则 | 当前任务文档，以及后续 Trellis 同步目标文件                                                                                      | T1     | 规划文档与 Trellis 变更文档均已改为中文，并显式加入新增硬规则            |
| T3  | Done | 扩展 backend / frontend 的 Trellis package spec，补齐缺失规则并保留来源引用                                                     | `.trellis/spec/backend/app/index.md`、`.trellis/spec/frontend/app/index.md`                                                      | T1, T2 | 两个 package spec 已补齐来源说明、包级规则与工程质量要求                 |
| T4  | Done | 强化 Trellis 的 implement / check / process 指引，使其按目录命中执行包级检查                                                    | `.trellis/agents/implement.md`、`.trellis/agents/check.md`、`.trellis/spec/docs/process/index.md`、必要时 `.trellis/workflow.md` | T1, T2 | implement / check / process 文档已补齐目录命中检查与同步义务             |
| T5  | Done | 对同步后的 Trellis 文档做一致性与可执行性校验                                                                                   | 所有改动后的 Trellis Markdown 文档                                                                                               | T3, T4 | 已运行 `get_context.py --mode packages`、Prettier 检查与关键规则定向检索 |

## 执行记录

- 2026-08-26：创建任务并完成首版规划文档。
- 2026-08-26：根据新增要求，将规划文档统一改为中文，并补入复用性、扩展性、高可用、简洁实现、注释/文档/测试等硬性规则。
- 2026-08-26：完成 Trellis spec、agent、process 文档同步，并通过 `get_context.py`、Prettier 与关键规则检索校验。
