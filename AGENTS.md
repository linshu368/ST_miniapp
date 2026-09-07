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

对于非琐碎的工作，使用 Trellis：

1. 在 `.trellis/tasks/` 下创建任务，命令为 `python ./.trellis/scripts/task.py create "<title>" --slug <slug>`。
2. 保持 `prd.md` 只关注需求、约束和验收标准。
3. 对于复杂任务，创建 `design.md` 写技术设计，`implement.md` 写执行计划，`task.md` 写可执行的任务分解，然后再执行 `task.py start`。
4. 在规划文档被审核完成并且任务移到 `in_progress` 之前，不要写产品代码。
5. 在派发子代理时，用 `implement.jsonl` 和 `check.jsonl` 列出相关的规范/研究文件。

项目具体硬性规则：

- 包管理器：`pnpm`；运行时：Node.js `>=22`。
- TypeScript 严格模式；不要添加 `any`。
- 外部数据契约必须在 `packages/shared/src/api/*` 中定义，然后才能被后端处理器或前端使用者使用。
- `frontend`、`backend`、`admin` 和 `cs-platform` 之间不能互相导入；跨应用调用使用 HTTP。
- 前端/管理端/CS 端代码不能直接使用数据库行类型。
- 前端服务器数据必须通过 `src/lib/api/` 的 React Query hooks 获取，而不是在组件层级直接 `fetch`。
- 每个 Fastify 路由注册都必须保留附近的 `@frontend-ready: true|false` 注释。
- LLM 生成和计费必须通过 `packages/backend/src/features/generation/` 进行。
- 运行时配置必须通过 `packages/backend/src/platform/runtime-config.ts` 读取。
- 数据库迁移位于 `packages/shared/migrations/`，并且是手动执行的；生产环境的迁移需要先测试验证并附带回滚说明。
- 服务器日志使用现有的 pino 规范。原始错误要记录为 `{ err }`，而不是 `String(err)`。
- 服务端得请求route都要使用 pino 记录相关得请求参数，返回参数以及整体链路方便部署railway后可以查看

在开始实现之前，先阅读 `.trellis/spec/` 中的相关规格，以及它们引用的源文档。
