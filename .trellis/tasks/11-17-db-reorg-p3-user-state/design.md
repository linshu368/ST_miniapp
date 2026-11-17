# 设计：阶段 3 用户与状态拆分

总计划见 `../11-17-db-reorg/design.md` 阶段 3；规则见 `docs/db/CONTRACT.md`。用户 2026-11-17 定：碰钱也直接做，以终态干净为准，核对不能省。

## 通用做法：扩展 → 发布 → 收缩

列搬迁不能用兼容视图。每步拆两个 migration：

1. 扩展：建新表并回填；数据库函数与视图一次改读写新表；旧后端仍写的旧列由触发器同步到新表（只补空值）；旧后端仍调的旧函数名保留为兼容壳（写新表并顺带维护旧列）。
2. 后端发布（从 main 拉发布分支）。
3. 核对：`pg_stat_statements` 中旧写法停涨、新表有写入。
4. 收缩：守卫（新表不缺值、无函数再引用旧列）后删触发器、兼容壳、旧列。

## 3a 归因与轮数

现状（生产只读，11-17）：

- users 7297 行；settings.total_round 与 users.total_round 6656 行相同、51 行 settings 偏小（建行晚），以 users 为准。
- `st_initialized_at` 生产 3257 行非空，TEST 已删列（迁移用 `to_jsonb` 可选读取）。
- 读写方：`lib/user.ts`（建号、首次进入、bot 首启）、`routes/invite.ts`（补 source_id）、`settle.ts`（轮数 +1）、`record_app_entry`、`check_invite_chat_rounds_reward`（邀请满轮奖励）、`cs_feed.user_profiles`、`traffic_daily_stats`（运营在 Supabase 后台看）。
- 8 个分析视图（同期群/LTV/生态/漏斗/base\_\*）10-23 起 0~1 次查询，只授给已弃用的画像簇账号：删除。

终态：

| 表/函数                                                      | 内容                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `app_core.users`                                             | id、tg_id、created_at、updated_at                                                      |
| `miniapp_traffic.user_attributions`                          | source_id、bot_entered_at、miniapp_entered_at、st_initialized_at（FK users，级联删除） |
| `experience.user_chat_stats`                                 | total_round（无行=0）                                                                  |
| `app_core.ensure_user(tg_id)`                                | 只建身份；先查后插，新用户钱包奖励触发器（AFTER INSERT）只对真插入生效                 |
| `miniapp_traffic.enter_user(tg_id, source, entry)`           | 建号 + 归因，一次往返；无变化只读；返回原 users 行形状（含 total_round）               |
| `experience.increment_user_total_round` / `user_total_round` | 轮数写/读                                                                              |

验证：`bash scripts/test-db-reorg-p3a-migration.sh`（`traffic_daily_stats`、`cs_feed.user_profiles` 迁移前后逐行一致；enter_user 各入口语义；旧后端写法同步；邀请奖励门槛前后；幕间入口判定；收缩守卫与删列）。

## 3b 及之后

待 3a 上线后逐个设计（settings 拆分、角色上架、配置校验链）。
