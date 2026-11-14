# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

| #   | 任务                                     | 状态  |
| --- | ---------------------------------------- | ----- |
| 1   | Migration + 本地 PG17 测试脚本           | Done  |
| 2   | Shared 契约                              | Done  |
| 3   | Backend 资格接口、事件接口、社群事实复用 | Done  |
| 4   | Backend 群欢迎语                         | Done  |
| 5   | Frontend 宿主、礼券卡、计轮、单槽位      | Done  |
| 6   | UI 预览场景与截图自查                    | Done  |
| 7   | 文档与 spec 同步                         | Done  |
| 8   | 验证（typecheck/test/lint/build）        | Doing |
| 9   | TEST → 生产 migration、发布、线上核对    | Todo  |

## 记录

- 迁移：本地 PG17 `scripts/test-growth-prompt-states-migration.sh` 通过（重复执行、上限/间隔、8 并发仅记 1 次、ACL、级联）。
- 后端：typecheck、community/growth 路由测试、欢迎语与规则单测通过。
- 前端：typecheck、lint、complexity（社区路由出基线 106/106）通过；预览 390×844 截图自查，进群/VIP 主按钮路径、打字时不弹、返回不重复弹均验证。
- 生产只读核对：@join_bonus_bot 为官方超级群管理员且可删消息；群管 bot 跳过 bot 消息，不会删除欢迎语。
