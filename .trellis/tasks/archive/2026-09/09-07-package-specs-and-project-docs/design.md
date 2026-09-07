# 技术设计：多包规范与全局项目文档

## 1. 设计目标

本任务建立一套“事实盘点 → 规范提炼 → Trellis 注入 → 全局导航”的文档体系。成果应同时服务人工开发者和 AI：README 负责入门与运行，AGENTS 负责强制协作规则，Trellis spec 负责按包/层注入详细编码规范，数据库参考文档负责描述 Supabase 测试库实况。

## 2. 信息来源与优先级

出现冲突时按下列优先级处理，并在文档中记录差异：

1. Supabase MCP 对测试库的只读元数据（仅数据库现状）；
2. 当前分支受版本控制的源码与配置；
3. `packages/shared/migrations` 对预期数据库演进的声明；
4. `.trellis/spec/backend/app/` 和根 `AGENTS.md` 的现行硬规则；
5. `docs/ARCHITECTURE.md`、`ops/**`、包 README 和历史 schema 文档；
6. 推断只能标为“建议”或“待确认”，不能写成事实。

测试库元数据不代表生产库。迁移文件也不必然代表测试库已执行状态，两者必须并列展示而非互相覆盖。

## 3. 目标文档架构

### 3.1 Admin spec

保留 `.trellis/spec/admin/app/index.md` 作为注入入口，建议新增：

- `architecture-and-files.md`：包定位、技术栈、完整目录与逐文件/文件组职责、入口和依赖方向；
- `features-and-components.md`：鉴权、工作区、配置编辑器、模型、角色卡、公告、裂变、赠送等功能和组件约定；
- `data-auth-and-environments.md`：`src/lib` API/Supabase 访问、schema/RPC、session、测试/生产环境切换、安全边界；
- `ui-state-and-validation.md`：AntD/Refine、受控状态、Zod、拖拽、错误/加载反馈、样式和可访问性；
- `testing-build-and-deployment.md`：Vitest、typecheck/build、Vite/Vercel、环境变量和发布前检查。

### 3.2 CS Platform spec

保留 `.trellis/spec/cs-platform/app/index.md`，建议新增：

- `architecture-and-files.md`：技术栈、入口、完整目录和文件职责；
- `features-and-components.md`：Telegram 回访与 MiniApp 客服的流程、组件、状态边界；
- `api-query-and-auth.md`：统一 API client、shared DTO、React Query、query key、mutation、轮询、请求头、错误和环境切换；
- `ui-state-and-accessibility.md`：三栏工作台、局部状态、CSS、交互反馈和可访问性；
- `testing-build-and-deployment.md`：测试缺口与新增测试规则、typecheck/build、Vite/Vercel 和变量要求。

### 3.3 Shared contracts spec

保留 `.trellis/spec/shared/contracts/index.md`，建议新增：

- `architecture-and-exports.md`：包职责、完整目录、根出口、browser-safe 和依赖边界；
- `api-contracts.md`：请求/响应/SSE、错误包络、Zod 与 TS 类型、命名、兼容和 consumer 迁移；
- `schemas-utilities-and-fixtures.md`：runtime schemas、常量、默认配置、纯函数、fixtures 的适用边界；
- `testing-and-change-management.md`：契约测试、行为测试、所有消费者 typecheck、破坏性变更审查。

### 3.4 Supabase/database spec 与参考文档

保留 `.trellis/spec/database/supabase/index.md` 为数据库开发入口，并新增或完善：

- `schema-and-object-conventions.md`：逻辑 schema 归属、命名、类型、PK/FK/index/comment；
- `migrations-and-rollbacks.md`：shared migrations 唯一来源、文件不可改写、部署/验证/回滚；
- `security-rls-and-grants.md`：RLS、policy、grant、SECURITY DEFINER/search_path 和 secret；
- `introspection-and-documentation.md`：MCP 只读采集、脱敏、对账、生成文档和更新频率。

数据库实况建议放在 `.trellis/spec/database/supabase/test-database-reference.md`。若体量过大，按 schema 拆到 `reference/`，由总索引列出对象数量、采集时间、项目 ref（非 secret）和差异摘要。文档只记录结构元数据，不记录业务数据样本。

### 3.5 根文档职责

- `README.md`：面向新成员的项目说明、环境准备、workspace、命令、技术栈、依赖图、变量矩阵、部署和贡献流程。
- `AGENTS.md`：面向 AI/自动化的硬规则和规范路由。保留 Trellis 管理块，项目自定义内容置于块外。
- `docs/ARCHITECTURE.md`：继续作为深层架构事实，不在 README 重复所有路由/数据表细节。

## 4. 数据库 MCP 采集设计

### 4.1 前置门禁

1. 确认 MCP server 已连接且明确指向测试项目；项目 ref 应与仓库 `supabase:link:test` 一致。
2. 使用只读元数据能力。若工具只能执行 SQL，查询必须仅访问 catalog/information_schema/pg_catalog，不执行 DDL/DML。
3. 不获取表行、auth 用户、日志内容或 secret；输出先做敏感字段名审查。

### 4.2 采集对象

按业务 schema 采集：schema 清单、relations、views/materialized views、columns、defaults、identity/generated、comments、PK/FK/unique/check、indexes、RLS 开关、policies、functions/procedures（签名、返回值、安全模式、语言、注释）、triggers、enum/custom types、grants 和跨 schema 依赖。

