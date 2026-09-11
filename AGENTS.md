<!-- TRELLIS:START -->

# Trellis 指南

这些说明是针对在本项目中工作的 AI 助手的。

本项目由 Trellis 管理。你需要的工作知识都在 `.trellis/` 目录下：

- `.trellis/workflow.md` — 开发阶段、何时创建任务、技能分配
- `.trellis/spec/` — 包和层级范围的编码指南
- `.trellis/workspace/` — 每位开发者的工作日志和会话记录
- `.trellis/tasks/` — 活跃和存档任务（`task.json`、`prd.md`、`design.md`、`implement.md`）

如果你的平台支持 Trellis 命令，优先使用它而不是手动操作。并不是每个平台都能使用所有命令。

如果你在使用 Cursor，Trellis 技能位于 `.cursor/skills/trellis-*`。

由 Trellis 管理。块外编辑会被保留；块内编辑可能会在未来的 `trellis update` 中被覆盖。

<!-- TRELLIS:END -->

## ST_miniapp Project Rules

### 1. 项目与规范入口

这是由五个 pnpm workspace 包组成的多应用项目。开始工作前先读根 `README.md` 和 `docs/ARCHITECTURE.md`，再按改动范围读取：

- Frontend：`.trellis/spec/frontend/app/index.md`
- Backend：`.trellis/spec/backend/app/index.md`
- Admin：`.trellis/spec/admin/app/index.md`
- CS Platform：`.trellis/spec/cs-platform/app/index.md`
- Shared contracts：`.trellis/spec/shared/contracts/index.md`
- Supabase/migrations：`.trellis/spec/database/supabase/index.md`
- 跨层设计：`.trellis/spec/guides/cross-layer-thinking-guide.md`

若文档与实现冲突，先记录来源和差异，不得把推断写成当前事实。

### 2. Trellis 工作流

对于非琐碎的工作，使用 Trellis：

1. 在 `.trellis/tasks/` 下创建任务，命令为 `python ./.trellis/scripts/task.py create "<title>" --slug <slug>`。
2. 保持 `prd.md` 只关注需求、约束和验收标准。
3. 对于复杂任务，创建 `design.md` 写技术设计，`implement.md` 写执行计划，`task.md` 写可执行的任务分解，然后再执行 `task.py start`。
4. 在规划文档被审核完成并且任务移到 `in_progress` 之前，不要写产品代码。
5. 在派发子代理时，用 `implement.jsonl` 和 `check.jsonl` 列出相关的规范/研究文件。

复杂任务在 `task.py start` 前必须通过以下规划门禁：

1. **复用调研**：列出检索过的组件、hooks、helpers、contracts、features/repositories 和数据库函数，并说明复用、扩展或不复用理由。
2. **可靠性设计**：基于真实故障模型评估超时、有限重试、幂等、并发、事务、降级、补偿、限流、容量和可观测性；不适用项也要说明。
3. **最小充分方案**：控制新文件、层级、状态源、公开 API 和依赖；说明拒绝的过度设计。禁止为假设中的未来需求建立通用框架。
4. **演进与恢复**：说明兼容、迁移/发布顺序、旧数据、灰度、停止条件、回滚或 forward-fix。
5. **可验证性**：`implement.md`/`task.md` 必须覆盖失败路径、consumer 校验、人工场景和可执行命令，而不只验证 happy path。

高可用、复用与简洁必须平衡：高可用不是堆组件，复用不是提前泛化，简洁不是省略安全、错误处理、日志、测试或恢复。冲突时先保证业务正确性与安全，再采用满足需求的最低复杂度。

### 3. 全局硬性规则

- 包管理器：`pnpm`；运行时：Node.js `>=22`。
- TypeScript 严格模式；不要添加 `any`。
- 外部数据契约必须在 `packages/shared/src/api/*` 中定义，然后才能被后端处理器或前端使用者使用。
- `frontend`、`backend`、`admin` 和 `cs-platform` 之间不能互相导入；跨应用调用使用 HTTP。
- 前端/管理端/CS 端代码不能直接使用数据库行类型。
- Frontend 服务器数据必须通过 `src/lib/api/` 的 React Query hooks 获取；Admin/CS 按各自 spec 使用统一 helper/client。组件层不得散落直接 `fetch`。
- 每个 Fastify 路由注册都必须保留附近的 `@frontend-ready: true|false` 注释。
- LLM 生成和计费必须通过 `packages/backend/src/features/generation/` 进行。
- 运行时配置必须通过 `packages/backend/src/platform/runtime-config.ts` 读取。
- 数据库迁移位于 `packages/shared/migrations/`，并且是手动执行的；生产环境的迁移需要先测试验证并附带回滚说明。
- 服务器日志使用现有的 pino 规范。原始错误要记录为 `{ err }`，而不是 `String(err)`。
- 服务端 route 使用 pino 记录允许的请求字段、结果摘要、耗时和链路上下文，以便 Railway 排障；禁止记录 token、密钥、完整 initData、支付私钥、个人敏感信息或大响应正文。
- 所有外部调用必须有明确超时；重试必须有限、仅用于可安全重试操作，并考虑退避/限流。关键写入需评估幂等和并发一致性。
- 对复杂方法、业务编排、非显然约束、关键状态转换和边界处理，尽量补充解释“为什么这样做”的必要且简洁注释；简单、直观、代码已能自解释的方法无需注释，不添加复述代码行为的注释。`@frontend-ready`、migration domain 等项目要求的结构化注释仍必须保留。
- 默认不因新增或修改代码自动创建测试文件。只有用户明确要求、审核后的规划或验收标准确认需要，或明确风险评估认定必须用回归测试锁定时才创建；安全、计费、并发、契约、迁移等专项测试要求仍需按相关 spec 评估和执行。
- 环境变量和 secret 不得写入源码、日志、URL、测试 fixture 或 Markdown；浏览器端 `NEXT_PUBLIC_*`/`VITE_*` 一律视为公开。
- 修改跨包契约后运行 shared 测试及所有消费者 typecheck；修改部署/环境/数据库行为时同步 README、架构和相关 spec。

### 4. 数据库与环境

- test 与 production 不保证同构，必须明确当前操作环境；不得用测试库结论代替生产实况。
- `packages/shared/migrations/` 是唯一 migration 源，不得创建 `supabase/migrations/` 平行来源或改写历史 migration。
- migration 一次执行一个文件，记录前后 shape、权限/RLS、关键读写、锁/容量和回滚。
- Supabase MCP 只允许在确认连接目标后执行只读结构采集；禁止读取业务行或将敏感导出提交 Git。

### 5. 验证与提交

- 无论是否创建测试文件，都必须运行适用的既有验证：至少包括受影响包的 typecheck、现有相关测试及适用的 lint、build、静态检查或人工回归；跨包/部署改动运行 build 与 `pnpm -r typecheck`。不能运行的检查必须说明原因和风险。
- bug 修复以及安全、计费、并发、契约、迁移等高风险改动，应在规划和风险评估中确认是否需要创建回归测试文件；未获确认时不得自动创建，但必须运行既有验证并记录可重复人工验证与剩余风险。
- commit 遵循仓库近期 Conventional Commit 风格（如 `feat:`、`fix:`、`docs:`、`chore:`），一个提交对应一个完整变更单元。
- 不自动 amend 或 push；不要把用户已有的无关修改混入提交。
- 拉取/合并 upstream 时把上游代码视为只读；冲突解决保留上游行为，仅适配当前分支改动，除非用户明确授权改变上游逻辑。

在开始实现之前，先阅读 `.trellis/spec/` 中的相关规格，以及它们引用的源文档。
