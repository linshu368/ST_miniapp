# 运营平台 CLI 与侧边栏整理

## Goal

让 Claude Code / Codex 等 AI 助手和团队成员**不操作浏览器、不截图**，通过命令行安全、准确地完成**生产环境**运营平台的主要配置与内容操作；同时清理不用的入口并把左侧菜单按业务归类。

## 背景

- 运营平台只有浏览器入口：页面用 Supabase 登录会话直接调 `admin.*` RPC（经后端 `/api/admin/supabase/*` 代理）和少量 `/api/admin/*` HTTP 接口。
- AI 只能靠浏览器扩展点页面，慢、易错、只适合少量操作。
- 现有 `scripts/import-character.ts` 使用 service-role，绕过运营身份与审计，不作为本次方案基础。

## 用户决策（2026-11-03）

- CLI **只操作生产环境**，不支持测试环境。
- 删除入口：回访星尘赠送、分享自动打标开关、推荐主推候选，以及代码已不读取的 3 个配置项。
- 推荐主推候选：**停用功能**，后端不再读取，首页推荐回到无固定位/主推的排序。
- 分享自动打标：**写死为开启**。
- 菜单按已确认的 7 组归类（见 R7）。

## Requirements

### R1 身份与审计不变

- CLI 以操作者本人的运营账号登录（与网页同一套 Supabase 邮箱密码），所有写操作走与网页相同的 `admin.*` RPC / `/api/admin/*` 接口；角色、`can_access_prod`、发布记录操作人与网页一致。
- 不引入 service-role、个人访问令牌或任何绕过数据库鉴权的通道。
- 密码只由人在终端交互输入；非交互环境（AI 调用）禁止登录。会话只存本机用户目录（0600），不进仓库、不打印。

### R2 覆盖范围（生产）

- 运营配置：保留下来的全部 managed config 的 查看 / 说明与默认值 / 本地校验 / 保存草稿 / 差异 / 发布 / 放弃草稿 / 发布历史 / 回滚。
- 角色卡：列表、详情、新建、上传头像、启用/停用、归档、排序；上架布局 草稿 / 差异 / 发布 / 放弃 / 历史 / 回滚 / 删除历史版本。
- 公告：列表、新建、修改、发布/下线、删除。
- 裂变邀请：邀请记录查询、海报上传。
- 回复富文本规则：读取、保存草稿、发布、回滚、放弃、按 request_id 恢复结果。
- 测试类：图片描述模型测试、角色卡审核测试。

### R3 对 AI 友好

- 每条命令支持 `--json`，稳定信封 `{ok,data}` / `{ok:false,error:{code,message,details}}` 与固定退出码。
- 自描述：`help --json` 列出全部命令；`config list` 给出 key、中文名、菜单分组；`config describe <key>` 给出说明、默认值、当前值。
- 写入前用与网页相同的校验规则本地校验，错误精确到字段路径；保存草稿后返回与线上值的差异。

### R4 安全护栏

- 所有写操作非交互时必须带 `--yes`，否则拒绝并返回差异与 `confirmation_required`；交互终端显示差异后要求输入确认。
- 已有与线上值不同的草稿时（可能是他人在网页上未发布的改动），`draft set` 默认拒绝覆盖，需 `--replace-draft`。
- 发布沿用数据库 CAS（草稿 base_version 与运行版本不一致即拒绝），CLI 报告为 `conflict`，不自动重试。

### R5 团队可用

- 仓库内 `pnpm admin <command>` 直接可用；每人一次 `setup`（生产后端地址 + 公开 anon key）+ `login`。
- 文档：CLI README、`AGENTS.md` 运营操作约定（生产写操作先在对话里得到用户确认再带 `--yes`）、Claude Code skill。

### R6 入口清理

