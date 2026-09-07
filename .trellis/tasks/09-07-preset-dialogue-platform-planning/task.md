# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                | Files / Scope                         | Depends On | Verification                             |
| --- | ------- | ----------------------------------- | ------------------------------------- | ---------- | ---------------------------------------- |
| P0  | Done    | 仓库/PRD/参考图调研与系统规划       | 本任务 planning artifacts             | -          | Trellis validate；人工评审               |
| T1  | Blocked | 冻结 V1、权限、隐私、预算和生产决策 | ADR/子任务 PRD                        | P0         | 产品/安全/工程确认                       |
| T2  | Todo    | Shared 契约与格式                   | `packages/shared`                     | T1         | test/typecheck；消费者 typecheck         |
| T3  | Todo    | Preset Platform 独立域模型与 RPC    | shared migrations                     | T1,T2      | test 归属/shape/RLS/concurrency/rollback |
| T4  | Todo    | Backend 会话、草稿、发布 API        | backend route/feature/repositories    | T2,T3      | auth/conflict/idempotency tests          |
| T5  | Todo    | 模型目录与内部生成                  | backend models/generation/prompt      | T2,T4      | fake upstream E2E；无计费副作用          |
| T6  | Todo    | 生产素材只读与脱敏                  | backend/repository/redaction/DB grant | T1,T3,T4   | PII/权限负测/零写入                      |
| T7  | Todo    | 新 SPA 骨架                         | `packages/preset-platform`、根配置    | T2,T4      | typecheck/test/build/fail-fast           |
| T8  | Todo    | 会话与模型 UI                       | 新包 conversation/models              | T5,T7      | A/B 隔离与失败 E2E                       |
| T9  | Todo    | 预设、默认、草稿 UI                 | 新包 presets/drafts                   | T4,T7      | apply/publish/rollback/conflict E2E      |
| T10 | Todo    | 素材与隐私 UI                       | 新包 materials                        | T6,T7      | 下架/空态/脱敏验收                       |
| T11 | Todo    | Test 集成与体验终审                 | 全链路/Vercel test                    | T3-T10     | PRD 路径+故障/隐私矩阵                   |
| T12 | Todo    | Production migration 与灰度         | workflow/Railway/Vercel               | T11        | 独立生产验证与恢复演练                   |
| T13 | Todo    | 文档和 Trellis Spec                 | README/ARCHITECTURE/spec              | T11,T12    | 链接、命令、spec checklist               |

## 评审门禁

- Gate 1：七项决策有 owner/结论，schema、generation、环境和隐私方案通过评审；实现按子任务启动。
- Gate 2：test 自动检查、`preset_platform` migration/RLS、主路径、失败路径，以及 `admin` 与 MiniApp 业务域零写入通过。
- Gate 3：production 独立核验、迁移确认、PII/环境/权限/限流评审及 flag/revoke/回滚可用。

## Execution Log

- 2026-09-07：创建父级规划任务并完成 Admin/Backend/Shared/Supabase 与复用调研。
- 2026-09-07：完成 PRD、技术设计、实施路线和任务树；未执行产品代码、数据库或生产操作。
- 2026-09-07：按评审意见将数据模型从 Admin 边界移出，改为由独立 `preset_platform` schema 管理；Admin 最多只复用认证能力。
