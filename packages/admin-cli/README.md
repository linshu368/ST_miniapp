# mijing-admin：运营平台命令行

不打开浏览器、不截图，在终端里完成**生产环境**运营平台的主要操作。团队成员和 AI 助手（Claude Code、Codex）都用它。

- 只连生产环境。身份是你本人的运营账号，权限、只读角色、发布记录里的操作人都与网页运营平台完全一致。
- 走与网页相同的后端代理（`/api/admin/supabase`）和数据库函数，校验规则与网页保存草稿时相同（共用 `@miniapp/admin-client`）。
- 所有会改动生产的命令都必须确认：交互终端里输入 `yes`，非交互调用必须带 `--yes`。

## 第一次使用（每台电脑一次）

在仓库根目录：

```bash
pnpm install
pnpm admin setup          # 生产后端地址 + Supabase 公开 anon key（与网页运营平台相同，向负责人要）
pnpm admin login          # 邮箱、密码、操作人姓名；只能本人在终端输入
pnpm admin whoami         # 确认账号、角色、生产权限
```

也可以 `pnpm admin setup --from-env-file packages/admin/.env.local`（读 `VITE_ADMIN_PROD_API_URL` 与 `VITE_ADMIN_PROD_SUPABASE_ANON_KEY`）。

本机文件在 `~/.config/mijing-admin/`（可用 `MIJING_ADMIN_HOME` 改位置）：`config.json` 存地址和 anon key，`session.json` 存登录会话，目录 0700、文件 0600，不进仓库。会话过期或在别处退出后，重新 `pnpm admin login`。

## 常用流程

查看全部命令：`pnpm admin help`（AI 用 `pnpm -s admin help --json`）。任何命令加 `--help` 看参数。

### 改一个运营配置

```bash
pnpm admin config list                         # 按菜单分组列出全部配置（key、中文名、版本、是否有草稿）
pnpm admin config describe miniapp_payment_plans   # 说明、默认值、线上值、草稿状态
pnpm -s admin config get miniapp_payment_plans > plans.json        # 不加 --json 时只输出值本身，便于直接编辑
# 编辑 plans.json
pnpm admin config draft set miniapp_payment_plans --file plans.json # 本地校验 → 显示差异 → 确认后保存草稿
pnpm admin config diff miniapp_payment_plans
pnpm admin config publish miniapp_payment_plans                     # 确认后立即生效
pnpm admin config get miniapp_payment_plans                         # 复核
```

- 文本类配置（系统指令、角色卡审核提示词、图片描述 system prompt）`--file` 读纯文本。
- 每个配置只有一份草稿，网页和 CLI 共用。已有与线上不同的草稿时 `draft set` 默认拒绝（`draft_exists`），确认可以覆盖再加 `--replace-draft`。
- 发布时若线上已被别人改过，数据库会拒绝（`conflict`），重新 `draft set` 即可。
- 回滚：`pnpm admin config releases <key>` 找到发布 id，`pnpm admin config rollback <release-id>`。

### 角色上架、下架、排序

上下架与排序都先改“布局草稿”，再发布：

```bash
pnpm admin character list --query 名字
pnpm admin layout list <角色id> --position 3     # 上架到第 3 位（不填放最后）
pnpm admin layout delist <角色id>
pnpm admin layout move <角色id> --position 1
pnpm admin layout diff
pnpm admin layout publish
```

新建角色：`pnpm admin character create --file card.json --avatar avatar.png`（新建后不上架）。

### 公告、邀请、富文本规则

```bash
pnpm admin announcement create --title 标题 --body-file body.md      # 默认不发布
pnpm admin announcement publish <id>
pnpm admin invite records --inviter <tg_id>
pnpm admin invite poster poster.png                                  # 返回 URL，再写进 miniapp_invite_center_config 才生效
pnpm admin text-rules get --json
pnpm admin text-rules draft --file source.json && pnpm admin text-rules publish
```

富文本规则写入超时（结果未知）时不要重试，先 `pnpm admin text-rules recover <request-id>` 查结果。

## 给 AI 助手的约定

- 用 `pnpm -s admin ... --json`（在仓库子目录用 `pnpm -s -w admin`）。不加 `-s` 时 pnpm 会往 stdout 打印脚本横幅，JSON 就解析不了。
- 先 `whoami`，再读后写；写前用 `describe`/`get` 看清现值，用 `validate` 或 `draft set` 的差异确认改动范围。
- 写命令不带 `--yes` 会返回 `confirmation_required` 和差异预览，不会改任何东西。**把差异给用户看，用户明确同意后**才带 `--yes` 重新执行。
- 登录只能用户本人做。遇到 `auth_required` / `setup_required`，请用户在终端执行 `pnpm admin login` / `pnpm admin setup`。

## 输出与退出码

`--json` 时 stdout 只有一段 JSON：成功 `{"ok":true,"data":...}`，失败 `{"ok":false,"error":{"code","message","details"}}`。

| 退出码 | code                                        | 含义                                                                |
| ------ | ------------------------------------------- | ------------------------------------------------------------------- |
| 0      | —                                           | 成功                                                                |
| 1      | `usage` / `validation_failed` / `not_found` | 参数错误、本地校验失败（`details.issues` 给出字段路径）、对象不存在 |
| 2      | `setup_required` / `auth_required`          | 未配置或未登录/会话过期                                             |
| 3      | `permission_denied`                         | 只读账号或无生产权限                                                |
| 4      | `conflict` / `draft_exists`                 | 线上已变化 / 已有别人的草稿                                         |
| 5      | `confirmation_required`                     | 写操作需要确认（`details.preview` 是差异）                          |
| 6      | `unavailable`                               | 网络或服务暂不可用（读命令已自动重试 2 次）                         |
| 7      | `unknown`                                   | 其他错误，原文在 message                                            |

## 不在范围内

- 测试环境（只做生产）。
- 回访星尘赠送、角色卡 PNG 批量导入（`scripts/import-character.ts` 仍用 service-role，与本工具无关）。

## 开发

```bash
pnpm --filter @miniapp/admin-cli typecheck
pnpm --filter @miniapp/admin-cli test
```

命令定义在 `src/commands/*`；新增命令时写清 `write`（是否改生产）并通过 `ctx.confirm` 走确认门禁。调用 RPC/HTTP 的代码放 `@miniapp/admin-client`，与网页共用。
