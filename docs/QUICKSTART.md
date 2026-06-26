# 本地开发 Quickstart（5 进程）

> 目标：本地一键拉起全部进程，完整体验 MVP（登录 → 大厅 → 对话 → 历史 → 切模型）。
> 配套：根脚本 `pnpm dev:all`（concurrently 并发 5 进程）。

## 0. 前置

- Node ≥ 22，pnpm ≥ 9
- `pnpm install`（根目录）
- `vendor/sillytavern` 首次需 `cd vendor/sillytavern && npm install`
- 可访问的 Supabase test 分支（已应用 `packages/shared/migrations/001~020` + seed）
- `platform-assets/` 内放好角色卡 PNG（命名 `platform_<characterId>.png`，与 `miniapp.characters.id` 对应）

## 1. 环境变量

| 包          | 文件                           | 关键变量                                                                                                                                                                                                                                        |
| ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backend     | `packages/backend/.env`        | `DATABASE_ENV=test`、`TEST_DATABASE_URL`/`TEST_DIRECT_URL`、`TEST_SUPABASE_*`、`ST_BASE_URL=http://localhost:8000`、`ST_PROVISION_URL=http://127.0.0.1:9091`、`ST_USER_PASSWORD_SECRET`、`LLM_API_KEY`、`LLM_PROXY_TOKEN_SECRET`、`MOCK_AUTH=1` |
| sync-engine | `packages/sync-engine/.env`    | `DATABASE_ENV=test`、`TEST_SUPABASE_*`、`ST_DATA_PATH=<repo>/vendor/sillytavern/data`、`ST_PLATFORM_ASSETS_PATH=<repo>/platform-assets`、`ST_BASE_URL`、`ST_ADMIN_USERNAME`、`ST_ADMIN_PASSWORD`、`ST_USER_PASSWORD_SECRET`                     |
| frontend    | `packages/frontend/.env.local` | `NEXT_PUBLIC_API_URL=http://localhost:3001`、`ST_LOCAL_URL=http://127.0.0.1:8000`、`NEXT_PUBLIC_USE_MOCK_INIT_DATA=1`、`NEXT_PUBLIC_MOCK_USER_ID=<test user id>`                                                                                |

一致性要求（否则鉴权/扣费链断）：

- `ST_USER_PASSWORD_SECRET` 必须 backend 与 sync-engine **完全一致**。
- `LLM_PROXY_TOKEN_SECRET` 必须 backend 与 sync-engine 一致（缺省回退到 `ST_USER_PASSWORD_SECRET`）。
- backend `MOCK_AUTH=1` 与 frontend `NEXT_PUBLIC_USE_MOCK_INIT_DATA=1` 配套（本地模拟 TG 身份）。

## 2. ST 多用户（必须）

- `vendor/sillytavern/config.yaml` 已设 `enableUserAccounts: true`。
- sync-engine 用 `ST_ADMIN_USERNAME` / `ST_ADMIN_PASSWORD` 调 ST `POST /api/users/create` 建用户。
  本地约定 admin handle = `default-user`，需保证该账号密码 == `ST_ADMIN_PASSWORD`
  （首次：以 default-user 登录 ST 后在用户面板设置密码，或重置后对齐）。

## 3. 一键启动

```bash
pnpm dev:all
```

并发拉起（concurrently，前缀着色）：

| 前缀    | 进程                            | 端口        |
| ------- | ------------------------------- | ----------- |
| `st`    | ST 原生（`vendor/sillytavern`） | 8000        |
| `prov`  | sync-engine provision-api       | 9091        |
| `watch` | sync-engine watcher             | health 9090 |
| `be`    | backend（Fastify）              | 3001        |
| `fe`    | frontend（Next.js）             | 3000        |

> 单独启动：`pnpm dev:st` / `dev:provision` / `dev:watcher` / `dev:backend` / `dev:frontend`。
> `dev:all` 各进程相互独立（不带 `-k`）；若某端口已被占用，先停掉残留进程，或改用对应的单独 `dev:*` 脚本补齐缺失进程。
> 改 st-extension 后需 `pnpm --filter @miniapp/st-extension build`（产物自动拷进 vendor ST 扩展目录），并在浏览器刷新使新扩展生效。
> 改 `config.yaml`（如 `enableUserAccounts`）需重启 ST 进程；改 provisioner（merger 等）需重启 provision-api 进程。

入口：浏览器开 `http://localhost:3000`。

## 4. MVP 冒烟验收清单

1. 登录（mock TG）→ 大厅角色卡正常渲染
2. 点角色卡 → 进对话页 → 自动收到角色背景/首句（ST 原生）
3. 发消息 → 正常回复；backend 日志出现 `deduction success`，积分按 tier 扣减
4. 历史聊天：列表 / 点击切换继续聊 / 重命名 / 删除
5. 切换模型（标准 10 ↔ 高级 15）→ 下次生成用新模型、扣费额变化
6. 刷新/重登 → 模型等级 + 历史聊天保持上次状态

## 5. 常见问题

- 大厅空：检查 Supabase `miniapp.characters` 有数据且 `enabled=true`。
- 切角色失败/无首句：检查 `platform-assets/platform_<id>.png` 存在且 provision 已下发到 `data/<handle>/characters/`。
- 发消息不扣费/报 401：检查 ST `secrets.json` 写入的是 per-user JWT、`LLM_PROXY_TOKEN_SECRET` 两端一致、`platform_settings` 的 LLM endpoint 指向 `…/api/platform/llm-proxy/v1`。
- ST 无 `tg_*` 用户目录：说明 provision 未成功，检查 ST 多用户开关与 admin 账号密码对齐。
