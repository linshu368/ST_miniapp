# 数据库契约

> **读者是 AI。** 任何会改变数据库形状或数据落位的改动，动手前读完本文，并在 [`registry.yaml`](./registry.yaml) 查相关表的条目。包括：
>
> - 写 migration；新表、新列、新视图、新函数、新触发器；
> - 往 jsonb 里加键、加配置 key；
> - 让外部系统读库。
>
> 三份文件分工：
>
> - **本文件**：东西放哪里、怎么建、怎么改。
> - **`registry.yaml`**：每张表现在是什么、谁写、有什么限制。
> - **`.trellis/spec/database/supabase/`**：迁移执行、RLS、回滚的细节。
>
> `docs/ARCHITECTURE.md` 等处与本文冲突的旧描述，一律以本文为准。

---

## 0. 落位卡（最短版本，必须记住）

1. 每张表有且只有一组坐标：**业务域（schema）× 数据性质（M/O/J/D/C/S/E）**，登记在 `registry.yaml`。
2. 新字段先判性质（§1.2），再找同域、同性质、同写入模块的表。性质、写入模块、写入时机、生命周期有一项不同，就**不进这张表**，改建旁表或子表。
3. **钱只进 `billing`**：
   - 每次可计费动作在 `billing.usage_charges` 记一行；
   - 每笔星尘变动在 `billing.wallet_ledger` 记一行；
   - 业务表只存 `*_charge_id` / `*_ledger_id`。
4. **观测只进 `ops`**，并且只在需要用 SQL 聚合或做看板时才建表；只为排障的信息写 pino 日志。上游模型调用统一记在 `ops.llm_calls`。
5. 租约、重试、退避只进 `*_jobs` 表。
6. 不为下面两类加列：
   - 一次性 UI 标记，写 `features.user_marks`；
   - 功能配置，是一个 `<feature>_config` 托管 key。
7. jsonb 只用于 `*_snapshot`、`raw_*`、`*_detail`。要被过滤、计费、分支判断的值必须是真列。
8. 外部系统只读视图层（`cs_feed`、`analytics`）。产品请求路径不读 `ops` 和 `analytics`。
9. 改已有结构按"扩展 → 后端发布 → 收缩"三步走（§7）。迁移文件在任何环境执行过就不再修改。
10. 以下改动在同一个 PR 里更新 `registry.yaml`：
    - 建表、删表、搬表；
    - 给 jsonb 列加键。

---

## 1. 两个坐标

### 1.1 业务域（schema）：归谁管

| schema        | 管什么                                                                                                       | 不管什么（常见误放）                                |
| ------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `app_core`    | 用户身份与资料、用户偏好、角色卡（内容、版本、上架、创作草稿）、全局运行配置与后处理版本                     | 功能状态、计数缓存、一次性标记                      |
| `experience`  | 对话：会话、轮次内容、交付状态、上游调用身份、语音产物、长期记忆、对话内用户操作（编辑、点赞、反馈、状态栏） | 价格与扣费、测速、上游用量和成本                    |
| `media_plaza` | 图片 / 视频广场完整链路：会话、消息、生成尝试、产物、作品、点赞                                              | 价格与扣费                                          |
| `billing`     | 订单、流水、余额、计费记录与冻结报价、VIP 权益、返利与奖励账                                                 | 支付监控事件、结账测速                              |
| `features`    | 随某个产品功能上下线的状态：社交、大厅推荐、签到、通知、社群、畅聊候选、用户标记                             | 跨功能根数据、调用明细                              |
| `traffic`     | 渠道链接、点击、入口事实、邀请关系、用户归因                                                                 | 用户身份本身                                        |
| `admin`       | 运营平台自身：运营账号、草稿、发布记录、运营审计、托管 key 登记                                              | 发布后的运行真相（在 `app_core`）                   |
| `ops`         | 工程观测：上游模型调用（token、成本、原始返回）、prompt 留档、支付与运维事件、告警                           | 任何会改变用户结果或扣费的数据                      |
| `analytics`   | 只为看数存在的视图、日汇总；Grafana 与指标读者的唯一入口                                                     | 产品运行会读的结果（例如大厅排序分属于 `features`） |
| `cs_feed`     | 本仓库维护、给客服仓库读的只读视图                                                                           | 任何表                                              |

