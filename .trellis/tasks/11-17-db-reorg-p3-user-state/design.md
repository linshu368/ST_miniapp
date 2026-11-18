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

### 3b-2 资料进 users、settings 改名 user_preferences（生产只读核对，11-17）

3b-1 已上生产。settings 剩 20 列：资料 7 列（tg_username / tg_first_name / tg_last_name / tg_avatar_url / display_name / custom_avatar_url / avatar_url）+ 偏好 10 列 + user_id / 时间戳。

| 对象                                                                      | 现状                                                                                                                              | 去向                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 资料 6 列                                                                 | 仓库每次 getOrCreate 都无条件回写 TG 资料（每次一条 UPDATE）                                                                      | 加到 `app_core.users`；TG 资料刷新改为 `app_core.refresh_user_profile`，值没变不写        |
| `avatar_url`                                                              | 544 行全是旧 TG 头像链接；72 行与 tg/custom 不同，都是 `tg_avatar_url` 上线后没再登录的用户；后端不读，这些用户现在就显示默认头像 | 删除，不迁（删了界面无变化）                                                              |
| 偏好 10 列                                                                | 仓库 + 4 个函数（两个开轮函数、回复风格、指令槽偏好）读写                                                                         | 留在原表，整表改名 `app_core.user_preferences`（含另一会话 11-17 加的 `pref_drive_mode`） |
| `cs_feed.user_identities`                                                 | 读 settings 的昵称                                                                                                                | 扩展步改读 users，输出列不变                                                              |
| `admin.list_invite_records` / `admin.lookup_user_for_credit_grant`        | join settings 取昵称                                                                                                              | 扩展步改 join users（按原文替换 join 语句，别名不变）                                     |
| 后端 raw SQL：`features/creator/public-author.ts`、`routes/characters.ts` | join settings 取作者昵称                                                                                                          | 改 join users                                                                             |

发布窗口（扩展后、新后端上线前）：

- 新后端写偏好经扩展步建的同名自动可更新视图 `app_core.user_preferences`（只含偏好列，落到 settings），收缩步删视图、表改名，名字不变，后端不用再发。
- 资料两边同步：旧后端写 settings 资料列 → 触发器同步到 users（INSERT 只带非空值，UPDATE 只带变化的列）；新后端写 users → 回写 settings（旧实例读到新值）。`pg_trigger_depth()` 防回环。
- 不变式：窗口内每个 settings 行的资料与 users 一致。新建 settings 行（新后端经视图建偏好行、开轮函数、回复风格函数）不带资料，BEFORE INSERT 先从 users 填上；否则收缩步"按 settings 补 users"会把新后端先写进 users 的资料冲掉（本地测试 1039 场景复现过）。

收缩：

1. 删同步触发器；锁 settings，资料不一致的列按 settings 补到 users（只可能来自扩展事务里的竞态，窗口内两边同步）。
2. 守卫：除 4 个偏好函数外不得再有函数引用 `app_core.miniapp_user_settings`。
3. 删视图 → 表改名 `user_preferences`（约束、索引同步改名）→ 删 7 个资料列。
4. 4 个偏好函数按原文把 `app_core.miniapp_user_settings` 换成 `app_core.user_preferences`（每个函数出现次数须与采集时一致，否则拒绝）。

后端：新增 `UserProfileRepository`（users 资料读写、`refresh_user_profile`）；`MiniappUserSettingsRepository` 改为组合资料 + 偏好，对外接口和返回形状不变；开轮读偏好与昵称改为同一请求内并行两次读取。Prisma 设置模型改名 `user_preferences`。

验证：`bash scripts/test-db-reorg-p3b2-migration.sh`（回填一致；`cs_feed.user_identities` 与两个管理函数前后输出一致；窗口内双向同步不回环；资料没变时不写；视图插入/更新照常（默认值、CHECK、回复风格原子合并）；收缩改名后 4 个函数照常；可重跑）。

## 3c 角色上架状态拆出 characters（生产只读核对，11-18）

现状：`app_core.characters` 1077 行（874 在架、18 归档），上架 4 列 `enabled / sort_order / archived_at / last_listed_at` 与卡内容同表，写入方是运营布局发布与创作者发布/审核（卡内容写入方是导入、创作、审核）。