| 入口                                                      | 运行时现状                | 处理                             |
| --------------------------------------------------------- | ------------------------- | -------------------------------- |
| 系统兜底角色 `system_fallback_character_id`               | 无读取                    | 删入口                           |
| 每日签到奖励（遗留）`miniapp_daily_checkin_bonus_credits` | 发奖不再读取              | 删入口                           |
| 媒体免费轮次次数 `media_feature_free_trial_limit`         | 不再读取，已隐藏          | 从注册表删除                     |
| 回访星尘赠送（页面）                                      | 运营工具，数据库 RPC 保留 | 删页面与前端调用代码             |
| 分享自动打标开关 `image_plaza_tags_feature_enabled`       | 后端读取，默认开          | 删入口；后端写死开启，不再读配置 |
| 推荐主推候选 `lobby_pinned_characters`                    | 首页推荐、金框、轮换读取  | 删入口；后端停用固定位/主推逻辑  |

- 数据库旧行、校验函数、RPC 不动（删除需单独迁移）。发布历史中出现已删除 key 时正常显示 key 名。
- 删除“分享自动打标”和“推荐主推候选”前，先用 CLI 读取这两个配置的生产当前值并告知用户：若主推当前有值，停用会改变首页推荐顺序；若打标当前为关，写死开启会恢复打标调用。

### R7 菜单归类

```
模型与计费    模型目录 / 兜底配置 / 模型供应商路由 / LLM 计费参数
对话与回复    主体与模块规则 / 回复风格 / 回复长度档位 / 回复富文本规则
角色与大厅    角色卡 / 角色卡审核 / 推荐轮换与质量评分
充值与会员    充值套餐 / VIP 策略 / 角色卡免费对话轮次 / 免费额度耗尽轻提示
用户增长      新用户赠送星尘 / 新用户签到奖励 / 老用户签到奖励 / 裂变邀请管理 / 公告管理
图片          图片生成配置 / 图片广场
发布历史
```

各页面的内容与行为不变，只调整菜单位置；CLI `config list` 使用同一分组。

## Acceptance Criteria

- [ ] `pnpm admin login` 交互登录生产成功；`whoami` 显示邮箱、角色、生产权限；非 TTY 下 `login` 返回错误且不读取密码。
- [ ] 会话文件 0600；输出与日志不含 token、密码、anon key。
- [ ] 生产只读命令全部跑通（whoami、config list/describe/get、draft get、releases、character list/get、layout get/releases、announcement list、invite records、text-rules get）。
- [ ] 任一写命令不带 `--yes` 时返回 `confirmation_required` 且生产无任何写入；本地校验失败给出字段路径且不调用接口。
- [ ] 经用户逐项同意后，在生产对一个低风险配置完成 `draft set → diff → publish → get` 与 `rollback`，网页可见同一记录且操作人为本人。
- [ ] 已有草稿时 `draft set` 返回 `draft_exists`；会话过期返回 `auth_required`。
- [ ] Admin：typecheck/test/build 通过；菜单为 R7 结构；6 个入口已删除；发布历史可显示旧 key。
- [ ] 后端：首页推荐与金框不再读取主推配置；分享打标恒开启；相关测试通过。
- [ ] 文档：CLI README、AGENTS.md 约定、Claude Code skill、spec/架构更新。

## Android/iOS 性能 P95 门禁

- 受影响页面：角色大厅 `/characters`（推荐顺序与金框来源变化）。
- 受影响接口：`POST /api/characters/recommendation`、`GET /api/characters`（金框快照）、`POST /api/image-plaza/share`（打标开关改为常量）。
- 变化性质：删除一次 60 秒缓存的配置读取与固定位拼接，预期不增加耗时；目标为不退化。
- 基线：复用同日实测（11-03-latest-lobby-mobile-p95）：/characters 关键视觉 Android 5907ms（N=75）、iOS 2538ms（N=6，低样本）；GET /api/characters P95 214ms。推荐口径与另两个接口未单独取样，记为无可见样本。详见 task.json。
- 发布后：同口径观察 7 天，单组有效样本 <100 标为低样本并延长。

## Out of Scope

- 测试环境 CLI、个人访问令牌 / 服务账号、MCP server、网页新功能。
- `scripts/import-character.ts` 改造；回访赠送 CLI。
- 删除数据库中已废弃 key 的数据、校验函数与 `grant_user_credits` 等 RPC。