外部 schema（本仓库不新增对象）：

- `cs`：客服仓库 ST_cs_platform 拥有。
- `drama_archive`：短剧上传端拥有，本仓库只拥有 `drama_likes`、`drama_comments` 两张表。
- `public`：只放 Supabase 平台对象，不放业务对象。

**新建 schema 的门槛**：只有当一类数据有独立的读者权限或生命周期，并且放进现有域会混淆落位时，才新建。新建要在 `registry.yaml.schemas` 登记、补授权，并更新本表。功能分组靠**表名前缀**（`lobby_*`、`free_zone_*`、`image_plaza_*`），不靠 schema。

### 1.2 数据性质：是哪类数据

按顺序判定，命中第一个就停：

| 序  | 代号  | 性质 | 判定问题                                                 | 表名形态                                                       | 只能放在                                    |
| --- | ----- | ---- | -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| 1   | **M** | 钱   | 这个值写错了，会多扣、少扣星尘、现金或权益吗？           | `*_orders` `*_ledger` `*_charges` `*_grants` `*_rewards`       | `billing`                                   |
| 2   | **O** | 观测 | 删掉它，用户看到的结果和扣的钱都完全不变吗？             | `*_calls` `*_events` `*_observations`                          | `ops`                                       |
| 3   | **J** | 任务 | 它有租约、重试次数、下次重试时间、last_error 吗？        | `*_jobs`                                                       | 任务所属业务域（`ops` 内部任务放 `ops`）    |
| 4   | **D** | 派生 | 它能从别的表重新算出来吗？                               | `*_stats` `*_scores` `*_daily` `*_snapshot(s)`、视图           | 产品会读的放所属域；只看数的放 `analytics`  |
| 5   | **C** | 配置 | 是运营或工程发布、带版本的规则吗？                       | `runtime_config` key、`*_versions`、`admin.*_drafts/_releases` | `app_core`（运行真相）/ `admin`（发布过程） |
| 6   | **S** | 状态 | 只关心最新值、可以随时覆盖吗？（偏好、关系、标记、进度） | `*_preferences` `*_states` `*_marks`、`a_b` 关系表             | 所属域                                      |
| 7   | **E** | 实体 | 用户能看到、别处会引用的业务对象                         | 名词复数                                                       | 所属域                                      |

判定细则：

- 测速、耗时类数据要先过第 1、2 题：
  - 被计费或交付判定读取的，不是 O，属于所在表的 S/E。例如 `chat_generation_requests` 的首字时间，计费门禁要读。
  - 判定以"有没有业务代码或函数读它做决定"为准，不看名字像不像测速。
- 实体表可以带**自身**的生命周期列：
  - `status` 和状态迁移时间（`completed_at`、`deleted_at`）；
  - 主人可改的展示属性（标题、置顶、文件夹）；
  - 在 registry 里登记为 D、由触发器维护的计数缓存。

  除此之外的其他性质都不行。

- 一张表只登记一个性质。

---

## 2. 现有骨架：接新功能先找这些表

新功能先挂到下面这些表上，不要另起一套。每张表的列和限制以 `registry.yaml` 为准。

