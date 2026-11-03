# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| #   | 任务                                                           | 状态 | 验证                                                                      |
| --- | -------------------------------------------------------------- | ---- | ------------------------------------------------------------------------- |
| 1   | 规划评审：方案、删除清单、菜单归类                             | Done | 用户 2026-11-03 确认：只做生产、删 6 项、停用主推、打标写死开启、7 组菜单 |
| 2   | 建 `@miniapp/admin-client`，移入注册表/DTO/RPC/HTTP 调用与测试 | Todo | admin-client typecheck/test                                               |
| 3   | Admin SPA 改用 admin-client，行为不变                          | Todo | admin typecheck/test/build、lint:imports                                  |
| 4   | CLI 骨架：参数、输出、错误码、写操作门禁                       | Todo | 单测                                                                      |
| 5   | CLI 存储与 client；setup/login/logout/whoami                   | Todo | 单测（权限、非 TTY 拒绝）+ 用户登录                                       |
| 6   | config 命令全集                                                | Todo | 生产只读冒烟 + 门禁验证                                                   |
| 7   | 角色卡、布局、公告、邀请、富文本规则、测试类命令               | Todo | 生产只读冒烟                                                              |
| 8   | `help --json` 命令目录                                         | Todo | 覆盖全部命令                                                              |
| 9   | 读出主推与打标生产当前值并告知用户                             | Todo | 用户知悉                                                                  |
| 10  | 入口清理（6 项）与回访赠送页面删除                             | Todo | admin test/build                                                          |
| 11  | 后端：停用主推、写死打标开启                                   | Todo | backend lobby/image-plaza 测试、shared test                               |
| 12  | 菜单 7 组归类（admin-client 分组共享给 CLI）                   | Todo | 本地看菜单                                                                |
| 13  | 文档：CLI README、AGENTS.md、Claude skill、spec/架构           | Todo | 审阅                                                                      |
| 14  | 性能基线回填、全量验证、经同意的生产写入验证                   | Todo | `pnpm -r typecheck`、lint、人工脚本                                       |
