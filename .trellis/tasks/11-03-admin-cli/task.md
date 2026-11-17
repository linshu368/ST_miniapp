# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| #   | 任务                                                           | 状态    | 验证                                                                      |
| --- | -------------------------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| 1   | 规划评审：方案、删除清单、菜单归类                             | Done    | 用户 2026-11-03 确认：只做生产、删 6 项、停用主推、打标写死开启、7 组菜单 |
| 2   | 建 `@miniapp/admin-client`，移入注册表/DTO/RPC/HTTP 调用与测试 | Done    | admin-client typecheck/test                                               |
| 3   | Admin SPA 改用 admin-client，行为不变                          | Done    | admin typecheck/test/build、lint:imports                                  |
| 4   | CLI 骨架：参数、输出、错误码、写操作门禁                       | Done    | 单测                                                                      |
| 5   | CLI 存储与 client；setup/login/logout/whoami                   | Done    | 单测（权限、非 TTY 拒绝）+ 用户登录                                       |
| 6   | config 命令全集                                                | Done    | 生产只读冒烟 + 门禁验证                                                   |
| 7   | 角色卡、布局、公告、邀请、富文本规则、测试类命令               | Done    | 生产只读冒烟                                                              |
| 8   | `help --json` 命令目录                                         | Done    | 覆盖全部命令                                                              |
| 9   | 读出主推与打标生产当前值并告知用户                             | Blocked | 用户知悉                                                                  |
| 10  | 入口清理（6 项）与回访赠送页面删除                             | Done    | admin test/build                                                          |
| 11  | 后端：停用主推、写死打标开启                                   | Done    | backend lobby/image-plaza 测试、shared test                               |
| 12  | 菜单 7 组归类（admin-client 分组共享给 CLI）                   | Done    | 本地看菜单                                                                |
| 13  | 文档：CLI README、AGENTS.md、Claude skill、spec/架构           | Done    | 审阅                                                                      |
| 14  | 性能基线回填、全量验证、经同意的生产写入验证                   | Doing   | `pnpm -r typecheck`、lint、人工脚本                                       |

## 进度（2026-11-03 23:40）

提交：`13268266` 抽出 admin-client；`2e049b91` CLI；`f32c2062` 入口清理/后端停用主推与写死打标/菜单 7 组；`ff30c944` 文档。
验证：shared 229、backend 1298、admin 105、admin-client 19、admin-cli 21 全部通过；`pnpm -r typecheck`、eslint、lint:imports、lint:legacy、admin build 通过。
生产 setup 已完成（`~/.config/mijing-admin/config.json`）。

待用户：本人执行 `pnpm admin login`；之后跑生产只读冒烟、读出 `lobby_pinned_characters` 与 `image_plaza_tags_feature_enabled` 当前值告知用户（合并前），再按用户同意做一次低风险配置的草稿→发布→回滚验证；然后开 PR（main + dev）。