| 关注点     | 表                                                                                                       | 要点                                                                                                                                                                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 用户身份   | `app_core.users`                                                                                         | 只有身份与资料；建号只走 `app_core.ensure_user`；不放功能状态                                                                                                                                                                                                                                                            |
| 用户偏好   | `app_core.user_preferences`、`app_core.user_character_preferences`                                       | 每人一行 / 每人 × 每卡一行；无行 = 默认值                                                                                                                                                                                                                                                                                |
| 一次性标记 | `features.user_marks`                                                                                    | 主键 `(user_id, mark_key)`，`mark_key = <功能>.<事件>`，新 key 在 `UserMarksRepository.ts` 的 `USER_MARK_KEYS` 登记，不改表                                                                                                                                                                                              |
| 用户计数   | `experience.user_chat_stats`                                                                             | D 表；无行 = 0                                                                                                                                                                                                                                                                                                           |
| 角色卡     | `app_core.characters` / `character_versions` / `character_listings` / `character_creations`              | 依次是内容、不可变版本（会话按版本绑定）、上架与排序、作者草稿与审核                                                                                                                                                                                                                                                     |
| 对话       | `experience.chat_sessions`、`experience.chat_history`                                                    | 一轮一行，存内容与交付状态；计费只存 `llm_charge_id`                                                                                                                                                                                                                                                                     |
| 交付       | `experience.chat_generation_requests` / `chat_generation_attempts`                                       | 交付状态与上游调用身份。门禁和结算要读，不是观测                                                                                                                                                                                                                                                                         |
| 每轮附属   | `chat_history_display_metadata`、`chat_reply_feedback`、`chat_message_likes`、`chat_status_snapshots` 等 | 新的每轮附属数据照这个样子建旁表，**不往 `chat_history` 加列**                                                                                                                                                                                                                                                           |
| 星尘流水   | `billing.wallet_ledger`、`billing.user_wallets`                                                          | 每笔变动一行。`entry_type` 用 CHECK 登记，`reference_type` / `reference_id` 指回来源。余额是流水的投影，同一事务维护                                                                                                                                                                                                     |
| 计费记录   | `billing.usage_charges`                                                                                  | 每次可计费动作一行：<br>- `kind` 区分功能；<br>- `id` 即 charge_id，扣费函数用它做幂等；<br>- `quote` 存冻结报价；<br>- `status` 走 quoted → charged / free / failed / refunded；<br>- 永久保留。<br>文本已并入（轮次只存 `llm_charge_id`）；语音、广场计费仍在原位置（registry 里 `moving` 的计费列），不要在旧位置扩展 |
| 订单与支付 | `billing.payment_orders`、`billing.payment_reconcile_jobs`、`ops.payment_events`                         | 订单与履约事实、对账任务、支付事件分三处                                                                                                                                                                                                                                                                                 |
| 奖励、返利 | `billing.*_rewards` 等记账表                                                                             | 记账行与 `wallet_ledger` 流水同一事务写                                                                                                                                                                                                                                                                                  |
| 模型调用   | `ops.llm_calls`、`ops.llm_cost_jobs`                                                                     | 每次上游调用一行（`provider`、`lane`、`role`、token、`cost_usd`、`cost_source`）。成本事后补查走 `llm_cost_jobs`。每轮成本看 `analytics.llm_call_costs` / `llm_turn_costs`                                                                                                                                               |
| 后台任务   | `experience.story_memory_jobs`（样板）、`billing.payment_reconcile_jobs`                                 | 列：`status`、`attempts`、`next_attempt_at`、`lease_owner` / `lease_until`、`last_error`。多副本靠 `SKIP LOCKED` 加租约互斥                                                                                                                                                                                              |
| 配置       | `app_core.runtime_config`、`admin.managed_config_keys`                                                   | 加 key 的做法见 §3.4                                                                                                                                                                                                                                                                                                     |
| 看数       | `analytics.*` 视图、`analytics.core_daily`                                                               | 日汇总由 pg_cron 刷新；Grafana 只读账号经 reader 角色只读这些视图                                                                                                                                                                                                                                                        |
| 客服       | `cs_feed.user_identities` / `user_profiles`                                                              | 输出列保持不变，内部拆表只改视图定义                                                                                                                                                                                                                                                                                     |

### 2.1 常见需求怎么落

