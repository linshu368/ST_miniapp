# 任务分解

- [x] Migration：chat_folders 表、folder_id 列、复合 FK、部分索引、汇总与归拢函数、ACL 与校验（`scripts/test-chat-folders-migration.sh` 一次性 PG17 通过）
- [x] Shared 契约与 zod schema（含单测）
- [x] Backend 仓储与路由（列表扩展、PATCH folder_id、batch、groups、分组 CRUD）；后端单测 1654 通过
- [x] Frontend hooks（分组增改删就地更新汇总缓存）
- [x] 对话页组件拆分与 A 稿实现（渐进出现、标签、按角色 + 整组置顶/移到分组、搜索、管理、翻页、空状态）
- [x] 启动骨架 + early ready `/chats`
- [x] UI fixtures（`chat-folders` 场景）与 `@chats` 用例、落地 cookie 用例
- [x] 默认按角色、最新一段排序、返回回到原处（追加）
- [x] typecheck / lint / complexity / migrations lint / test / ui-tests（android 回归 106/107，唯一失败为 dev 已在 #798 改掉的旧断言；@chats 7/7）
- [x] 文档与 spec 同步
- [ ] 迁移经 workflow 执行：TEST → 生产（需用户确认）
