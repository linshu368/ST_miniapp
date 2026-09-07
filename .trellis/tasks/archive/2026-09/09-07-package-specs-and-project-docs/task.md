# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                  | Files / Scope                                                        | Depends On     | Verification                                                      |
| --- | ------ | ------------------------------------- | -------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| T1  | Done   | 建立实施基线与完整文件清单            | `packages/{admin,cs-platform,shared}`、根配置、现有 docs/spec        | -              | 受控文件和事实来源清单完整                                        |
| T2  | Done   | 持久化 Admin 详细研究与编写规范       | `research/package-inventory.md`、`.trellis/spec/admin/app/**`        | T1             | 文件/组件/功能/数据/安全/测试/部署全覆盖，index 可导航            |
| T3  | Done   | 持久化 CS Platform 详细研究与编写规范 | `research/package-inventory.md`、`.trellis/spec/cs-platform/app/**`  | T1             | 双业务流程、React Query/API/认证/轮询/部署全覆盖                  |
| T4  | Done   | 持久化 Shared 研究与编写契约规范      | `research/package-inventory.md`、`.trellis/spec/shared/contracts/**` | T1             | 出口、契约、schema/工具、consumer、兼容和测试全覆盖               |
| T5  | Done   | 通过 MCP 采集 Supabase 测试库结构     | `.trellis/spec/database/supabase/test-database-reference.md`         | T1             | 已采集用户指定参考库；与仓库正式 test ref 的身份/结构差异已标 GAP |
| T6  | Done   | 编写 Supabase/database 规范与对账流程 | `.trellis/spec/database/supabase/**`                                 | T4             | 证据标签、迁移/安全/MCP 对账规范完整，不代表生产库                |
| T7  | Done   | 重组根级 AI 协作指引与规划质量门禁    | `AGENTS.md`                                                          | T2, T3, T4, T6 | Trellis 管理块完整；规范路由及高可用/复用/简洁设计门禁可执行      |
| T8  | Done   | 新增完整项目 README                   | `README.md`                                                          | T2, T3, T4, T6 | 覆盖依赖、环境、栈、包关系、命令、部署、规范、commit、变量        |
| T9  | Done   | 全局一致性、安全、设计门禁与格式检查  | 全部任务改动                                                         | T7, T8         | 样例任务走查及 Trellis validate、格式、链接/secret 检查通过       |
| T10 | Done   | 整理用户审核与提交建议                | Git 变更集                                                           | T9             | 已整理交付摘要与建议 commit；未自动 commit/push                   |
| T11 | Done   | 补充 Frontend 完整专题规范            | `.trellis/spec/frontend/app/**`                                      | T1             | 路由、组件、API/SSE、四类状态、质量和部署覆盖                     |
| T12 | Done   | 补充 Backend 完整专题规范             | `.trellis/spec/backend/app/**`                                       | T1             | 文件职责、路由/功能、调用链、可靠性、测试和部署覆盖               |

## Execution Log

- 2026-09-07：完成仓库只读调研；确认数据库只采集测试库。
- 2026-09-07：完成 PRD、技术设计、实施计划和任务分解，等待用户审核后再启动实施。
- 2026-09-07：根据用户反馈补充文档详尽性与后续 Trellis 设计门禁，要求平衡高可用、可复用和简洁实现。
- 2026-09-07：完成四类 spec、根 AGENTS/README 和规划门禁样例；Supabase 测试库采集因当前会话无 MCP 标记 Blocked，未以迁移文件冒充实况。
- 2026-09-07：MCP 解阻；用户指定 `lhcyrmigpqeloxjrfwmn` 为本次测试参考库。完成只读结构/安全采集；发现其与仓库正式 test ref、119 个 shared migrations 及目标 schema 严重漂移，已完整标记 GAP，未执行修复。
- 2026-09-07：最终格式、Trellis context、Markdown 链接、敏感模式和 Git diff 检查通过；变更集已暂存供用户审核，未自动 commit/push。
- 2026-09-07：按用户反馈扩展范围，完成 Frontend/Backend 专题化完整 specs；Frontend 明确 ST bridge 已退场，Backend 补齐 route/feature/repository 与可靠性边界。