| 要做的事                   | 怎么落                                                                                                                          | 不要                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 新功能的业务对象           | 在所属域新建 E 表，表名带功能前缀                                                                                               | 塞进已有表的 jsonb                    |
| 某张表每行的附属数据       | 一对一建旁表（主键就用原表主键），一对多建子表                                                                                  | 往热表（`chat_history`、`users`）加列 |
| 看过、领过、剩几次         | `user_marks` 加一个 `mark_key`                                                                                                  | 加列、建标记表                        |
| 用户偏好、开关             | `user_preferences` 加列（与用户相关）；与卡相关进 `user_character_preferences`                                                  | 另建偏好表                            |
| 要收费                     | 在 `usage_charges` 记一行（新功能加 `kind` 值）；扣费函数在同一事务写 `wallet_ledger`；业务表只存 charge_id                     | 业务表抄价格、折扣、VIP 快照列        |
| 发星尘（奖励、返利、补偿） | 在 `billing` 复用或新建 `*_rewards` 记账表，同一事务写 `wallet_ledger`（新 `entry_type` 进 CHECK）                              | 只改余额不记流水                      |
| 新的模型调用场景           | 走 `features/generation`；每次调用写 `ops.llm_calls`，新场景加 `lane` 值（改 CHECK）                                            | 按场景或供应商另建调用表              |
| 异步任务、重试             | 建 `<feature>_jobs`，照 `story_memory_jobs` 的列和领取方式                                                                      | 在实体表加 `lease_*`、重试列          |
| 测速、耗时、诊断           | 先问有没有业务逻辑读它：<br>- 有：是业务列；<br>- 没有，但要聚合或做看板：建 `ops` 表，写清保留期；<br>- 只为排障：写 pino 日志 | 测速列加进实体表                      |
| 运维、支付类事件           | `ops.*_events`，带去重键和保留期                                                                                                | 在业务表里追加事件行                  |
| 大文本、原始请求和响应     | 确有读者才留档，放 `ops` 并带保留期；没有读者的不存（`chat_prompt_observations` 11-23 因无人读取删除）                          | 塞进热表的 jsonb                      |
| 运营可调参数               | 一个 `<feature>_config` 托管 key（§3.4）                                                                                        | 散装 key、硬编码                      |
| 看板指标                   | `analytics` 视图；查询重的做日汇总表加 pg_cron，授权给 Grafana reader 角色                                                      | Grafana 直查业务表                    |
| 给客服看的数据             | `cs_feed` 视图，视图级授权                                                                                                      | 给客服角色表级 SELECT                 |
| 计数、排行                 | 可重算的 D：<br>- 触发器维护的计数列（registry 标 `maintained_by`）；<br>- 或者定时刷新的 `*_stats` / `*_scores` 表             | 同一个数存两处                        |

---

## 3. 落位细则

### 3.1 新字段（最常见，最容易乱）

1. 按 §1.2 判定字段性质。
2. 在 `registry.yaml` 找候选表：同域、同性质、`owner` 是同一个模块。
3. 逐条检查，**全部满足**才能加列：
   - **同性质**：E/S 表不收 M、O、J 字段。
   - **同写入模块**：由拥有这张表的模块写。
   - **同写入时机**：如果这张表的行在创建时一次写完，就不收这类列：
     - 事后回填；
     - 客户端补报；
     - 对账结果；
     - 异步任务进度。

     实体自身的状态迁移除外。

   - **同生命周期**：随同一个功能上线和删除，保留期相同。
   - **有读者**：说得出谁会读它、读来做什么。只写不读的数据不存。

4. 有任一条不满足：
   - 与原表是一对一 → 建**旁表**，主键就用原表主键。
   - 与原表是一对多 → 建**子表**。
   - 性质要求换域（M → `billing`，O → `ops`）→ 在目标域建表，用软引用关联回来（§4）。
5. 候选表在 registry 的 `status` 是 `frozen` 或 `moving` → 不加列，走第 4 步。

### 3.2 新表

在任务的 `design.md` 里先写清下面几项，再写 migration：

1. `schema.table`、一句话业务含义、性质代号；
2. 权威写入模块（registry 的 `owner`）、读者；
3. 生命周期与保留期。`ops` 表必须写保留天数和清理方式（pg_cron 或后台任务）；
4. 跨域引用（§4）；
5. 有没有已有表维护同一个事实（先查 §2）。有就扩展它或建旁表，不复制第二份事实。

建表的同时完成以下各项：

- 表名后缀与性质一致（§1.2）；
- 开 RLS，只授权给实际需要的角色（后端用 `service_role`）；
- 表和关键列写 `COMMENT`；
- `registry.yaml` 同一个 PR 登记。

### 3.3 jsonb 列和新 jsonb 键

jsonb 只允许三种用途，列名必须体现用途：

| 用途                                 | 列名         | 例                                            |
| ------------------------------------ | ------------ | --------------------------------------------- |
| 不可变快照（写一次，按当时状态保存） | `*_snapshot` | 价格快照、角色卡版本内容、发给模型的 messages |
| 供应商或外部系统原始返回             | `raw_*`      | `raw_usage`、`raw_response`                   |
| 观测诊断明细（只在 O 表）            | `*_detail`   | 落败片段、慢请求诊断                          |

