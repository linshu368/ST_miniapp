# 数据库契约

> **读者是 AI。** 任何会改变数据库形状或数据落位的改动，动手前必须读完本文件，并查 [`registry.yaml`](./registry.yaml) 里相关表的条目。包括：
>
> - 写 migration；新表、新列、新视图、新函数；
> - 往 jsonb 里加键、加 `runtime_config` key；
> - 让外部系统读库。
> - 本文件描述**目标结构**和落位规则。存量表迁到目标结构的进度只看 `registry.yaml`（`status` / `phase`）。
> - 数据库落位问题以本文件为准。`docs/ARCHITECTURE.md` 与 `.trellis/spec/database/` 里与本文件冲突的旧描述，一律视为过时。
> - 迁移执行、RLS、回滚纪律仍按 `.trellis/spec/database/supabase/migrations-and-rollbacks.md` 和 `security-rls-and-grants.md`。

---

## 0. 落位卡（最短版本，必须记住）

1. 每张表有且只有一组坐标：**业务域（schema）× 数据性质（E/S/M/J/O/C/D）**，登记在 `registry.yaml`。
2. 新字段先判性质（§1.2），再找同域、同性质、同写入模块的表。性质、写入模块、写入时机、生命周期有一项不同，就**不进这张表**，改建旁表或子表。
3. 钱（M）只进 `billing`。监控、测速、上游调用明细（O）只进 `ops`。租约、重试、退避（J）只进 `*_jobs` 表。
4. `registry.yaml` 里 `status` 为 `frozen` 或 `moving` 的表**不加列**。
5. jsonb 不是后门：要被过滤、计费、分支判断的值必须是真列。
6. 表名不带供应商名。一个功能的配置是一个对象型 key。不给函数套 `_before_*` 包装层。
7. 外部系统（客服仓库、Grafana、指标读者）只读视图层：`cs_feed`、`miniapp_analytics`。产品请求路径不读 `ops` 和 `miniapp_analytics`。
8. 建表、删表、搬表，同一个 PR 里更新 `registry.yaml`。列只在 registry 有列清单时同步：`moving` 表的 `keep`/`move`，或 jsonb 的 `keys`。

---

## 1. 两个坐标

### 1.1 业务域（schema）：归谁管

| schema              | 管什么                                                                                                         | 不管什么（常见误放）                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `app_core`          | 用户身份与资料、用户偏好、角色卡（内容、版本、上架、创作草稿）、全局运行配置与后处理版本                       | 告警、计数缓存、功能一次性标记                              |
| `experience`        | 对话：会话、轮次内容、交付状态、上游调用身份、语音和角色附图产物、长期记忆、对话内用户操作（编辑、点赞、反馈） | 价格与扣费、测速、上游用量和成本                            |
| `media_plaza`       | 图片广场完整链路：会话、消息、生成尝试、产物、作品、点赞                                                       | 价格与扣费                                                  |
| `billing`           | 订单、流水、余额、扣费记录与价格快照、免费额度、VIP 权益、返利与奖励账                                         | 支付监控事件、结账测速                                      |
| `miniapp_features`  | 随某个产品功能上下线的状态：社交（收藏、点赞、评论、心愿）、大厅推荐、签到、通知、社群、畅聊候选、用户标记     | 跨功能根数据、调用明细                                      |
| `miniapp_traffic`   | 渠道链接、点击、入口事实、邀请关系、用户归因                                                                   | 用户身份本身                                                |
| `admin`             | 运营平台自身：运营账号、草稿、发布记录、运营审计                                                               | 发布后的运行真相（在 `app_core`）                           |
| `ops`               | 工程观测：上游调用明细（耗时、token、成本、原始返回）、测速、支付与运维事件、告警、播放观测                    | 任何会改变用户结果或扣费的数据                              |
| `miniapp_analytics` | 只为看数存在的视图、物化视图、离线快照、日汇总；Grafana 与指标读者的唯一入口                                   | 产品运行会读的结果（例如大厅排序分属于 `miniapp_features`） |
| `cs_feed`           | 本仓库维护、给客服仓库读的只读视图                                                                             | 任何表                                                      |

外部或待删的 schema（本仓库不新增对象）：

- `cs`：客服仓库 ST_cs_platform 拥有。
- `drama_archive`：短剧上传端拥有，本仓库只拥有 `drama_likes`、`drama_comments` 两张表。
- `public`：只放 Supabase 平台对象，不放业务对象。（旧客服 `cs_platform` 与空壳 `miniapp` 已于 2026-11-17 删除。）

