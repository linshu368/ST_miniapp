# 设计：运营平台 CLI 与侧边栏清理

## 1. 现状（已核对源码）

| 能力           | 现有通道                                                                                                                                                                         | 文件                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 登录           | Supabase `signInWithPassword`，经后端 `/api/admin/supabase/*` 代理；登录后 `admin.set_operator_name` 写操作人姓名                                                                | `admin/src/lib/environment.ts`、`components/LoginPage.tsx` |
| managed config | `admin.get_managed_configs`、`config_drafts`/`config_releases` 表读、`upsert_config_draft`、`publish_config_draft`、`discard_config_draft`、`rollback_config_release`            | `admin/src/lib/adminApi.ts`                                |
| 配置注册表     | key 列表、zod schema、中文名/说明/默认值、侧边栏分组                                                                                                                             | `admin/src/lib/configSchemas.ts`、`adminNavigation.ts`     |
| 角色卡/布局    | `get_characters`、`create_character`、`set_character_enabled`、`reorder_characters`、`archive_character`、`*_character_layout*` RPC；头像 `POST /api/admin/character-assets/:id` | `adminApi.ts`                                              |
| 公告           | `list/create/update/set_published/delete_announcement`                                                                                                                           | `announcementsApi.ts`                                      |
| 回访赠送       | `lookup_user_for_credit_grant`、`grant_user_credits(p_request_id)`                                                                                                               | `outreachCreditsApi.ts`                                    |
| 邀请           | `list_invite_records`；海报 `POST /api/admin/invite-poster`                                                                                                                      | `inviteAdminApi.ts`、`adminApi.ts`                         |
| 富文本规则     | `/api/admin/text-postprocess*`（CAS + request_id 恢复）                                                                                                                          | `textPostprocessApi.ts`（已抽象 transport）                |
| 测试           | `POST /api/admin/image-text-model/test`、`/api/admin/creator-characters/review-test`                                                                                             | `adminApi.ts`                                              |

数据库侧已有：角色/环境权限检查、viewer 只读、发布 CAS（`base_version` 与运行版本不符即拒绝）、审计日志；每个 (environment, config_key) **只有一个活动草稿**（`idx_admin_config_drafts_one_active`），多人共用。代理只放行 `auth/v1`、`rest/v1`、`storage/v1`，不校验 Origin。

## 2. 方案总览

```
packages/admin-client   新：Admin SPA 与 CLI 共用的纯 TS 库（无 React/Vite）
  ├─ configSchemas.ts  配置注册表（从 admin 移入）：key、zod schema、中文名/说明/默认值
  ├─ menu.ts          菜单分组 ADMIN_MENU_GROUPS（网页侧栏与 CLI 共用）
  ├─ adminApi.ts 等    RPC 与 HTTP 调用（从 admin 移入，保留原文件名）：入参 (client, apiBaseUrl)，不读 import.meta.env
  └─ types.ts         AdminEnvironment 等类型
packages/admin          保留 UI、environment.ts（Vite env）、菜单映射；改为从 admin-client 导入
packages/admin-cli      新：命令行；依赖 admin-client、shared、supabase-js
```

### 2.1 复用调研与取舍

| 对象                                                                   | 处理                                                                               | 理由                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `configSchemas.ts` 注册表                                              | **移入 admin-client**                                                              | CLI 必须用与网页完全相同的校验与中文名；复制会漂移          |
| `adminApi.ts` / `announcementsApi.ts` / `inviteAdminApi.ts` 的调用函数 | **移入 admin-client**，把 `getAdminApiUrl(environment)` 改为显式 `apiBaseUrl` 参数 | 两个真实使用方；RPC 参数名只保留一份                        |
| `textPostprocessApi.ts`                                                | 移入，transport 抽象原样复用                                                       | 已是可注入 transport 的设计                                 |
| `outreachCreditsApi.ts`                                                | 随“回访星尘赠送”页面一起删除，不移入                                               | 用户决定去掉该入口                                          |
| `environment.ts` 的 `resilientFetch`                                   | 不复用（依赖 `window`），CLI 写等价的有界重试，仅用于读                            | 环境差异                                                    |
| `characterCards.ts`、`modelCatalogDiff.ts` 等 UI 辅助                  | 不动                                                                               | CLI 不需要                                                  |
| shared 包                                                              | 不放注册表                                                                         | 中文名/分组是运营端知识，前后端不需要；避免 shared 依赖膨胀 |
| `scripts/import-character.ts`                                          | 不复用                                                                             | service-role 绕过审计                                       |

