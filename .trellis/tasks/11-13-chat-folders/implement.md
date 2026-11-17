# 执行计划

1. **Migration** `packages/shared/migrations/20261113_chat_folders.sql`：preflight（chat_sessions 存在、无 folder_id 冲突形状）→ 建表/列/复合 FK/部分索引/两个函数 → ACL → `$verify$` → `NOTIFY pgrst`。5s 锁、60s 语句。
2. **Shared**：`api/conversations.ts` 扩展 ChatSession.folder_id、列表 query/响应、PATCH；新 `api/conversation-folders.ts`（ChatFolder、汇总、归拢、批量、分组 CRUD 的类型与 zod schema、ChatFolderErrorCode）；导出。
3. **Backend**：`ChatSessionRepository` 列表条件（folder/q/quick）、updateSession.folderId、batchUpdate、listGroups、folderSummary；新 `ChatFolderRepository`（create/rename/delete，20 上限）；新路由文件 `routes/conversation-folders.ts`（分组 CRUD、batch、groups）注册进 conversations.ts；列表路由并行取汇总。
4. **Frontend**：`lib/api/conversation-folders.ts` hooks；`components/conversations/*` 拆分组件；`app/(main)/chats/page.tsx` 变壳；启动骨架 + early-startup `/chats`。
5. **UI fixtures**：`packages/ui-tests/fixtures/chat-folders.ts` 实现上述接口（内存状态），`server.ts` 挂载；新场景 `chat-folders`（30 段、多角色多段、2 个分组）。
6. **测试**：shared schema 单测随既有测试；backend 路由校验单测（batch 上限、folder 校验）；`@chats` ui 用例覆盖新建→挑选→放入、移到分组、删分组、按角色展开、搜索、翻页、快捷筛选删除、<6 条时无工具行、320 宽布局；落地 cookie 跳转。
7. **文档**：conversation-ui.md、character-lobby.md、architecture-routes-and-files.md、backend 对话路由 spec、数据库模块说明、ui-tests README。

## 验证命令

- `pnpm -r typecheck`、`pnpm lint`、`pnpm lint:complexity`、`pnpm lint:migrations`、`pnpm test`、`pnpm build`
- `pnpm test:ui --grep "@chats|@roleplay|@startup|@navigation"`（android + narrow）
- 迁移：本地 PG17 跑一遍文件两次（第二次应无变化/安全失败说明），TEST 经 workflow 执行后再核对 shape 与 ACL。

## 失败路径

- 分组重名/超限/不存在 → 409/409/404，前端行内提示，不关闭面板。
- 批量部分 id 已删 → `updated` 少于请求数，前端提示「已处理 N 个」并刷新。
- 汇总函数失败 → 列表无 `folder_summary`，标签栏隐藏，不影响接着聊。
- 翻页失败 → 底部「加载失败，重试」。
