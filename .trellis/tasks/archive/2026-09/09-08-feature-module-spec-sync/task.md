# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                 | Files / Scope                                      | Depends On | Verification                      |
| --- | ------ | ------------------------------------ | -------------------------------------------------- | ---------- | --------------------------------- |
| P0  | Done   | 调研现状并完成总体规划               | 本任务 prd/design/research/implement               | -          | `task.py validate`、人工评审      |
| T1  | Done   | 冻结模块边界、模板和任务载荷契约     | PRD/design                                         | P0         | 用户批准开始执行                  |
| T2  | Done   | 建立 shared/database 模块知识基线    | `shared/contracts/modules`、`database/.../modules` | T1         | baseline-check                    |
| T3  | Done   | 建立 backend 模块知识基线            | `backend/app/modules`                              | T1,T2      | routes/features/repositories 对照 |
| T4  | Done   | 建立 frontend 模块知识基线           | `frontend/app/modules`                             | T1-T3      | pages/components/hooks 对照       |
| T5  | Done   | 建立 admin/cs-platform 模块知识基线  | 两个 app 的 `modules`                              | T1-T3      | 页面/API/环境对照                 |
| T6  | Done   | 实现 module knowledge checker/syncer | `.trellis/scripts`、tests                          | T1-T5      | schema/path/atomic/rollback tests |
| T7  | Done   | 接入任务模板、规划和 context         | task create、workflow、process spec                | T6         | module impact 与 modules index    |
| T8  | Done   | 接入阻断式 pre-archive 与补偿        | `task_store.py`、tests                             | T6,T7      | 门禁前置、move 失败恢复           |
| T9  | Done   | 强制人工审核与 Git 提交/推送门禁     | archive/session/config/workflow                    | T7,T8      | 无自动 commit/push 回归测试       |
| T10 | Done   | observe/prepare/enforce-new 基础能力 | checker、start/archive 门禁、docs                  | T2-T9      | 当前任务 check 与 package context |
| T11 | Done   | 最终文档、全量验证与移交             | workflow/spec/tasks README                         | T10        | 全量命令通过，等待人工提交审核    |

## 评审门禁

- Gate 1：模块分类、ID、模板、载荷 schema、启用日期和 legacy 规则获批。
- Gate 2：六个 scope 基线通过工具校验和 owner 抽检；错误未知项已标待核验。
- Gate 3：同步器的失败路径、并发、幂等、路径安全和恢复全部通过，才接 archive。
- Gate 4：archive/session/hook 等所有 Trellis 路径均无法绕过人工审核自动 commit/push，且确认与最终摘要绑定。
- Gate 5：observe/prepare 无阻断性误报，才启用 enforce-new；任何停止条件立即回退开关。

## Execution Log

- 2026-09-08：读取 README、ARCHITECTURE、workflow、process spec、package spec 与 archive/hook 实现。
- 2026-09-08：确认现有 after_archive 在移动和自动提交之后且失败不阻断，不能直接承担正确性同步。
- 2026-09-08：完成需求、复用调研、技术设计、实施路线与任务拆分；未修改产品代码、Trellis 运行脚本或现有 spec 基线。
- 2026-09-08：补充强制原则：所有 Trellis 文件变更经人工审核确认后才可提交，禁止自动 commit/push；过渡期归档强制 `--no-commit` 并关闭 `session_auto_commit`。
- 2026-09-08：实现 23 个首批模块基线、确定性索引、module impact/start 门禁、归档前同步、原子写/摘要/锁/恢复和 Git 安全回归测试。
- 2026-09-08：11 项 Python 回归测试、模块 baseline/check、py_compile、Prettier、Trellis validate、package context 与 git diff check 通过；未暂存、提交或推送。