默认业务范围为 `app_core`、`miniapp_features`、`experience`、`billing`、`admin`、`cs_platform`、`miniapp_traffic`、`miniapp_analytics`；同时核实 `public`、`miniapp`、`graphql_public` 是否仅为兼容/系统暴露。系统 schemas 不逐对象展开。

### 4.3 对账模型

每个结论附来源标签：

- `TEST-DB`：MCP 采集到的测试库实况；
- `MIGRATION`：shared migration 声明；
- `CONFIG`：Supabase/PostgREST 配置；
- `DOC`：现有文档声明；
- `GAP`：来源冲突或无法解释。

对账重点：schema 暴露列表、迁移重号/回滚/环境特例、对象缺失、额外对象、RLS/policy/grant 差异、函数签名和跨 schema FK。禁止仅凭迁移编号推断执行状态。

## 5. 规范写作模型

每个规则采用“要求 + 原因/风险 + 正确落点 + 验证方式”，并区分：

- **MUST/禁止**：项目硬约束；
- **SHOULD/优先**：默认模式，偏离需说明；
- **现状说明**：帮助定位但不构成未来强制；
- **改进建议**：不在本任务中改产品代码。

文件说明可按“逐文件”与“同模式文件组”结合，确保所有受版本控制的源码均能在目录地图中找到归属，同时避免机械复制文件名造成难维护。

### 5.1 后续 Trellis 任务的设计质量门禁

本次新增的根指引和包级 spec 必须把以下内容变成后续任务的默认规划框架，而非仅作为宽泛口号：

1. **需求与 SLO/影响面**：PRD 明确用户价值、关键链路、数据一致性要求、可接受失败方式和验收指标；没有明确业务依据时，不虚构严格 SLO。
2. **现有能力复用调研**：Design 在新增模块前列出检索过的组件、hooks、API helpers、shared contracts、backend features/repositories 和数据库函数，说明复用、扩展或不复用的理由。
3. **高可用设计**：对真实外部依赖和关键写链路评估超时、有限重试、退避、幂等、并发竞争、事务边界、降级、补偿、限流、缓存一致性、日志/指标/告警。仅在适用时采用，并记录不适用项。
4. **复用边界**：优先复用稳定的领域契约和纯逻辑；应用 UI、鉴权和部署边界保持隔离。抽象至少应有明确职责和现实消费者，禁止将不同业务只因代码相似强行合并。
5. **简洁实现**：先给出最小充分方案，控制文件数、层级、状态源、公开 API 和新依赖；说明为何没有选择更复杂方案。简洁不等于省略安全、错误处理、日志、测试和回滚。
6. **演进与兼容**：说明合同兼容、数据库迁移、灰度/发布顺序、旧数据处理、回滚点和恢复流程，避免跨包一次性破坏性切换。
7. **可验证性**：Implement 和 Task 将可靠性、复用边界、失败路径、consumer 校验和回滚验证拆成可执行检查，不只验证 happy path。

建议在各 spec 中提供统一的规划检查表：

- `prd.md`：目标、范围、关键质量属性和可量化验收；
- `design.md`：现状/复用调研、方案、故障模型、边界、权衡、兼容、发布/回滚；
- `implement.md`：按依赖顺序的最小增量、每阶段验证、观察点和停止条件；
- `task.md`：文件范围、依赖、状态和可执行验证命令/人工场景。

### 5.2 高可用、复用与简洁性的平衡准则

- **高可用不是堆组件**：只有明确故障模式、业务影响和验证方法时才增加重试、队列、缓存或冗余；重试必须有限且仅用于可安全重试操作。
- **可复用不是提前泛化**：先复用既有稳定接口；新抽象以真实重复、稳定变化轴和清晰所有权为依据。
- **简洁不是短代码优先**：以认知复杂度、状态源数量、依赖方向和可测试性衡量；允许为可靠性保留必要的显式代码。
- 三者冲突时，优先满足明确的业务正确性和安全约束，再选择满足需求的最小复杂度方案，并把权衡写入设计文档。

## 6. 兼容、安全与回滚

- 只改 Markdown/Trellis 工件，不改变运行时行为。
- 保留旧 index 中所有仍有效规则；发现冲突先记录，不能静默弱化 backend/全局规范。
- 不写真实 `.env` 内容；变量表从 `.env.example`、config 读取点和部署模板推导。
- 回滚可按文档文件恢复；数据库采集是只读操作，无数据库回滚步骤。
- 上游变更不被重写；若实现与既有规范冲突，文档描述现状并建立待决项。

## 7. 验证策略

- 结构：所有目标文件存在，index 链接可达，Trellis package context 可发现；
- 事实：路径、命令、变量、依赖、部署目标与源码/配置逐项抽查；
- 数据库：记录采集环境/时间/MCP 方法，对象数量和关键对象与 inventory/migrations 对账；
- 安全：扫描 JWT、Supabase key、数据库 URI、私钥和真实环境值；
- 一致性：README、AGENTS、ARCHITECTURE、各 spec 不互相矛盾；
- 格式：Prettier Markdown check 或限定文件格式检查，Trellis task validate。

## 8. 待用户审核决策

- 已确定：只采集测试库，不生成 test/prod 差异报告。
- 默认建议：数据库参考文档按对象数量决定单文件或按 schema 拆分，入口保持稳定。
- 默认建议：本任务不修复调研发现的产品测试/架构缺口，只将其写入规范或后续改进清单。
