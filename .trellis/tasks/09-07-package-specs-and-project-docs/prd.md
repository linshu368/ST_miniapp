# 完善多包规范与全局项目文档规划

## Goal

基于仓库当前真实实现，系统梳理 `packages/frontend`、`packages/backend`、`packages/admin`、`packages/cs-platform`、`packages/shared` 的结构、职责、文件内容、组件/模块、业务功能和工程约束，形成可被 Trellis 注入的详细项目规范；同时补齐根级 AI 协作指引和项目 README，并通过 Supabase MCP 采集**测试库**元数据，形成可维护、可追溯、无敏感数据的数据库结构文档。

## Requirements

### 1. Admin 项目规范

- 盘点 `packages/admin` 的配置文件、入口、组件、`src/lib`、样式、测试和部署文件，并说明每类文件的职责与允许的依赖方向。
- 文档化当前运营后台的功能边界：鉴权、多环境切换、配置草稿/发布/回滚、模型目录、角色卡、公告、邀请裂变和回访星尘赠送等。
- 明确 React + TypeScript + Vite + Ant Design + Refine + Supabase + Zod + dnd-kit 的使用规则。
- 明确组件拆分、受控编辑器、数据访问 helper、Supabase schema/RPC、环境切换、错误处理、敏感信息、样式、测试和构建部署要求。
- 规范必须以当前实现为事实基础，不得把未落地的理想架构描述为现状；改进项需明确标记为“新增约束”或“建议”。

### 1A. Frontend 与 Backend 项目规范（用户追加范围）

- Frontend 覆盖 App Router 路由、页面/组件职责、React Query API hooks、SSE、Zustand/局部/URL/表单状态、Telegram/Sentry、安全、可访问性、测试、性能和 Vercel；明确 ST iframe/bridge 已退场。
- Backend 覆盖进程入口、routes/features/repositories/infrastructure/lib/platform/scripts/Prisma 职责、REST/SSE/支付/语音/增长数据流、鉴权、配置、可靠性、日志、测试和 Railway。
- 两端均形成专题化可导航 spec，当前事实与新增硬规则不得混淆，并保留 shared 契约先行和应用包隔离边界。

### 2. CS Platform 项目规范

- 盘点 `packages/cs-platform` 的配置、入口、API client、常量、组件、样式和部署文件，说明各文件/模块职责。
- 文档化 Telegram 用户回访与 MiniApp 客服工作台两套业务，以及它们的状态、筛选、消息、群发、导出、轮询和环境切换流程。
- 明确 React Query 作为服务器状态入口、统一 `apiClient`、认证请求头、缓存 key、mutation 失效、轮询、错误处理和纯客户端状态的边界。
- 明确组件复用、样式、可访问性、敏感 token、环境变量、测试补齐和 Vercel 静态部署要求。

### 3. Shared 项目与数据库规范

- 盘点 `packages/shared/src` 的根出口、`api/*` 契约、Zod schema、常量、默认配置、纯函数、测试、dev fixtures 和数据库环境工具。
- 明确 shared 是唯一跨应用契约层：公开请求/响应/SSE DTO 必须先定义于 `src/api/*`；应用包不得共享数据库行类型；浏览器可用模块不得引入服务端依赖。
- 明确根出口治理、类型与 runtime schema 的选择、向后兼容、命名、测试、consumer 校验和禁止承载的内容。
- 梳理 `packages/shared/migrations` 为唯一 SQL migration 来源，记录命名、不可变更、幂等/事务、权限/RLS、安全、测试、手动发布、回滚和环境差异要求。
- 通过已连接的 Supabase MCP **只读采集测试库**元数据；若实施时 MCP 未连接或目标无法确认，必须阻塞该步骤并请求用户配置，不得用猜测补齐。
- 数据库文档至少覆盖业务 schemas、tables/views、columns（类型、可空、默认值、注释）、PK/FK/unique/check、indexes、RLS、policies、functions、triggers、enums/custom types、grants 和跨 schema 依赖。
- MCP 结果必须与 `packages/shared/migrations`、`supabase/config.toml`、`ops/schema-split/inventory.sql` 及现有 schema 文档对账；明确“测试库实况”“迁移声明”“差异/待确认”，不得宣称代表生产库。
- 文档禁止包含行数据、JWT、连接串、service-role key、个人信息或其他 secret。

### 4. Trellis spec 集成

- 将规范整合至 `.trellis/spec/frontend/app/`、`.trellis/spec/backend/app/`、`.trellis/spec/admin/app/`、`.trellis/spec/cs-platform/app/`、`.trellis/spec/shared/contracts/` 和 `.trellis/spec/database/supabase/`。
- 每个 spec 入口均包含：适用范围、来源、开发前检查、硬性规则、专题文档索引和 Quality Check。
- 详细规则按职责拆分为专题文件，避免单一 `index.md` 过长；索引必须可独立指导 AI 找到对应规则。
- 保留并增强既有约束，不得无依据删除 backend 或全局已有硬规则。
- 规范不仅描述当前代码，还必须为后续 Trellis 的 `prd.md`、`design.md`、`implement.md` 和 `task.md` 提供明确设计门禁，确保规划阶段主动评估高可用、可复用、简洁实现，而不是到编码或检查阶段再补救。
- 后续复杂需求的设计必须说明：关键链路与故障模式、超时/重试/幂等/降级/可观测性、并发与容量边界、复用候选与抽象边界、最小实现及被拒绝的过度设计、兼容/迁移/回滚、测试与验收方式。不适用的项目必须写明理由，不得直接省略。
- 规范必须约束“先复用、后新增”：设计前搜索同包和 shared 的现有组件、hooks、helpers、contracts、repositories 和数据库函数；只有职责稳定且存在真实复用场景时才提取抽象，禁止为假设中的未来需求预建通用框架。
- 规范必须同时约束简洁性与可靠性：优先最少层级、最小 API 面、清晰单向依赖和可独立测试的实现；不得以“高可用”为由引入无实际故障模型支撑的复杂度，也不得以“简洁”为由省略错误处理、幂等、安全、日志或回滚。