拒绝的方案：

- **CLI 自写一份 RPC 薄封装**：参数名两处维护，网页改了 CLI 不知道。
- **个人访问令牌/服务账号**：需要改数据库鉴权与审计模型，超出“让 AI 方便操作”的必要范围。
- **MCP server / 守护进程 / 插件框架**：Bash 调 CLI 已满足 Claude Code 与 Codex；不预建。
- **zod→JSON Schema 依赖**：用“说明 + 默认值 + 当前值 + 本地校验报错路径”满足 AI 推断结构，不新增依赖。

## 3. CLI 设计

### 3.1 入口与依赖

- `pnpm admin <command> [args] [--json] [--yes]`，**只连生产环境**（用户决策），不提供环境参数，输出头部固定标注“生产环境”（根 `package.json` 增加 `admin` 脚本，用 `tsx` 执行；包内 `bin: mijing-admin` 供需要的人全局 link）。
- 参数解析用 Node 内置 `util.parseArgs`；交互输入用 `node:readline`（密码输入不回显）。不新增第三方 CLI 依赖。

### 3.2 配置与会话

- `~/.config/mijing-admin/config.json`（目录 0700、文件 0600）：生产 `{ apiUrl, anonKey }`，均为公开值（与 Admin 的 `VITE_ADMIN_PROD_*` 同源）。`setup` 支持交互填写或 `--from-env-file <path>`（读 `VITE_ADMIN_PROD_API_URL` / `VITE_ADMIN_PROD_SUPABASE_ANON_KEY`）；也可用环境变量 `MIJING_ADMIN_API_URL` / `MIJING_ADMIN_ANON_KEY` 覆盖。缺失时报出具体变量名。
- 登录后用 `whoami` 校验 `can_access_prod`；数据库发布函数本身也会按“当前数据库环境”校验，防止配置指错库。
- 会话：`~/.config/mijing-admin/session.json`（0600），作为 supabase-js 的自定义 `storage`，保持 `autoRefreshToken`；写入用“临时文件 + rename”保证原子。
- 刷新并发：多个 CLI 进程同时刷新会触发 Supabase refresh token 轮换冲突 → 刷新前获取 `session.lock`（`mkdir` 锁，30 秒过期视为陈旧），拿锁后重读文件再决定是否需要刷新。
- Supabase client 指向 `${apiUrl}/api/admin/supabase`（与网页同一代理路径与放行规则）。

### 3.3 命令清单

| 分组       | 命令                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 账号       | `setup`、`login`（仅 TTY；邮箱/密码/操作人姓名）、`logout`、`whoami`                                                                                                                                                                                                                                                                      |
| 发现       | `help [command] [--json]`（完整命令目录）、`config list`（key、中文名、侧边栏分组、运行版本、是否有草稿）、`config describe <key>`（说明、默认值、当前值、值类型 json/text）                                                                                                                                                              |
| 配置       | `config get <key>`、`config validate <key> --file`、`config draft get <key>`、`config draft set <key> (--file f.json \| --value '<json>' \| --text-file f.txt) [--description] [--replace-draft]`、`config diff <key>`、`config publish <key>`、`config discard <key>`、`config releases [key] [--limit]`、`config rollback <release-id>` |
| 角色卡     | `character list [--query] [--include-archived]`、`character get <id>`、`character create --file card.json`、`character avatar <id> <png>`、`character enable <id>`、`character disable <id>`、`character archive <id>`、`character reorder <id...>`                                                                                       |
| 布局       | `layout get`、`layout draft set --file layout.json`、`layout diff`、`layout publish`、`layout discard`、`layout releases [--limit]`、`layout rollback <release-id>`、`layout delete-release <release-id>`                                                                                                                                 |
| 公告       | `announcement list`、`announcement create --file`、`announcement update <id> --file`、`announcement publish <id>`、`announcement unpublish <id>`、`announcement delete <id>`                                                                                                                                                              |
| 邀请       | `invite records [filters] [--limit --offset]`、`invite poster <png>`                                                                                                                                                                                                                                                                      |
| 富文本规则 | `text-rules get`、`text-rules draft --file`、`text-rules publish`、`text-rules rollback <version>`、`text-rules discard`、`text-rules recover <request-id>`                                                                                                                                                                               |
| 测试       | `test image-text-model --file`、`test creator-review --file`                                                                                                                                                                                                                                                                              |

