# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| #   | 任务                                                           | 状态  | 验证                                                                      |
| --- | -------------------------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| 1   | 规划评审：方案、删除清单、菜单归类                             | Done  | 用户 2026-11-03 确认：只做生产、删 6 项、停用主推、打标写死开启、7 组菜单 |
| 2   | 建 `@miniapp/admin-client`，移入注册表/DTO/RPC/HTTP 调用与测试 | Done  | admin-client typecheck/test                                               |
| 3   | Admin SPA 改用 admin-client，行为不变                          | Done  | admin typecheck/test/build、lint:imports                                  |
| 4   | CLI 骨架：参数、输出、错误码、写操作门禁                       | Doing | 单测                                                                      |
| 5   | CLI 存储与 client；setup/login/logout/whoami                   | Doing | 单测（权限、非 TTY 拒绝）+ 用户登录                                       |
| 6   | config 命令全集                                                | Doing | 生产只读冒烟 + 门禁验证                                                   |
| 7   | 角色卡、布局、公告、邀请、富文本规则、测试类命令               | Todo  | 生产只读冒烟                                                              |
| 8   | `help --json` 命令目录                                         | Todo  | 覆盖全部命令                                                              |
| 9   | 读出主推与打标生产当前值并告知用户                             | Todo  | 用户知悉                                                                  |
| 10  | 入口清理（6 项）与回访赠送页面删除                             | Todo  | admin test/build                                                          |
| 11  | 后端：停用主推、写死打标开启                                   | Todo  | backend lobby/image-plaza 测试、shared test                               |
| 12  | 菜单 7 组归类（admin-client 分组共享给 CLI）                   | Todo  | 本地看菜单                                                                |
| 13  | 文档：CLI README、AGENTS.md、Claude skill、spec/架构           | Todo  | 审阅                                                                      |
| 14  | 性能基线回填、全量验证、经同意的生产写入验证                   | Todo  | `pnpm -r typecheck`、lint、人工脚本                                       |

## 续做说明（2026-11-03 21:45，额度暂停前）

分支 `feat/admin-cli`（worktree `ST_miniapp/worktrees/vexutopia-payment`）。

已完成：

- 提交 `13268266`：抽出 `packages/admin-client`（注册表、RPC/HTTP 调用、DTO），Admin SPA 改用它；admin/admin-client typecheck、test（118+19）、build、lint:imports 通过。
- 未提交（工作区）：`admin-client/src/menu.ts`（7 组菜单 `ADMIN_MENU_GROUPS` + key 分组常量，adminNavigation 已改为从这里导入）；删除 admin-client 里无人使用的 `setCharacterEnabled/reorderCharacters/archiveCharacter`；`packages/admin-cli` 已写 `package.json/tsconfig/bin`、`src/errors.ts output.ts store.ts client.ts prompt.ts diff.ts command.ts commands/account.ts commands/config.ts`。

下一步（按顺序）：

1. 写 `commands/characters.ts`（character list/get/create/avatar；layout get/draft set/list/delist/delete/move/diff/publish/discard/releases/rollback/delete-release —— 上下架只走布局草稿，不暴露旧 RPC）。
2. 写 `commands/announcements.ts`、`commands/invite.ts`（records、poster）、`commands/text-rules.ts`（get/draft/publish/rollback/discard/recover，自动填 request_id 与 CAS 字段）、`commands/tests.ts`。
3. 写 `src/main.ts`（命令匹配最长前缀、util.parseArgs strict、全局 --json/--yes/--help、help --json 目录、错误→退出码）与 `commands/index.ts`。
4. `pnpm install`、根 `package.json` 加 `"admin": "node packages/admin-cli/bin/mijing-admin.mjs"`；验证 `pnpm -s admin help --json` 输出纯 JSON。
5. 单测：--yes 门禁、draft_exists 护栏、错误码映射、会话文件 0600、非 TTY 拒绝 login。typecheck/lint。
6. 提交 CLI；请用户执行 `! pnpm admin setup` 与 `! pnpm admin login`，跑生产只读冒烟，读出 `lobby_pinned_characters`、`image_plaza_tags_feature_enabled` 当前值告诉用户。
7. 之后按 implement.md 阶段 3、4 继续。