- 新列禁止叫 `metadata`、`extra`、`data`、`info`、`payload`、`state` 这类不说明用途的名字。存量的 `metadata` 列冻结，不加新键。
- 业务代码要拿来过滤、排序、聚合、计费、分支判断的值，必须是真列。
- 每个 jsonb 列在 `packages/shared` 里要有 zod schema，键名登记在 registry 该列的 `keys`。加键就是改契约，要同步更新。

### 3.4 新配置 key

- 一个功能一个对象型 key，命名 `<feature>_config`，参照 `free_zone_config`。功能的新参数加进这个对象，不另开散装 key。
- 某个功能已经有散装 key，要给它加参数时，先把散装 key 合并成 `<feature>_config` 再加。
- 只有 `platform/runtime-config.ts` 能读 `runtime_config`。
- **运营托管 key 的做法**：
  1. `INSERT INTO admin.managed_config_keys` 登记；
  2. 在 `admin.validate_managed_config_value`（单层 `CASE p_config_key` 分发）里用 `CREATE OR REPLACE` 原地加一个 `WHEN` 分支。校验超过十几行就拆成具名函数 `admin.validate_<key>(...)`，分支里一句 `PERFORM`；
  3. 在 `packages/admin-client` 注册 schema 和菜单（CLI 自动支持）。
- **功能下线**：在同一个 PR 退役 key，具体是：
  - 登记表 `retired_at` 设为当前时间（发布历史仍可引用）；
  - 删除 `runtime_config` 行；
  - admin-client 注册表和 CLI coverage 同步改。

### 3.5 数据库函数、视图、触发器

- 函数跟随它维护的不变量所在的域。视图跟随用途：看数的放 `analytics`，给客服的放 `cs_feed`。
- **禁止包装链**：不许把旧函数改名成 `*_before_<feature>`、新函数里 `OR` 调旧函数。白名单、校验这类"每加一项就要改"的逻辑，用"登记表 + 一个函数"实现。
- 改函数签名或行为，用 `CREATE OR REPLACE` 原地替换，不保留旧版本。改签名时，后端调用方和 `backend/src` 下的测试在同一个 PR 改。
- 触发器只用于数据库必须保证的跨写一致性（计数缓存、余额投影），并在 registry 对应列标明 `maintained_by`。业务流程不藏在触发器里。
- 按某个唯一约束"只取一行"的函数和视图，依赖这个约束。放宽唯一约束前先把它们全找出来。

### 3.6 新的外部读者

外部系统（客服仓库、Grafana、指标脚本）**不直接读业务表**：

- 客服读 `cs_feed.*` 视图，给专属角色授权视图级 SELECT。
- 看板、指标读 `analytics.*` 视图，同上。
- 内部表改结构时，在同一个 PR 改视图，保持视图输出列不变。输出列要变，就同时改外部仓库。

---

## 4. 跨域规则

- 跨域 FK 只允许指向根实体：
  - `app_core.users`、`app_core.characters`；
  - `experience.chat_sessions`、`experience.chat_history`；
  - `billing.wallet_ledger`：业务表记录"这笔钱是哪条流水"。

  其他跨域关系用**软引用**：同类型的 id 列，不建 FK，在列注释写明 `soft ref → schema.table`。

- 业务表与钱只通过 `*_charge_id`（软引用 `billing.usage_charges`）、`*_ledger_id` 关联。价格、折扣、免费次数、VIP 快照都放在 `billing` 的记录里，业务表不抄一份。
- `ops` 表对业务表全部用软引用，**没有任何表 FK 指向 `ops`**。这样 `ops` 数据可以按保留期随时删除。
- 产品请求路径不读 `ops`、`analytics`。后台任务可以读 `ops` 做聚合，写回本域的状态表（例：畅聊候选模型的上下架状态）。这类任务在 registry 的 `reads` 里登记。
- 跨域读写走拥有方的 repository 或 RPC。`analytics` 可以只读所有域。

---

## 5. 命名约定