**新建 schema 的门槛**：只有当一类数据有独立的读者权限或生命周期，并且放进现有域会混淆落位时，才新建。新建要在 `registry.yaml.schemas` 登记、补授权，并更新本表。功能分组靠**表名前缀**（`lobby_*`、`free_zone_*`、`image_plaza_*`），不靠 schema。

### 1.2 数据性质：是哪类数据

按顺序判定，命中第一个就停：

| 序  | 代号  | 性质 | 判定问题                                                 | 表名形态                                                            | 只能放在                                           |
| --- | ----- | ---- | -------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | **M** | 钱   | 这个值写错了，会多扣、少扣星尘、现金或权益吗？           | `*_orders` `*_ledger` `*_charges` `*_grants` `*_rewards` `*_quotas` | `billing`                                          |
| 2   | **O** | 观测 | 删掉它，用户看到的结果和扣的钱都完全不变吗？             | `*_calls` `*_timings` `*_events` `*_observations`                   | `ops`                                              |
| 3   | **J** | 任务 | 它有租约、重试次数、下次重试时间、last_error 吗？        | `*_jobs`                                                            | 任务所属业务域（`ops` 内部任务放 `ops`）           |
| 4   | **D** | 派生 | 它能从别的表重新算出来吗？                               | `*_stats` `*_scores` `*_daily` `*_snapshot(s)`、视图                | 产品会读的放所属域；只看数的放 `miniapp_analytics` |
| 5   | **C** | 配置 | 是运营或工程发布、带版本的规则吗？                       | `runtime_config` key、`*_versions`、`admin.*_drafts/_releases`      | `app_core`（运行真相）/ `admin`（发布过程）        |
| 6   | **S** | 状态 | 只关心最新值、可以随时覆盖吗？（偏好、关系、标记、进度） | `*_preferences` `*_states` `*_marks`、`a_b` 关系表                  | 所属域                                             |
| 7   | **E** | 实体 | 用户能看到、别处会引用的业务对象                         | 名词复数                                                            | 所属域                                             |

判定细则：

- 测速、耗时类数据要先过第 1、2 题。只要被计费或交付判定读取（例如 `client_first_token_visible_ms` 被 `billing.chat_delivery_billing_gate` 读），它就不是 O，属于所在表的 S/E。判定以"有没有业务代码或函数读它做决定"为准，不看名字像不像测速。
- 实体表可以带**自身**的生命周期列：`status`、状态迁移时间（`completed_at`、`deleted_at`）、主人可改的展示属性（标题、置顶、文件夹），以及在 registry 里登记为 D 的、由触发器维护的计数缓存。除此之外的其他性质都不行。
- 一张表只登记一个性质。确实混合的存量表，在 registry 里按列组登记目标去向。

---

## 2. 落位决策

### 2.1 新字段（最常见，最容易乱）

1. 按 §1.2 判定字段性质。
2. 在 `registry.yaml` 找候选表：同域、同性质、`owner` 是同一个模块。
3. 逐条检查，**全部满足**才能加列：
   - **同性质**：E/S 表不收 M、O、J 字段。
   - **同写入模块**：由拥有这张表的模块写。
   - **同写入时机**：如果这张表的行在创建时一次写完，就不收"事后回填、客户端补报、对账结果、异步任务进度"这类列（实体自身的状态迁移除外）。
   - **同生命周期**：随同一个功能上线和删除，保留期相同。
4. 有任一条不满足：
   - 与原表是一对一 → 建**旁表**，主键就用原表主键。例：`experience.chat_prompt_snapshots(history_id PK)`。
   - 与原表是一对多 → 建**子表**。
   - 性质要求换域（M → `billing`，O → `ops`）→ 在目标域建表，用软引用关联回来（§3）。
5. 候选表 `status` 是 `frozen` 或 `moving` → 不加列，走第 4 步。
6. 一次性 UI 标记（看过、做过、剩几次、首次完成）一律写 `miniapp_features.user_marks`，用 `mark_key` 区分，**不加列**。

### 2.2 新表

在任务的 `design.md` 里先写清下面几项，再写 migration：

1. `schema.table`、一句话业务含义、性质代号；
2. 权威写入模块（registry 的 `owner`）、读者；
3. 生命周期与保留期。`ops` 表必须写保留天数和清理方式；
4. 跨域引用（§3）；
5. 有没有已有表维护同一个事实。有就扩展它或建旁表，不复制第二份事实。

