# 在不改变行为的前提下归纳项目结构

## 目标

把职责高度一致但散落在同一层级的文件归入清晰目录，降低目录噪音和查找成本，同时保持现有运行行为、公开 API、路由、数据结构和部署语义不变。

## 需求

- 根 `scripts/` 按检查、数据库、本地数据工具归类；图片广场运维说明归入对应 `ops` 领域目录。
- Admin 保持现有 `components → lib` 分层，将视图、配置编辑器、API helper 和成组领域逻辑归类。
- Frontend 只移动职责明确的聊天 helper、支付 helper、浏览器 hook 和支付图标；Next.js `app/` 路由保持原位。
- Backend 只将 Lobby、Notifications 和聊天媒体存储文件归回明确所有者目录；线上执行脚本保持原路径。
- Shared 只移动两个已有根出口保护的明确领域文件；Reply Renderer 保持根出口不变，内部按 rendering、worker、testing 归类。
- 同步所有静态 import、测试 mock、Worker URL、raw source import、package script、workflow、shell/Node 相对路径和现行文档引用。
- 不增加 barrel、兼容层、新依赖或新测试文件。

## 约束

- 不改变函数体业务逻辑、导出符号、HTTP 路由、Next 路由、UI、文案、配置值、数据库 schema/migration、Prisma 或部署拓扑。
- 不移动受框架发现机制约束的根配置、`.github`、`.railway`、`.trellis`、Vercel 配置、Docker Compose、Supabase 配置和 migration 文件。
- 不移动 `packages/backend/src/scripts/*`，避免仓库外 Railway Start Command 仍引用旧路径。
- 历史 archive 和 schema 快照保留原始路径记录；现行 spec、workflow、README 和仍在执行的任务命令必须同步。
- 所有移动使用 Git rename 语义并保留可执行位。

## 验收标准

- [x] 计划范围内文件已归入目标目录，旧目录不残留同类散落文件。
- [x] 运行时和包级公开出口不变；`git diff` 中除路径/引用/文档路径外没有业务行为修改。
- [x] 活代码、配置、workflow 和现行文档中没有待迁移旧路径残留。
- [x] Shell 语法、Node 脚本解析、Worker 测试 bundle 和动态/raw 路径均可解析。
- [x] 全仓 typecheck、现有测试、lint/guards、Frontend/Admin build 和 Reply Renderer 验证通过；migration-ledger 因本机缺少 PostgreSQL 工具未完整执行，入口已验证指向新路径。