### 3.4 输出与退出码

- `--json`：成功 `{"ok":true,"data":...}`；失败 `{"ok":false,"error":{"code","message","details"}}`。人读模式打印表格/差异。
- 退出码：`0` 成功；`1` 用法或本地校验失败（`usage`/`validation_failed`）；`2` 需要登录（`auth_required`）；`3` 权限不足（`permission_denied`）；`4` 冲突（`conflict`、`draft_exists`）；`5` 需要确认（`confirmation_required`）；`6` 网络或服务端（`unavailable`）；`7` 未知。
- 错误映射：数据库 `RAISE` 文案（如 `viewer accounts are read-only`、`config changed after draft creation`、`admin is not permitted to access configured environment`）、HTTP 401/403/409 统一映射为上述 code，原文放 `details.message`；不输出 token、请求头、完整响应体。

### 3.5 写入护栏

1. 只连生产，所有写操作都按生产门禁处理。
2. 本地 zod 校验（注册表同一份 schema），失败时列出字段路径，不调用 RPC。
3. `draft set`：若已有草稿且其值 ≠ 已发布值且 ≠ 新值 → `draft_exists`，需 `--replace-draft`；成功后返回与已发布值的差异与 `base_version`。
4. 所有写操作（含 `draft set`、`publish`、`rollback`、角色/布局/公告写入、上传）：先打印差异或将要执行的动作；非 TTY 必须 `--yes`，否则 `confirmation_required`（不写）。TTY 下要求输入 `yes`。
5. 发布冲突原样返回 `conflict`，提示重新 `draft set`；不自动重试。

## 4. 可靠性

| 风险      | 处理                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| 网络超时  | 所有请求 `AbortSignal.timeout(15s)`（上传 60s）                                                                         |
| 重试      | 只对读命令在网络错误/5xx 时有限重试 2 次（350ms、1s）；写命令不重试；富文本规则写入沿用 request_id 恢复语义             |
| 幂等      | 发布/回滚依赖数据库 CAS；富文本规则依赖 request_id；草稿 upsert 天然幂等；角色/公告写入不自动重试，结果未知时先读再决定 |
| 并发      | 草稿共享 → 覆盖护栏；发布 CAS；会话刷新文件锁                                                                           |
| 环境串用  | 只连生产，配置只有一套地址；登录后校验 `can_access_prod`；输出头部固定标注生产                                          |
| 凭据泄露  | 会话/配置 0600；不打印 token/anon key；错误不带请求头                                                                   |
| 降级      | CLI 不可用时网页照常（同一数据与 RPC）                                                                                  |
| 容量/限流 | 调用频率与人工操作同量级，无需额外限流                                                                                  |
| 可观测性  | 后端代理已有 pino 日志；数据库审计日志记录操作人；CLI 不额外上报                                                        |
| 事务      | 均为单 RPC 原子写；不存在跨 RPC 事务需求                                                                                |

## 5. 入口清理与后端改动

### 5.1 只删入口（运行时不读或保留数据库 RPC）