- schema、表、列、函数一律 snake_case，不加引号，不用大写。
- 时间点用 `*_at timestamptz`，日期用 `*_date date`，时长用 `*_ms`，单位只能是毫秒。
- 星尘用 `*_credits numeric`，现金用 `*_cents integer`（人民币分），模型成本用 `*_usd numeric`。比例用 `*_rate numeric`，取值范围写进 CHECK。
- 布尔用 `is_*`、`has_*`、`*_enabled`。状态用 `status text` 加 CHECK，取值写进列注释。
- 引用用 `<实体>_id`，类型与被引用主键一致。
- 表名不含供应商或产品名（`openrouter`、`venice`、`surplus`、`grafana`、`telegram`），供应商写进 `provider` 列。
- 功能分组靠表名前缀：`lobby_*`、`free_zone_*`、`image_plaza_*`、`creator_*`、`community_*`。
- 约束、索引、触发器显式命名，便于诊断和回滚。

---

## 6. 反模式

| 反模式                          | 正确做法                                      |
| ------------------------------- | --------------------------------------------- |
| 测速、诊断列加进实体表          | 有业务读者就是业务列，否则进 `ops` 表或日志   |
| 价格、折扣、扣费列抄进业务表    | `billing.usage_charges`，业务表只存 charge_id |
| 租约、重试列加进实体表          | `*_jobs` 旁表                                 |
| 按供应商或场景分别建调用表      | 一张表，用 `provider` / `lane` 列区分         |
| 一次性 UI 标记加列              | `features.user_marks`                         |
| 同一个数存两份                  | 只留一处权威，其他地方读它或由触发器维护      |
| jsonb 藏业务字段                | 真列或旁表                                    |
| 只写不读的列和表                | 不建。发现没有读者的，删掉                    |
| 大文本、原始 prompt 写进热表    | `ops` 留档表加保留期，或不存                  |
| 函数包装链（`*_before_*`）      | 登记表 + 一个函数                             |
| 配置散装 key                    | `<feature>_config` 对象                       |
| 外部系统直读业务表              | `cs_feed` / `analytics` 视图                  |
| 会发奖的产品数据放进看数 schema | 放所属功能域                                  |
| 计费记录只留最近 N 条           | 计费记录永久保留，展示层自己取最近 N 条       |

---

## 7. 改已有结构的做法

### 7.1 执行路径

1. 一切改库只经 `packages/shared/migrations/` 的文件，经 **Database Migration workflow** 一次执行一个。顺序是本地 PG17 → TEST → 生产：
   - 本地用非超级用户，模拟生产权限；
   - 生产执行要明文确认。
2. **TEST 与生产不同构**：TEST 通过不代表生产会通过。生产现状用 Supabase MCP 只读核对，只看结构与聚合，不读业务行。
3. workflow 走 Supavisor 事务池，文件里**每条语句各自提交**：
   - 不要依赖会话状态（临时表、会话级 `SET`、`pg_temp`）；
   - 必须原子的写进一个 `DO` 块。
4. 迁移文件在任何环境执行过（包括执行失败）就**不再修改**：
   - 要改做法，另写新文件；
   - 生产上失败留下的认领，只能按原文件重跑。

### 7.2 扩展 → 发布 → 收缩

删列、删表、改名、改语义，都分三步，不在一次发布里先删后改：

1. **扩展**：建新结构、回填、新旧兼容（必要时用镜像触发器或双写过渡）。
2. **后端发布**：新代码只读写新结构。
3. **收缩**：删旧结构。收缩前列全旧结构的读者：
   - 代码 grep；
   - 函数 `prosrc`；
   - 视图依赖（`pg_depend`）；
   - pg_cron 命令文本；
   - 按角色查 `pg_stat_statements`。

   收缩迁移里加守卫，读者没清零就报错退出。

补充：

- **删一个仍在被写的对象**，分两段：先改写入函数并提交，等几秒让排队中的旧调用走完，再删。
- **镜像或回填 jsonb 时原样复制**，不要用 `jsonb_strip_nulls`：它会递归删掉值为 null 的键，读者用 `?` 判断键是否存在时结果会变。核对新旧值时直接比原值，不要先去掉 null 再比。
- **改不是自己维护的函数**，按三步做：
  1. 守卫生产原文的 md5；
  2. 按原文精确替换，每处恰好命中一次；
  3. 核对结果的 md5。

  不整段覆盖函数体，以免冲掉别人的改动。