| 对象                                                                                            | 现状                                                                | 处理                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `admin.archive_character` / `set_character_enabled` / `reorder_characters`                      | 10-23 起 0 次调用；CLI 注释写明网页与 CLI 都已改走"布局草稿 → 发布" | 扩展步删除                                                                                                     |
| `admin.get_characters` / `get_character_layout` / `publish_character_layout_draft`              | 运营网页/CLI 在用                                                   | 扩展步整函数重写为读写 `character_listings`；输出不变（列表的 `updated_at` 取卡与上架两者较晚，界面所见不变）  |
| `admin.create_character`                                                                        | 返回 `app_core.characters` 行类型                                   | 改为返回 jsonb：卡字段 + 上架字段，键与原来一致（删列后行类型会缺字段）                                        |
| `app_core.can_discover_character` / `can_use_character`                                         | 可见性判断                                                          | 重写为 join 上架表                                                                                             |
| `app_core.mutate_creator_character` / `review_creator_character`                                | 只有建卡写上架初值、发布/审核刷新上架时间几句涉及                   | 按原文定位只替换这几句（删掉的文本与预期不一致就拒绝）                                                         |
| 触发器 `trg_characters_track_listing`                                                           | 上架/恢复时刷新 `last_listed_at`                                    | 移到上架表（逻辑不变）                                                                                         |
| CHECK `characters_test_cards_disabled`                                                          | 测试卡必须下架且有 card_hash（跨内容与上架列）                      | 拆成：卡片表 CHECK"测试卡必须有 card_hash" + 上架表守卫"测试卡不能上架" + 卡片表守卫"已上架的卡不能改成测试卡" |
| `miniapp_analytics.v_card_quality_session`                                                      | 人工分析偶用                                                        | 改 join 上架表，列不变                                                                                         |
| 后端 Prisma（大厅列表/最新角标/详情/收藏/推荐/可见性公共条件）、raw SQL（大厅目录、创作者主页） | 读上架列                                                            | 改读 `listing` 关系 / join 上架表                                                                              |
| `scripts/import-character.ts`                                                                   | 直接往 characters 写 enabled/sort_order                             | 改为插卡后更新上架行                                                                                           |

`app_core.character_listings`（S，每卡一行，FK characters 级联删除）：`character_id, enabled, sort_order, archived_at（沿用北京时间无时区）, last_listed_at, updated_at`。不变式：每张卡恰有一行上架记录——`characters` 插入后触发器自动建行（扩展期间按卡片表上那 4 列的值建，收缩后按默认值：下架、排序 0），各写入方插卡后再更新上架行。`characters.enabled` 默认值改为 false，与"新卡默认下架"一致。

发布窗口：数据库里的写入方全部在扩展步换成新函数，后端不直接写上架列，所以只需单向镜像：上架表 AFTER INSERT/UPDATE → 回写 characters 的 4 列，供旧后端读。卡片表的上架时间触发器在扩展步删除（由上架表负责），镜像不会再被它改写。

收缩：删镜像触发器；插卡触发器换成按默认值建行；守卫（上架表与镜像列一致；除本次重写的函数外，不得再有函数读 characters 的上架列）；删旧 CHECK、3 个旧索引、旧触发器函数和 4 列。

验证：`bash scripts/test-db-reorg-p3c-migration.sh`（回填一致；三个运营函数与可见性函数前后输出一致；布局发布、新建卡、创作者建卡/发布/审核在新旧两种实现下结果一致；测试卡守卫；窗口镜像；收缩守卫与删列；可重跑）。

实现中的补充决定（11-18）：

- 权限：service_role 对 characters 本就有全部权限，上架表只给 SELECT + UPDATE（官方卡导入脚本插卡后设上架值）；建行由插卡触发器做，删行随卡级联。
- 导入脚本 `scripts/import-character.ts`：卡片表只写内容，插入后更新上架行（正式卡上架、按指定排序；测试卡保持下架）；上架行写失败则删卡和已上传文件。
- 布局发布不再改卡片表的 `updated_at`（原来每次发布把全部卡的 updated_at 刷成当时），运营列表的"更新时间"取卡与上架两者较晚，界面所见不变。核过：后端没有把卡片 `updated_at` 当缓存/变更信号的读者（大厅目录按字段指纹失效）。
- 创作者函数写 `characters.updated_at=now()` 时按会话时区（UTC）落成无时区值，比北京时间早 8 小时，是既有问题；本次只替换上架几句，不顺手改。
- 收缩步"仍有函数读旧列"的守卫按"引用 app_core.characters + 出现 4 个列名 + 不含 character_listings"判定，上架表自己的两个触发器函数按名排除（本地测试抓到误报）。
- 核对（后端发布后）：pg_stat_statements 里带 `"app_core"."characters"."enabled"` / `"last_listed_at"` / `"sort_order"` 且不含 `character_listings` 的语句停涨，新的 join 上架表语句在涨；之后再执行收缩步。

## 3d 之后

待 3c 上线后设计（配置校验链）。