### 5. 根级 AGENTS.md

- 整理全项目 AI/开发协作指引：项目定位、包职责、依赖边界、Trellis 流程、规范路由、技术硬规则、契约先行、数据库/迁移、服务端日志、测试门禁、安全与文档同步。
- `AGENTS.md` 保持“强制且可执行”，不复制 README 的全部入门说明；通过链接指向详细 spec 和架构文档。
- 保留 Trellis 管理块，并在管理块外维护项目规则。
- 增加面向所有后续 Trellis 任务的设计质量要求：规划必须展示复用调研、可靠性分析、最小方案、复杂度控制、验证与回滚；未通过设计门禁不得启动实施。

### 6. 根 README.md

- 新增根 `README.md`，覆盖项目简介、目录结构、各包职责、技术栈、运行环境、pnpm workspace 依赖关系、安装/开发/检查/构建命令、环境变量矩阵、Supabase 本地/测试库说明、部署拓扑和操作流程。
- 覆盖 frontend/admin/cs-platform 的 Vercel、backend 的 Railway、数据库迁移手工执行及 botlink 等独立部署单元；部署描述必须引用实际配置并区分已验证事实与待确认项。
- 说明编码规范、测试策略、commit 要求、分支/上游合并保护、secret 管理和常见文档入口。
- 环境变量只列变量名、适用包、是否必需和用途，不写入真实值；以各包 `.env.example` 和运行时配置为准。

### 7. 约束与范围

- 本任务只修改文档、Trellis spec 和任务工件，不重构产品代码、不修改数据库、不执行迁移、不改变部署配置。
- 包管理器固定为 pnpm；Node.js `>=22`；TypeScript strict；不新增 `any`。
- upstream 代码视为只读；不得为整理文档而重写、删除或简化既有实现。
- 文档使用简体中文，路径、变量名、命令和代码标识保留原文。
- 所有“当前状态”必须有仓库文件或测试库 MCP 元数据作为依据；无法核实的内容标记为待确认。

## Acceptance Criteria

- [ ] Admin spec 形成可导航的完整规范，覆盖目录/文件、组件、功能、数据访问、鉴权、环境、测试和部署规则。
- [ ] Frontend spec 形成可导航的完整规范，覆盖路由/文件、页面组件、API/SSE、状态管理、Telegram、安全、测试、性能和部署，并移除 ST bridge 现行歧义。
- [ ] Backend spec 形成可导航的完整规范，覆盖目录/文件、routes/features/repositories、调用链、可靠性、安全、日志、测试、脚本和部署。
- [ ] CS Platform spec 形成可导航的完整规范，覆盖两套业务、目录/文件、React Query/API、认证、轮询、样式、测试和部署规则。
- [ ] Shared spec 形成可导航的完整规范，覆盖公开出口、API contracts、schema/类型、纯函数、测试、消费关系与兼容策略。
- [ ] Supabase spec 和数据库参考文档覆盖测试库全部目标业务 schema 的表、字段和关键数据库对象，并标注采集环境、时间、方法及不代表生产库。
- [ ] 数据库文档完成 MCP 实况与 migrations/config/inventory 的对账，列出可解释差异和待处理差异，且不包含敏感信息或业务行数据。
- [ ] 根 `AGENTS.md` 包含全局、可执行的硬性指引，Trellis 管理块保持完整。
- [ ] 根 `README.md` 完整说明依赖、环境要求、技术栈、多包关系、启动/检查、部署、编码、commit 和环境变量。
- [ ] 各包 spec 与根 `AGENTS.md` 均建立后续 Trellis 规划门禁，能指导 PRD、design、implement、task 同时考虑高可用、复用性、简洁性、可测试性、兼容和回滚。
- [ ] 设计规则明确平衡原则：高可用基于真实故障模型，可复用基于已识别场景，简洁实现基于最小充分方案；不存在鼓励无依据抽象或过度设计的表述。
- [ ] 文档内命令、路径、包名、脚本名与当前仓库一致；内部链接有效，无互相矛盾的规则。
- [ ] `python ./.trellis/scripts/get_context.py --mode packages` 能发现并正确展示更新后的 spec 层级。
- [ ] 执行 Markdown 格式检查；若只改文档则无需运行产品构建，但需验证任务约定的链接、敏感信息扫描和 spec/task 校验。
- [ ] 用户审核规划后才可执行 `task.py start`；规划阶段不得写入上述产品文档/spec 成果。

## Notes

- 用户已确认数据库范围为“只采集测试库”。
- 测试库项目 ref 可由仓库脚本识别，但 MCP 连接身份仍需在实施时显式核验；不得仅凭 ref 推断当前 MCP 目标。
- 根目录当前缺少 `README.md`；`docs/ARCHITECTURE.md`、`ops/README.md` 和各包 README 是主要现有事实来源。
