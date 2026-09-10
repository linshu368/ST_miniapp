# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                | Files / Scope                                             | Depends On | Verification                                             |
| --- | ------ | ----------------------------------- | --------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| P0  | Done   | 仓库/PRD/参考图调研与系统规划       | 本任务 planning artifacts                                 | -          | Trellis validate；人工评审                               |
| T1  | Done   | 冻结 V1、权限、隐私、模型和生产决策 | ADR/子任务 PRD                                            | P0         | 产品/工程确认                                            |
| T2  | Todo   | Shared 契约与格式                   | `packages/shared`                                         | T1         | test/typecheck；消费者 typecheck                         |
| T3  | Todo   | Preset Platform 独立域模型与 RPC    | shared migrations                                         | T1,T2      | test 归属/shape/RLS/concurrency/rollback                 |
| T4  | Todo   | Backend 基座与鉴权                  | backend config/auth/routes foundation                     | T2,T3      | auth/env/logging tests                                   |
| T4b | Todo   | Backend 会话、草稿、发布 API        | backend route/feature/repositories                        | T2,T3,T4   | auth/conflict/idempotency tests                          |
| T5  | Todo   | 模型目录与内部生成                  | backend models/generation/prompt                          | T2,T4,T4b  | fake upstream E2E；无计费副作用                          |
| T6  | Todo   | 当前环境测试素材只读与脱敏          | backend/repository/redaction/DB grant                     | T1,T3,T4   | PII/权限负测/零写入                                      |
| T7  | Todo   | 新 SPA 骨架与部署配置               | `packages/preset-platform`、根配置、Vercel/CI/Railway env | T2,T4      | typecheck/test/build/fail-fast；Vercel Preview 只连 test |
| T8  | Todo   | 会话与模型 UI                       | 新包 conversation/models                                  | T5,T7      | A/B 隔离、Admin 同口径模型目录、模型下拉与失败 E2E       |
| T9  | Todo   | 预设管理与抽屉 UI                   | 新包 presets                                              | T4b,T7     | tabs/drawer/apply/publish/rollback/conflict E2E          |
| T10 | Todo   | 测试素材 UI                         | 新包 materials                                            | T6,T7,T8   | 当前环境角色、空态、脱敏验收                             |
| T11 | Todo   | Test 集成与体验终审                 | 全链路/Vercel test                                        | T3-T10     | PRD 路径+故障/隐私矩阵；CI/Vercel/Railway preview 配置   |
| T12 | Todo   | Production migration 与灰度         | workflow/Railway/Vercel                                   | T11        | 独立生产验证与恢复演练                                   |
| T13 | Todo   | 文档和 Trellis Spec                 | README/ARCHITECTURE/spec                                  | T11,T12    | 链接、命令、spec checklist                               |

## Child Task Tree

这些子任务是后续执行入口。父任务只保留总体规划、跨子任务约束和最终集成验收；具体实现应进入对应子任务，不在父任务里直接编码。