### 7.3 大表与锁

- 回填分窗口、分批提交，不开长事务。窗口边界写固定时间，不要每个窗口各算一次 `now()`：每条语句各自提交，`now()` 各不相同，相邻窗口之间会漏一段。最后一窗写到 `'infinity'`。
- DDL 加 `lock_timeout`。
- 重的检查放在锁外，锁内只查增量。锁内的 DDL 合进一个 `DO` 块。
- 索引用 `CONCURRENTLY`。
- 不要 `LOCK` 视图：它会递归锁住视图引用的所有基表。要重建视图就直接 `DROP VIEW`。
- **替换热路径上的对象**（请求路径或触发器会读的视图、表；例如会话统计触发器读展示视图）：
  - 排他锁要排在已有的慢读者后面，排队期间后面的读者也全部被挡住；
  - 所以 `lock_timeout` 设 1 秒以内，短于后端的数据库超时（对话收尾是 5 秒）；
  - 拿不到锁就在 `DO` 块里捕获 `lock_not_available`，`pg_sleep` 后有限次重试，不要拉长等锁时间；
  - 持锁期间只做 DDL，核对放到锁前或提交后，尽量挑低峰执行。
  - 替换函数（`CREATE OR REPLACE FUNCTION`）不锁业务表，不受这条限制。
- 删列或大量删行后，用 workflow 的 `mode=repack`（pg_repack 在线重写，表需在白名单内）回收空间，不用 `VACUUM FULL`。

### 7.4 碰钱的改动

- 改前、改后各跑一次**按日对账**：`wallet_ledger` 流水与对应业务记录逐日比对笔数与金额。已结束的日子必须完全一致。
- 迁移里先做前置守卫，源数据不一致就什么都不建。末尾做自检，不一致整体报错。
- 碰钱、删除类迁移配一个本地可重复的测试脚本（`scripts/test-*.sh`：一次性 PG17 容器、非超级用户），覆盖重跑和守卫拒绝。

---

## 8. `registry.yaml` 维护规则

- 每个本仓库拥有的表、计划中的表都有一条记录。字段含义见文件头注释。
- `status` 取值：
  - `active`：可按 §3.1 加列；
  - `frozen`：不加列；
  - `moving`：有列或整表计划迁走，不加列，也不新增对这些列的依赖；
  - `planned`：目标表，尚未创建；
  - `drop`：待删除；
  - `external`：别的仓库拥有，不改。
- 改动触及 `moving` 的列或表时，先看迁移是否完成。没完成就在任务里说明，不在旧位置继续扩展。
- 迁移完成后，在同一个 PR 里把条目改成最终状态（`active`，删掉 `move` 记录）。registry 永远描述"现在是什么 + 要去哪里"。
- `note` 写现状与约束，不写过程。

## 9. CI 警告（不阻断合并）

`Quality Gate` 会对比 migration 和 `registry.yaml`，遇到下列情况在 PR 上给出警告：

- 建表或加列没有在 registry 登记；
- 给 `frozen` 或 `moving` 的表加列（registry 中某条 `move` 计划迁入该表的列除外）；
- 新表名含供应商名；
- 新表登记的性质与所在 schema 不符：M 不在 `billing`、O 不在 `ops`、J 表名不以 `_jobs` 结尾；
- 新建 schema 没有在 registry 的 `schemas` 登记；删表后 registry 仍登记为在用；
- `billing` 以外出现 `*_credits`、`*_cents`、`price_*`、`*_discount*` 新列（`*_charge_id`、`*_ledger_id` 引用列允许）；
- `*_jobs` 以外出现 `lease_*`、`next_attempt_at`、`next_retry_at`、`attempts`、`*_attempts`、`attempt_count`、`last_error` 新列；
- `ops` 以外出现 `*_ms` 新列（在 registry 标了 `billing_input: true` 的除外）；
- 新列名为 `metadata`、`extra`、`data`、`info`、`payload`；
- 函数名含 `_before_`。

警告不是"可以无视"。违反契约必须在 PR 描述里写一句理由，否则按违规返工。
