# 设计：阶段 3 用户与状态拆分

总计划见 `../11-17-db-reorg/design.md` 阶段 3；规则见 `docs/db/CONTRACT.md`。用户 2026-11-17 定：碰钱也直接做，以终态干净为准，核对不能省。

## 通用做法：扩展 → 发布 → 收缩

列搬迁不能用兼容视图。每步拆两个 migration：

1. 扩展：建新表并回填；数据库函数与视图一次改读写新表；旧后端仍写的旧列由触发器同步到新表（只补空值）；旧后端仍调的旧函数名保留为兼容壳（写新表并顺带维护旧列）。
2. 后端发布（从 main 拉发布分支）。
3. 核对：`pg_stat_statements` 中旧写法停涨、新表有写入。
4. 收缩：锁旧表，按回填规则再补一次（吸收扩展执行期间旧后端只写进旧列的竞态残差），守卫（补齐后新表不缺值、无函数再引用旧列）后删触发器、兼容壳、旧列。

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

## 3b settings 拆分

3a 已于 11-17 上生产。`miniapp_user_settings`（生产 6717 行，users 7317）剩 26 列，拆成两轮扩展→发布→收缩，每轮后端改动独立可核对：

- 3b-1 标记：一次性/水位标记进 `miniapp_features.user_marks`，删无读者的旧计数器。
- 3b-2 资料与改名：资料列进 `app_core.users`，剩余偏好表改名 `app_core.user_preferences`（单独设计，3b-1 上线后再写）。

### 3b-1 标记（生产只读核对，11-17）

| 旧位置                                                                                                                                                                     | 生产现状                                                                                                                                            | 去向                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `miniapp_features.growth_prompt_states`                                                                                                                                    | 339 行；写只经 `record_growth_prompt_event`，后端直读（2166 次）                                                                                    | 并入 `user_marks`，`mark_key = growth_prompt.<community\|vip>`；原表在扩展步删除，留同名只读兼容视图给旧后端，收缩步删视图 |
| settings.`vip_entry_seen_at`                                                                                                                                               | 224 行；`MiniappVipRepository` 读写                                                                                                                 | `user_marks` `vip_entry.seen`（first_at 即首次查看）                                                                       |
| settings.`characters_last_seen_at`                                                                                                                                         | 1513 行；首页「最新」New 水位                                                                                                                       | `user_marks` `characters_latest.seen`（last_at 即水位）                                                                    |
| settings.`image_plaza_first_share_completed_at`                                                                                                                            | 7 行；与 `billing.image_plaza_share_rewards` 的用户集合完全一致、时间差 <5s（每次首发分享都在同一事务写一条返利记录，返利为 0 也写）                | 删列，改由返利记录是否存在推导；`share_image_plaza_artifact` 去掉那段 upsert（收缩步做，避免发布窗口旧后端读到旧值）       |
| settings.`choice/status/memory_full_rules_remaining` + `claim_instruction_slot_modes` + `instruction_slot_claim_*` + 触发器 `trg_apply_instruction_slot_preference_window` | 10-13 起已改为会话级（`chat_history.turn_index`），注释写明"只为回滚保留"；后端不读，`claim_instruction_slot_modes` 统计 0 次调用；只剩触发器在维护 | 扩展步直接删（不迁）。registry 原计划迁到 user_marks，按实况改为删除                                                       |

`miniapp_features.user_marks`（S，每用户每标记一行，FK users 级联删除）：`user_id, mark_key, count, first_at, last_at, last_action, last_action_at, created_at, updated_at`，主键 `(user_id, mark_key)`。`mark_key` 只校验格式 `<功能>.<事件>`，新标记不改表。service_role 只读，写只经函数：

- `miniapp_features.touch_user_mark(user_id, mark_key, at)`：count+1，first_at 只写一次，last_at 取最新；返回 count/first_at/last_at。
- `record_growth_prompt_event`：签名不变，改写 `user_marks`（次数与间隔上限的原子判定照旧）。

发布窗口（扩展后、新后端上线前）：

- 旧后端写 settings 的两列，由 settings 上的触发器同步进 `user_marks`（first_at 只补空、last_at 取大，不加 count）。
- 新后端经 `touch_user_mark` 写的两个标记，由 `user_marks` 上的触发器回写 settings，旧实例读到的也是新值。两个触发器都只在值变化时写，并用 `pg_trigger_depth()` 防回环。
- 旧后端读 `growth_prompt_states` 走兼容视图（列名照旧）。

收缩：锁 settings，按回填规则再补一次；删两个同步触发器、兼容视图、settings 三列；`share_image_plaza_artifact` 去掉 settings upsert（替换前校验线上函数体 md5 与采集时一致，防止覆盖别人的改动）。

后端：新增 `UserMarksRepository`（读标记、touch），VIP 入口、首页「最新」水位、增长弹窗读次数都经它；图片广场"已完成首发分享"改读返利记录是否存在。

验证：`bash scripts/test-db-reorg-p3b1-migration.sh`（回填一致；增长弹窗上限/间隔判定前后一致；窗口内新旧两边写入互相可见且不回环；首发分享推导与旧列一致；收缩补齐与删除；可重跑）。

## 3c 之后

待 3b 上线后逐个设计（角色上架、配置校验链）。