表名后缀必须与性质一致（§1.2），`registry.yaml` 同 PR 登记。

### 2.3 jsonb 列和新 jsonb 键

jsonb 只允许三种用途，列名必须体现用途：

| 用途                                 | 列名         | 例                                            |
| ------------------------------------ | ------------ | --------------------------------------------- |
| 不可变快照（写一次，按当时状态保存） | `*_snapshot` | 价格快照、角色卡版本内容、发给模型的 messages |
| 供应商或外部系统原始返回             | `raw_*`      | `raw_usage`、`raw_response`                   |
| 观测诊断明细（只在 O 表）            | `*_detail`   | 慢请求诊断                                    |

- 新列禁止叫 `metadata`、`extra`、`data`、`info`、`payload`、`state` 这类不说明用途的名字。存量的 `metadata` 列冻结，不加新键。
- 业务代码要拿来过滤、排序、聚合、计费、分支判断的值，必须是真列。
- 每个 jsonb 列在 `packages/shared` 里要有 zod schema，键名登记在 registry 该列的 `keys`。加键就是改契约，要同步更新。
- 反例：`drive_mode`（生成输入）塞进 `chat_history.rich_reply_metadata`（展示用元数据），只是为了不改热表。正确做法是放进生成输入的同类列，或者旁表。

### 2.4 新 `runtime_config` key

- 一个功能一个对象型 key，命名 `<feature>_config`，参照 `free_zone_config`。功能的新参数加进这个对象，不另开散装 key。
- 某个功能已经有散装 key（`voice_*`、`image_*`、`miniapp_official_community_*`），要给它加参数时，先把散装 key 合并成 `<feature>_config` 再加。
- 功能下线，key 在同一个 PR 删除，admin-client 注册表和 CLI coverage 同步改。
- 只有 `platform/runtime-config.ts` 能读 `runtime_config`（既有铁律）。

### 2.5 数据库函数、视图、触发器

- 函数跟随它维护的不变量所在的域。视图跟随用途：看数的放 `miniapp_analytics`，给客服的放 `cs_feed`。
- **禁止包装链**：不许把旧函数改名成 `*_before_<feature>`、新函数里 `OR` 调旧函数。白名单、校验这类"每加一项就要改"的逻辑，用登记表加一个函数实现。
- 改函数签名或行为，用 `CREATE OR REPLACE` 原地替换；旧版本不保留。
- 触发器只用于数据库必须保证的跨写一致性（例如计数缓存），并在 registry 对应列标明 `maintained_by`。

### 2.6 新的外部读者

外部系统（客服仓库、Grafana、指标脚本）**不直接读业务表**：

- 客服读 `cs_feed.*` 视图，给专属角色授权视图级 SELECT。
- 看板、指标读 `miniapp_analytics.*` 视图，同上。
- 内部表改结构时，同一个 PR 改视图，保持视图输出列不变；要变就同时改外部仓库。

---

## 3. 跨域规则

- 跨域 FK 只允许指向根实体：`app_core.users`、`app_core.characters`、`experience.chat_sessions`、`experience.chat_history`，以及 `billing.wallet_ledger`（由业务表记录"这笔钱是哪条流水"）。其他跨域关系用**软引用**（同类型的 id 列，不建 FK）。
- 业务表与钱只通过 `*_charge_id`、`*_ledger_id` 关联。价格、折扣、免费次数、VIP 快照都放在 `billing` 的记录里，业务表不抄一份。
- `ops` 表对业务表全部用软引用，**没有任何表 FK 指向 `ops`**。这样 `ops` 数据可以按保留期随时删除。
- 产品请求路径不读 `ops`、`miniapp_analytics`。后台任务可以读 `ops` 做聚合，写回本域的状态表（例：畅聊候选模型的上下架状态）。这类任务在 registry 的 `reads` 里登记。
- 跨域读写走拥有方的 repository 或 RPC。`miniapp_analytics` 可以只读所有域。

---

## 4. 命名约定（新增对象必须遵守，存量不追改）