| key / 页面                            | 依据（2026-11-03 源码检索）                                                     | 处理                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `system_fallback_character_id`        | 后端、前端、数据库业务函数均无读取                                              | 删注册表项与编辑器分支                                                           |
| `miniapp_daily_checkin_bonus_credits` | shared 注释“发奖不再读取”；最新 `claim_daily_checkin` 只读 new_user/veteran/vip | 同上                                                                             |
| `media_feature_free_trial_limit`      | 最新 `reserve_feature_free_trial` 注明不读；侧边栏已隐藏                        | 同上，并删 `LEGACY_MEDIA_FREE_TRIAL_LIMIT_KEY`                                   |
| 回访星尘赠送页面                      | 数据库 `lookup_user_for_credit_grant` / `grant_user_credits` 保留               | 删 `OutreachCreditGrantView.tsx`、`outreachCreditsApi.ts`(+test)、菜单与视图分支 |

保留：`miniapp_new_user_signup_bonus_credits`（注册触发器经 `billing.grant_new_user_signup_bonus` 读取）、`miniapp_invite_reward_rules`（`grant_invite_reward` 等读取）。

### 5.2 分享自动打标：写死开启

- `backend/src/features/image-plaza/config.ts` 不再读 `image_plaza_tags_feature_enabled`，删除 `tagsFeatureEnabled` 字段；`routes/image-plaza.ts` 分享时“无标签即自动打标”的条件去掉开关判断。
- 注册表、`ImagePlazaConfigEditors` 中的开关项删除。

### 5.3 推荐主推候选：停用

- 删除 `backend/src/features/lobby/pinned-characters.ts` 与 shared `lobby-pinned-characters.ts` 契约。
- `recommendation.ts`：不再并行读取固定位；`buildRecommendedOrder`/`buildRecommendationOrder`/`applyPinnedOnly` 的 `pinnedIds`、`promotedIds`、`fixedId` 参数及分支删除，排序只基于质量分与运营顺序（与“没有配置固定位”时的现有兜底行为一致）。
- `featured-snapshot.ts`（金框）：`resolveLobbyFeaturedIds` 不再接收固定位，按质量分取前 N（与无固定位时一致）。
- `LobbyPinnedCharactersEditor.tsx` 与注册表项删除；`LobbyRankingParamsEditor` 中如有主推说明文案同步删除。
- 风险：若生产当前配置了固定位/主推，发布后首页前几位会变化 → 实施前先用 CLI 读出当前值告知用户。
- 回滚：后端回退部署即可恢复（数据库配置行未删）。

## 6. 菜单归类

`App.tsx` 侧栏 `items` 改为 7 组（结构见 PRD R7）；各视图 key、`resolveAdminMenuSelection` 映射、页面内容不变。分组定义放在 admin-client 的注册表分组（`ADMIN_MENU_GROUPS`：组名 → 成员 key/页面），网页菜单与 CLI `config list` 共用，避免两边不一致。默认展开当前选中项所在分组。

## 7. 演进与发布

- 阶段 1（纯重构）：建 admin-client 并让 Admin SPA 改用它，行为不变；Admin typecheck/test/build 全通过后再继续。
- 阶段 2：CLI（此时注册表仍含待删 key，用它读出生产当前值）。
- 阶段 3：入口清理、后端停用主推与写死打标、菜单归类。
- 无数据库迁移；后端随 Railway 发布、Admin 随 Vercel 发布；CLI 随仓库分发。后端与 Admin 互不依赖，发布顺序无要求。
- 回滚：后端/Admin 回退部署即可（数据库配置未删，主推与打标开关值仍在）；CLI 是本地工具。停止条件：阶段 1 后 Admin 任一测试或构建失败，先修再继续。

## 8. 可验证性

- 自动：admin-client 迁移原有 lib 测试；CLI 新增少量单测锁定安全行为（`--yes` 门禁、覆盖草稿护栏、错误码映射、会话文件权限、非 TTY 拒绝登录）；后端更新推荐/金框/打标相关既有测试。
- 人工（生产）：你本人 `! pnpm admin login` 后，只读命令全部跑一遍；写操作仅在你逐项同意后验证（低风险配置的草稿→发布→回滚各一次）。
