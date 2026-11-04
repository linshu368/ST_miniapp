---
module_id: admin.infrastructure.admin-client-auth
title: Admin API、鉴权与环境基建
scope: admin
category: infrastructure
status: active
owners: [admin]
last_verified_task: .trellis/tasks/11-03-admin-cli/
last_verified_at: 2026-11-03
---

# Admin API、鉴权与环境基建

## 职责与边界

运营平台的登录、环境、Admin RPC / `/api/admin/*` 调用与配置注册表。网页（`packages/admin`）和命令行（`packages/admin-cli`）共用 `packages/admin-client`。

## 当前状态

- 网页：邮箱密码登录（Supabase Auth，经后端 `/api/admin/supabase` 代理），test/production 两套会话隔离。
- CLI：只连生产；2026-11-04 起免密登录——后端 `POST /api/admin/cli/session` 对 `ADMIN_CLI_ALLOWED_EMAILS` 白名单邮箱用 service-role `generateLink` + 一次性 client `verifyOtp` 签发该账号本人的会话（白名单为空即关闭，进程内限流 10 分钟 20 次，日志只记 user_id）。知道白名单邮箱即可登录，是用户确认过的取舍。会话存 `~/.config/mijing-admin/session.json`（0600），刷新时用目录锁串行。
- `admin-client` 的调用函数显式接收 `apiBaseUrl` 与 base64 文件内容，不读 Vite 环境变量、不依赖浏览器 API。

## 入口与调用者

运营人员用网页；团队成员与 AI 助手用 `pnpm admin`（见 `packages/admin-cli/README.md`、根 `AGENTS.md`）。

## 涉及文件

| 路径                                          | 职责                                              |
| --------------------------------------------- | ------------------------------------------------- |
| `packages/admin/src/components/LoginPage.tsx` | Admin 登录入口                                    |
| `packages/admin/src/lib/environment.ts`       | 网页环境与 Supabase client                        |
| `packages/admin/src/lib/adminNavigation.ts`   | 网页侧栏（由 `ADMIN_MENU_GROUPS` 生成）与菜单路由 |
| `packages/admin-client/src/adminApi.ts` 等    | 网页与 CLI 共用的 RPC/HTTP 调用                   |
| `packages/admin-client/src/configSchemas.ts`  | managed config 注册表、校验、中文名与默认值       |
| `packages/admin-client/src/menu.ts`           | 菜单分组 `ADMIN_MENU_GROUPS`                      |
| `packages/admin-cli/src/*`                    | CLI：会话存储、确认门禁、命令                     |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

- 写操作的唯一授权边界是数据库函数（角色、`can_access_prod`、CAS）；CLI 的 `--yes` 门禁只防误操作，不替代授权。
- CLI 本身不持有 service-role；会话签发在后端完成，签发后所有写操作仍以该账号身份经数据库函数鉴权与审计。

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.infrastructure.runtime-data-security`、`shared.infrastructure.database-environment`。

## 图片创作广场 V2（2026-10-12）

图片广场配置页只复用 Admin 既有 session、环境切换与 config draft/publish/rollback helper；浏览器不直接访问数据库、不持有 Venice 密钥，也不新建平行鉴权或 API client。

## 变更记录