- schema、表、列、函数一律 snake_case，不加引号，不用大写。
- 时间点：`*_at timestamptz`。日期：`*_date date`。时长：`*_ms`，单位只能是毫秒。
- 星尘：`*_credits numeric`。现金：`*_cents integer`（人民币分）。比例：`*_rate numeric`，取值范围写进 CHECK。
- 布尔：`is_*`、`has_*`、`*_enabled`。状态：`status text` 加 CHECK，取值写进列注释。
- 引用：`<实体>_id`，类型与被引用主键一致。软引用在列注释写明 `soft ref → schema.table`。
- 表名不含供应商或产品名（`openrouter`、`venice`、`surplus`、`grafana`、`telegram`）。供应商写进 `provider` 列。
- 功能分组靠表名前缀：`lobby_*`、`free_zone_*`、`image_plaza_*`、`creator_*`、`community_*`。

---

## 5. 禁止清单（都是本仓库真实出现过的）

| 反模式                       | 存量例子                                                        | 正确做法                                              |
| ---------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| 测速、诊断列加进实体表       | `chat_history.upstream_status`、`chat_generation_attempts.*_ms` | 放 `ops.llm_calls`、`ops.chat_generation_timings`     |
| 价格、折扣、扣费列抄进业务表 | `chat_message_audio` / `chat_message_images` 各 12 列计费字段   | 放 `billing.usage_charges`，业务表只存 `charge_id`    |
| 租约、重试列加进实体表       | `chat_message_images.lease_*`、`payment_orders.reconcile_*`     | 放 `*_jobs` 旁表，参照 `experience.story_memory_jobs` |
| 按供应商分别建表             | `openrouter_` / `venice_` / `surplusintelligence_chat_history`  | 一张 `ops.llm_calls`，供应商写在 `provider` 列        |
| 一次性 UI 标记加列           | `vip_entry_seen_at`、`*_full_rules_remaining`                   | `miniapp_features.user_marks`                         |
| 同一个数存两份               | `users.total_round` 和 `miniapp_user_settings.total_round`      | 一处权威（D 表），另一处删除                          |
| jsonb 藏业务字段             | `rich_reply_metadata.drive_mode`                                | 真列或旁表                                            |
| 函数包装链                   | `admin.is_managed_config_key_before_*` 共 24 个                 | 登记表加一个函数                                      |
| 配置散装 key                 | `voice_*` 8 个、`image_*` 15 个                                 | `<feature>_config` 对象                               |
| 外部系统直读业务表           | 客服角色对几乎全库有 SELECT                                     | `cs_feed` 视图加视图级授权                            |
| 看数表混进产品数据           | `miniapp_analytics.drama_survey_responses`（会发奖）            | 放所属功能域                                          |

---

## 6. `registry.yaml` 维护规则

- 每个本仓库拥有的表、计划中的表都有一条记录。字段含义见文件头注释。
- `status` 取值：
  - `active`：可按 §2.1 加列；
  - `frozen`：不加列；
  - `moving`：有列或整表计划迁走，不加列，也不新增对这些列的依赖；
  - `planned`：目标表，尚未创建；
  - `drop`：待删除；
  - `external`：别的仓库拥有，不改。
- 改动触及 `moving` 的列或表时，先看该迁移阶段（`phase`）有没有完成。没完成就在任务里说明，必要时先做那一阶段，不在旧位置继续扩展。
- 阶段完成后，在同一个 PR 里把条目改成最终状态（`active`，并删掉 `move` 记录）。registry 永远描述"现在是什么 + 要去哪里"。

## 7. CI 警告（不阻断合并）

`Quality Gate` 会对比 migration 和 `registry.yaml`，遇到下列情况在 PR 上给出警告：

- 建表或加列没有在 registry 登记；
- 给 `frozen` 或 `moving` 的表加列（registry 中某条 `move` 计划迁入该表的列除外）；
- 新表名含供应商名；新表登记的性质与所在 schema 不符（M 不在 `billing`、O 不在 `ops`、J 表名不以 `_jobs` 结尾）；
- 新建 schema 没有在 registry 的 `schemas` 登记；删表后 registry 仍登记为在用；
- `billing` 以外出现 `*_credits`、`*_cents`、`price_*`、`*_discount*` 新列（`*_charge_id`、`*_ledger_id` 引用列允许）；
- `*_jobs` 以外出现 `lease_*`、`next_attempt_at`、`next_retry_at`、`attempts`、`*_attempts`、`attempt_count`、`last_error` 新列；
- `ops` 以外出现 `*_ms` 新列（在 registry 标了 `billing_input: true` 的除外）；
- 新列名为 `metadata`、`extra`、`data`、`info`、`payload`；
- 函数名含 `_before_`。

警告不是"可以无视"。违反契约必须在 PR 描述里写一句理由，否则按违规返工。
