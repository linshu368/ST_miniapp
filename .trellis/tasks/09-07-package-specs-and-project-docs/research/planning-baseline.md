# 规划调研基线

## 范围与方法

本文件记录规划阶段的只读调研摘要。详细实施时仍需按 `implement.md` 重新核对当前分支，避免代码变化使结论过期。调研未读取真实 `.env` 值、数据库连接串或 secret，未修改产品文件。

## Admin 摘要

- `packages/admin` 是 Vite + React 18 + TypeScript 的运营后台 SPA，主要使用 Ant Design、Refine/Supabase provider、Supabase JS、Zod、dnd-kit 和 shared。
- 页面导航目前由工作区本地状态和 Menu 驱动，无 React Router；状态以 hooks 和受控编辑器为主。
- 数据访问集中在 `src/lib/*`，功能覆盖登录、环境切换、配置发布/回滚、模型目录、角色卡、公告、裂变配置/记录和回访赠送。
- 已有纯逻辑 Vitest 测试；规范需补足组件边界、Supabase/RPC、安全、环境、样式/可访问性和发布要求。

## CS Platform 摘要

- `packages/cs-platform` 是 Vite + React + TypeScript 的内部客服 SPA，采用 TanStack React Query、统一 fetch client、原生 CSS 和 shared contracts。
- 承载 Telegram 用户回访与 MiniApp 客服会话两套流程；无路由和全局客户端状态库。
- 规范重点是 API client 单入口、认证请求头、query key/mutation invalidation/轮询、测试/生产后端切换、token 安全和客服操作反馈。
- 当前测试体系相对薄弱，实施只文档化新增测试要求，不在本任务重构产品代码。

## Shared 摘要

- `@miniapp/shared` 是唯一跨应用契约层，根出口直接指向 `src/index.ts`，没有独立 build/exports map。
- 内容包括 `src/api/*` DTO/SSE 契约、Zod runtime schema、默认配置、业务常量、纯函数、dev fixtures 和数据库环境工具。
- `packages/shared/migrations` 是唯一 SQL migration 源；应用端不得消费数据库行类型，shared 浏览器模块不得引入服务端依赖。
- 规范重点是出口治理、契约先行、向后兼容、runtime/type 边界、consumer typecheck、迁移安全和手工发布。

## 全局文档摘要

- 根目录当前没有 `README.md`。
- `AGENTS.md` 已包含 Trellis 管理块和一组硬规则，但需增加项目总览、规范路由、部署/测试/安全/文档同步等全局指引。
- `docs/ARCHITECTURE.md` 是最完整的架构事实文档；README 应摘要并链接，不应复制全部细节。
- `ops/README.md`、`ops/railway/**`、Vercel 配置、各包 package 和 env example 是部署/变量说明的事实来源。
- 根 package 明确 pnpm 9.15.9、Node >=22、workspace scripts、Prettier/Husky/lint-staged；commit 风格还需在实施时用 git history 核实。

## Supabase 摘要

- 用户确认只采集测试库。
- 迁移源是 `packages/shared/migrations`，不是 `supabase/migrations`；部署为手工执行，不能用编号推断实际状态。
- `ops/schema-split/inventory.sql` 可作为采集维度基线；需补足枚举值、逐列约束、对象注释等。
- 预期业务 schemas：`app_core`、`miniapp_features`、`experience`、`billing`、`admin`、`cs_platform`、`miniapp_traffic`、`miniapp_analytics`；需由 MCP 实况确认。
- 当前会话未提供可调用的 Supabase MCP server/resource/tool，因此规划不能声称已取得实库结构。实施时必须先核验连接目标；不可用则阻塞并请用户配置。

## 风险

1. 测试库与 migrations、历史 docs 或生产库可能不同构。
2. migration 存在重号、回滚和环境特例，文件顺序不是可靠部署账本。
3. Admin 直接 Supabase 与 backend proxy 并存，规范必须描述清晰边界，不能凭理想架构统一重构。
4. 大量逐文件说明容易过时，应使用稳定目录地图 + 功能矩阵 + 更新规则控制维护成本。
5. 环境变量和数据库采集最容易泄密，必须只记录名称/结构元数据并执行敏感扫描。
6. “高可用、可复用、简洁”若仅写成原则口号，后续 Trellis 规划无法稳定执行；spec 必须将其转成 PRD/design/implement/task 的必填分析、适用条件和验证门禁。
7. 高可用与简洁可能被错误理解为相互排斥；应以真实故障模型和最小充分方案做权衡，既禁止过度设计，也禁止省略关键错误处理与恢复能力。