| Child                                         | 功能范围              | 主要交付                                                                                   | 上游依赖                              | 完成后必须同步的文档/spec                                                            |
| --------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `09-10-preset-platform-shared-contracts`      | Shared 契约           | `shared/src/api/preset-platform.ts`、导出、契约测试                                        | 父任务决策                            | `.trellis/spec/shared/contracts/*`，必要时模块索引/契约模块事实                      |
| `09-10-preset-platform-database-domain`       | 数据库独立域          | `preset_platform` schema、表、RLS/grant、RPC、migration 验证                               | Shared 契约草案                       | `.trellis/spec/database/supabase/*`、`docs/schema归属地图.md`、migration README/记录 |
| `09-10-preset-platform-backend-foundation`    | Backend 基座          | CORS/config/feature flag、Admin 账号鉴权复用、平台授权、环境指纹、基础 routes/repositories | Shared + DB                           | `.trellis/spec/backend/app/*`、backend module facts                                  |
| `09-10-preset-platform-session-preset-api`    | 会话/预设 Backend API | 私有会话、预设库、私有草稿、平台默认发布/回滚 API                                          | Shared + DB + Backend 基座            | `.trellis/spec/backend/app/*`、backend/shared module facts                           |
| `09-10-preset-platform-model-generation`      | 模型目录与生成        | Admin 同口径 OpenRouter 目录、refresh 限频、internal test generation、SSE 收口             | Backend 基座 + 会话 API               | backend spec 的 generation/model 章节、shared 契约变更说明                           |
| `09-10-preset-platform-materials-redaction`   | 测试素材与脱敏        | 当前环境角色卡只读、真实输入有界查询、关键用户信息脱敏、零写入证明                         | Backend 基座 + DB                     | backend/database 安全 spec、隐私/日志规则说明                                        |
| `09-10-preset-platform-spa-shell-deployment`  | SPA 框架与部署        | 新包、环境切换、登录壳、Vercel 配置、CI/Railway env 配置                                   | Shared + Backend 基座                 | 新增 `.trellis/spec/preset-platform/app/*`、README/ARCHITECTURE 部署口径             |
| `09-10-preset-platform-conversation-model-ui` | 会话与模型 UI         | 图 1 对话工作台、私有会话、模型目录/下拉、SSE 状态                                         | SPA 基座 + 模型生成                   | preset-platform UI/state/testing spec                                                |
| `09-10-preset-platform-preset-management-ui`  | 预设管理 UI           | 平台预设/预设库/草稿箱 Tab、对话页预设抽屉、发布/回滚/冲突交互                             | SPA 基座 + Backend 基座               | preset-platform features/UI spec                                                     |
| `09-10-preset-platform-materials-ui`          | 测试素材 UI           | 当前环境角色卡选择/导入、脱敏真实输入列表、载入当前会话                                    | SPA 基座 + 素材脱敏 Backend + 会话 UI | preset-platform features/UI/state/testing spec                                       |
| `09-10-preset-platform-integration-docs`      | 集成灰度与文档        | test/prod smoke、Vercel Preview、Railway env、最终文档/spec 同步                           | 所有实现子任务                        | 根 README、ARCHITECTURE、schema 归属、shared/backend/database/preset-platform specs  |

## 评审门禁

- Gate 1：七项决策已确认；schema、generation、环境、脱敏与限额细化方案通过评审后，实现按子任务启动。
- Gate 2：test 自动检查、`preset_platform` migration/RLS、主路径、失败路径、Vercel Preview 指向 test/preview backend，以及 `admin` 与 MiniApp 业务域零写入通过。
- Gate 3：production 独立核验、迁移确认、PII/环境/权限/限流评审及 flag/revoke/回滚可用。

## Execution Log

- 2026-09-07：创建父级规划任务并完成 Admin/Backend/Shared/Supabase 与复用调研。
- 2026-09-07：完成 PRD、技术设计、实施路线和任务树；未执行产品代码、数据库或生产操作。
- 2026-09-07：按评审意见将数据模型从 Admin 边界移出，改为由独立 `preset_platform` schema 管理；Admin 最多只复用认证能力。
- 2026-09-10：确认沿用 Admin Supabase 账号/角色表、会话/草稿私有、预设 V1 单段、支持 test/prod 切换、OpenRouter 正常模型均可选、生产库允许独立 `preset_platform` 保存工作台数据、关键用户信息脱敏且不做内容审计；同步参考 HTML 原型，将平台预设/预设库/草稿箱整合为预设管理 Tab，并在对话页通过右侧抽屉快速选择预设。
- 2026-09-10：补充部署与 CI 规划：Preset Platform 参考 Admin/CS Platform 作为独立 Vercel 静态 SPA；CI 增加新包 test/build；Railway 不新增前端服务，仅补 backend `PRESET_PLATFORM_URL`/CORS 与 PR backend 预览对齐。
- 2026-09-10：补拆 `session-preset-api` 与 `materials-ui` 两个子任务，避免 Backend API 和素材 UI 范围混入 foundation 或脱敏 backend 任务。
