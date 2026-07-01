# Schema划分设计

## 一、背景

ST_miniapp 项目要把 SillyTavern（ST）作为黑盒后端引擎接入团队已有的 Telegram MiniApp 角色扮演产品。ST 是一个 Node\.js 服务，所有用户配置、角色卡、聊天记录都硬编码读写本地文件系统 `data/\&lt;username\&gt;/`，且在阶段一约束下不修改 ST 任何核心逻辑。

这就形成了一个核心矛盾：**ST 的运行依赖单机文件系统，而商业化产品要求多用户、跨设备、可分析、可管控**。Supabase 必须承担\&\#34;业务真相中枢\&\#34;的角色，但又不能让 ST 直接读写它（否则就要改 ST 源码）。

阶段一的解法是在 ST 之外建一层\&\#34;双向同步引擎\&\#34;，把 Supabase 和 ST 文件系统打通。本 Schema 是这层同步引擎运转的根基。

---

## 二、目的

为阶段一的双向同步框架提供一套**结构稳定、语义自洽、可支撑 6\-12 个月迭代不重构**的 Supabase 表结构，具体要：

1. 清晰区分\&\#34;平台管控数据\&\#34;和\&\#34;用户运行时数据\&\#34;两种真相源归属

2. 用统一的设计模式覆盖配置型数据（settings）和资产型数据（角色卡、预设）

3. 为未来开放更多用户可改字段、新增资产类型预留扩展路径，不需要改表结构

4. 让运维、客服、合规场景下的数据排查具备语义自洽性，不依赖外部规则解释

---

## 三、设计原则

**原则 1：真相源决定表归属**
任何一份数据都先回答\&\#34;发生冲突时谁胜出\&\#34;，再决定放哪张表。Supabase 胜 → A 类（platform\_\_），ST 文件系统胜（runtime） → B 类（user\_\_）。

**原则 2：append\-only，永不原地更新**
A 类和 B 类的所有写入都是新增一行（带版本号 \+ 时间戳 \+ 内容 hash）。原地 update 会丢失审计能力、回滚能力、灰度对照能力，代价远大于存储成本。

**原则 3：jsonb 整块存，不拆字段成列**
ST 的 settings\.json 有几百个键，且会随 ST 版本演进。把它拆列等于把维护税转嫁给我们；用 jsonb 整块存等于把这部分耦合留在 ST 自己。

**原则 4：配置层 / 存储层 分离，统一使用指针模型**
ST 的设计哲学是\&\#34;配置层（settings\.json 字段）通过 name 指向存储层（独立资产文件）\&\#34;。我们的表结构完全顺应这个模型：每一类资产一张独立表，settings 里只存指针字符串。

**原则 5：白名单是写入时的强约束，不是读取时的过滤器**
B 类只存白名单允许的字段子集。这让 B 表里出现的每一个字段都自带\&\#34;用户被授权修改过\&\#34;的业务事实，不需要联查白名单版本来反推。

**原则 6：稳定 ID \+ transform，化解跨设备指针漂移**
所有资产文件用 `platform\_\&lt;uuid\&gt;` 命名（未来 `user\_\&lt;uuid\&gt;`），让 settings 里的指针字符串在任何设备上语义一致；白名单条目带 transform 类型，对指针类字段做校验和兜底。

**原则 7：阶段一只架字段，不实现复杂语义**
audience（多分组）、price_tier、灰度等字段可以预留，但阶段一不消费它们。这样未来开放时是改配置而不是改表。

## 四、核心思路：

继承ST原生的指针模式，物理形态上分为pool内容表和selection指针表。
pool内容表在一阶段仅收录核心配置（其他表暂时占位），但必须保证 Schema 结构是合理的。

### 第一维度：权威源

这是最硬的维度，直接对应 Supabase 与文件系统的真相源关系。[Supabase 与文件系统的定位分析](https://xcn0recwi9sg.feishu.cn/wiki/QLaUwlidBicme3ksOSpc9S3TnRe)

| 类别                     | 通俗解释                                                                                                                                        | 例子                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **A 类：平台管控**<br>   | 平台是绝对真相。Supabase 改了什么，ST 那边必须照办；ST 那边即使被人改了，下次同步会被覆盖                                                       | 默认角色卡库、默认预设、API Key、模型白名单 |
| **B 类：用户运行时**<br> | 用户的实际操作发生在 ST。ST 是当下的真相；但用户关掉浏览器后 ST 临时数据会清掉，所以 Supabase 充当\&\#34;备份\&\#34;角色，下次登录时再投影回 ST | 用户当前选的角色、聊天记录、个人偏好        |

它回答了“当冲突发生时，这些数据谁说了算”，是 RLS、同步方向、provisioning 策略的依据。

### 第二维度：数据形态（配置型 / 资产型）

| 形态     | 配置型                 | 资产型                   |
| -------- | ---------------------- | ------------------------ |
| 例子     | settings\.json         | 角色卡、预设             |
| ST 落点  | 单个 JSON 大文件       | 一个目录下的多个独立文件 |
| 表结构   | 一行一个全量版本快照   | 一行一个资产             |
| 写入语义 | 覆盖式（运营发布新版） | 增量式（运营上下架资产） |

两维方案的好处：

- **正交**：每个字段都能落在唯一格子里，不重叠不漏

- **可解释**：维度一对应业务问题（谁负责），维度二对应工程问题（怎么存）

- **可演化**：新增配置时，决策路径固定——**先问归属、再问形态**，落到哪张表基本不需要讨论

## 五、表清单与边界

> **Schema 归属（D014 后）**：A 类表统一进 `st_platform` schema，B 类表进 `st_users` schema，同步引擎运维基建表（`sync_tasks` 等）进 `st_infra`。`miniapp.characters`（D003 复用）保留在 `miniapp` schema。下表表名省略 schema 前缀，归属按所属类别推断（A 类 → `st_platform.<表名>`，B 类 → `st_users.<表名>`）。

### A 类（4 张，schema=`st_platform`，含 `miniapp.characters` 跨 schema 复用）

| 表                   | 形态   | 阶段一状态        | 边界说明                                                                                                                        |
| -------------------- | ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| platform_settings    | 配置型 | 实建并使用        | 对应 ST 的 settings\.json 全集 \+ 白名单。一行一个全局版本快照。只此一表承担全局配置职责，资产相关字段以指针形式存在 jsonb 中。 |
| platform_characters  | 资产型 | 实建并使用        | 平台下发的角色卡池，一张卡一行。包含卡内容（PNG \+ 嵌入元数据）、稳定文件名、是否上下架。世界书、正则跟随角色卡走，不单独建表。 |
| platform_presets     | 资产型 | 实建，初期写 1 行 | 平台下发的 API 预设池（prompt 模板 \+ 模型参数）。阶段一只放 1 行默认预设，所有用户统一使用。未来开放会员等级时扩成多行。       |
| platform_api_configs | 资产型 | 占位实建          | 阶段一所有用户统一用平台 key 和 model，建表但不消费。未来开放 API 等级选择时启用。                                              |

### B 类（2 张，schema=`st_users`）

| 表名                 | 形态   | 阶段一状态 | 边界说明                                                                                                                                                                    |
| -------------------- | ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user_st_settings<br> | 配置型 | 实建并使用 | 用户在 ST 中实际改动的、且属于当前生效白名单内的字段子集。一用户多行（每次有效改动 \+ 一行）。结构与 platform_settings 同构。**B 类不存 settings 全集，不存非白名单字段**。 |
| user_st_chats        | 资产型 | 占位实践   | <br>ST原生记录的用户直接对话产生的聊天记录<br>                                                                                                                              |

---

## 六、核心决策详细说明

### 决策 1：B 类只存白名单子集（方案乙）

**问题**：用户在 ST 上保存 settings 时，ST 会把整个 settings\.json 覆盖写盘。如果 watch 触发后整块入库 B 表，会把用户从未授权的字段也镜像进来。

**决策**：反向同步在写入 B 表前，按当前生效白名单 `lodash\.pick\(settings, whitelist\)` 过滤，B 表 jsonb 只包含白名单内的键。

**理由**：让 B 表本身具备语义自洽性——B 表里有什么键，就是\&\#34;用户在该版本白名单下被授权改过\&\#34;的事实，不需要联查白名单版本来反推。这一性质在 ST 升级、字段提升/收回、客服排查、合规导出等场景下持续受益。

**代价**：反向同步多一行 `lodash\.pick`。一次性成本，无后续维护负担。

### 决策 2：白名单用 dot\-path，归 A 表字段一起冻结

**问题**：settings\.json 是深度嵌套的（如 `power\_user\.theme`、`prompts\[2\]\.enabled`）；白名单本身的变更也是有版本节奏的。

**决策**：

- 白名单条目用 dot\-path 表达，匹配 lodash 的 get/set 语义

- 白名单作为 `platform\_settings\.writable\_paths` 字段存在，跟 jsonb 配置和 platform_version 一起 append\-only

**理由**：白名单的变更和默认值的变更高度相关（开放一个字段往往伴随它的默认值调整），强行解耦反而难管。绑在一起冻结 = 一行就是一个自洽的快照状态，运营回滚时一键回退到完整自洽态。

### 决策 3：白名单条目带 transform 类型

**问题**：settings 里有大量\&\#34;指针字段\&\#34;（如 `active\_character` 是文件名字符串），跨会话/跨设备直接镜像可能指向不存在的资产。

**决策**：白名单从字符串数组升级为对象数组，每条带 transform：

```YAML
writable_paths:
  - path: active_character
    transform: character_ref
  - path: power_user.theme
    transform: passthrough
```

阶段一实现 `passthrough` 和 `character\_ref` 两种，其他作为 schema 字段预留（preset_ref / world_ref / model_tier_ref 等）。

**理由**：把\&\#34;指针校验和兜底\&\#34;这件事下沉到统一的 transform 层，未来开放新指针类型时只加一种 transform，不动同步引擎主流程。

### 决策 4：资产文件采用 `platform\_\&lt;uuid\&gt;` 稳定命名

**问题**：默认情况下 ST 角色卡按显示名落盘（如 `Aria\.png`），换设备 / 重新初始化时如果同名卡内容不同，settings 里的指针就会指向错误内容。

**决策**：所有平台下发的资产文件，落盘文件名一律为 `platform\_\&lt;asset\_uuid\&gt;\.png/json`（uuid 来自 platform_characters / platform_presets 表的主键）。未来用户导入卡用 `user\_\&lt;uuid\&gt;` 前缀。

**理由**：让 settings 里的指针字符串在任何设备上语义一致——只要对应资产被项目下发过，引用就有效；不会下发的资产，在投影阶段就能识别失效并兜底。

### 决策 5：A 类的资产/配置下发顺序

**问题**：投影下发时如果先下发 settings\.json，里面的 `active\_character` 指向一个还没下发的角色卡文件，ST 启动会报错或回退。

**决策**：初始化和重新投影时，**先下发资产层**（platform_characters → characters/、platform_presets → OpenAI Settings/），**再下发配置层**（merge\(A_settings, B_settings\) → settings\.json）。

**理由**：保证配置层下发时所有指针都能解析到本地已存在的资产文件。

### 决策 6：B 表的去重和防抖

**问题**：ST 前端任何小动作都可能触发 settings\.json 保存，文件 watch 会被触发几十上百次。

**决策**：

- 防抖：watch 事件触发后等 2\-5 秒静默才入库，合并这段时间的多次保存

- content_hash：算 jsonb 的 canonical 序列化（key 排序）后的 hash，与该用户 B 表最新一行 hash 相同则跳过 insert

**理由**：阶段一不上这两个机制，B 表会以非常快的速度膨胀；上了之后存储成本可控，且一年内不需要担心 GC。

### 决策 7：A→B 字段提升的懒初始化

**问题**：当某个字段从 A 白名单外迁入白名单内（即\&\#34;开放给用户改\&\#34;），已存在的用户的 B 表此前没有该字段记录。提升瞬间是否要给所有用户在 B 表写一行默认值？

**决策**：不写。用户在该字段上的 B 记录只在 ta 真正改动时才落地。投影时如果 B 没有，自动取 A 的当前默认值。

**理由**：保持 B 表语义纯净——B 里出现的每一行每一个键，都是\&\#34;用户实际改过\&\#34;的事实。不为提升事件批量写入\&\#34;用户从未操作过\&\#34;的伪记录。

### 决策 8：引用失效时的兜底

**问题**：投影时如果用户 B 表里 `active\_character` 指向一个已下架或已删除的卡 uuid，ST 会启动失败。

**决策**：投影逻辑检测引用失效时，**回退到平台默认卡**（platform_characters 中 is_default = true 的那张），并在该次投影的 metadata 中标记 `had\_invalid\_ref = true`。

**理由**：用户体验优先（不让 ST 启动失败），同时保留可观测性（运营可查询哪些用户遇到过失效）。

### 决策 9：RLS 策略

**问题**：Supabase 默认所有访问都受 RLS 约束，但同步引擎需要无差别读写所有用户数据。

**决策**：所有 platform\_\* 和 user\_\* 表启用 RLS，但**仅 service_role 持有的 server\-side 同步引擎绕过 RLS**。MiniApp 客户端永远不直接读写这些表，所有访问通过 Bridge → 同步引擎中转。

**理由**：让\&\#34;业务真相数据\&\#34;和\&\#34;客户端可达数据\&\#34;在物理层就隔离开，同步引擎是唯一入口，便于审计和限流。

---

## 七、表结构概览

```SQL


platform_settings（A 类配置型，append-only）
├── id                     uuid pk
├── platform_version       int unique   -- 运营节奏的全局版本号，单调递增
├── settings_jsonb         jsonb        -- 完整 ST settings 快照
├── writable_paths         jsonb        -- 白名单 [{path, transform}, ...]
├── content_hash           text         -- canonical hash，去重用
├── created_at             timestamptz
├── created_by             text         -- 运营人标识
└── note                   text         -- 版本说明




platform_presets（A 类资产型，阶段一 1 行）
├── id                     uuid pk      -- 落盘为 platform_<id>.json
├── display_name           text
├── preset_payload         jsonb        -- 完整预设内容
├── is_default             boolean      -- 阶段一这一行 = true
├── created_at             timestamptz
└── updated_at             timestamptz


platform_api_configs（A 类资产型，阶段一占位）
├── id                     uuid pk
├── display_name           text
├── config_payload         jsonb        -- endpoint / model / key 引用等
├── is_default             boolean
├── created_at             timestamptz
└── updated_at             timestamptz


user_settings（B 类配置型，append-only，结构同构于 platform_settings）
├── id                     uuid pk
├── user_id                fk → users.id
├── user_revision          int          -- 用户内自增版本号
├── settings_jsonb         jsonb        -- 仅白名单子集
├── based_on_platform_version  int      -- 该次镜像基于哪个 A 版本
├── whitelist_version      int          -- 该次镜像生效的白名单版本（= platform_version）
├── content_hash           text
├── had_invalid_ref        boolean      -- 该次投影是否发生过引用失效
├── source                 text         -- 'st_watch' / 'init' / 'manual' 等
├── audience               text default 'default'  -- 预留多分组
└── created_at             timestamptz
unique (user_id, user_revision)
unique (user_id, content_hash) 用于幂等去重
```

## 八、未来扩展路径预演

为了证明这套 Schema 能扛 6\-12 个月，列举几种典型迭代如何落地（**全部不需要改表结构**）：

### 8.1 开放新的用户可改字段（如 `power_user.theme`）

1. 运营发布新版 `platform_settings`：`platform_version = N+1`，在 `writable_paths` 数组里加入 `{path: "power_user.theme", transform: "passthrough"}`
2. **不需要批量回填用户的 B 表**（决策 7 懒初始化）：用户下次实际改主题时，反向同步会写入一行 `user_st_settings`
3. 投影时 merge 顺序仍是：A 默认值 + B 用户改动，未改主题的用户自动取 A 的当前默认

### 8.2 新增一类 A 类资产（如运营要上线"会员等级"功能）

1. 新建 `st_platform.platform_member_tiers` 表（资源型-平台池，与 `platform_presets` 同构）
2. 新版 `platform_settings.writable_paths` 加 `{path: "active_tier", transform: "tier_ref"}` 并实现 `tier_ref` transform
3. 同步引擎主流程不变，只新增一个 transform 实现

### 8.3 开放用户私有资源（如阶段二接入用户上传角色卡）

1. 新建 `st_users.user_characters` 表（资源型-用户池，B 类）
2. 反向同步引擎扫描 `data/<handle>/characters/user_*.png`，提取元数据写入 `user_characters`
3. `user_st_settings.settings_jsonb.active_character` 可以指向 `user_<uuid>.png`，transform `character_ref` 同时校验 `miniapp.characters` 和 `user_characters`

---

## 九、本轮（D011）确认结论

本节记录 2026-05-30 这一轮 schema 重做时确定下来、未在前八章直接覆盖的几条结论。详细论证见 `DECISIONS.md` D011 / D012 / D013。

### 9.1 阶段一白名单初始字段集

阶段一 `platform_settings.writable_paths` 只包含**两条最小集**：

```yaml
writable_paths:
  - path: active_character
    transform: character_ref
  - path: oai_settings.prompts
    transform: passthrough
```

**为什么只开放这两条**：

| 路径                   | 开放理由                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `active_character`     | 反向同步底线场景：用户在 ST 原生 UI 切换 / 导入角色卡是阶段一手工压测的核心路径（执行计划 5.4 节验收标准），必须开放 |
| `oai_settings.prompts` | 阶段一的"白名单生效性"验证字段，整组开放（不细到 `prompts[N].enabled`），减少 transform 复杂度                       |

**为什么不开放 `prompts[N].enabled` 单字段粒度**（J1 决策）：

- lodash 的 dot-path 不原生支持数组下标展开，需要在 transform 层为这种粒度专门实现 `array_path` transform
- 阶段一目标是"框架可运行"而非"白名单粒度精细"
- 未来开放精细化时，把 `oai_settings.prompts` 改成具体的 N 条 dot-path 即可，不动同步引擎

**所有其他字段**（如 `power_user.theme` / `oai_settings.temp_openai` / 模型选择等）阶段一**不开放**，用户在 ST UI 上的改动会被反向同步过滤掉。

### 9.2 角色卡 PNG 存储策略

**阶段一**：PNG 放在 ST 服务器本地文件系统，命名 `platform_<id>.png`（决策 4 稳定命名）。Supabase 端 `miniapp.characters` 只存 chara_card_v3 的 JSON 元数据，**不存 PNG 二进制本体**。

**阶段二（未来）**：迁移到 Supabase Storage（bucket `st-platform-assets`，路径 `characters/<id>.png`），通过新增 `storage_path` 列承载迁移路径。`platform_<id>` 稳定命名是两个阶段共同的基础，settings.json 中的指针不需要重写。

详细论证见 `DECISIONS.md` D013。

### 9.3 已废弃的形态

`Schema划分设计.md` 五、六章保持原样（含"凭证型"等四形态描述），但 D011 后阶段一**实际只用两种形态**：

- **配置型**：`platform_settings` / `user_st_settings`（append-only）
- **资源型**：`platform_presets` / `platform_api_configs` / `miniapp.characters` / `user_st_chats`

凭证型（API Key）通过 D008 的"应用层硬约束 + RLS minimal"保护，物理上并入资源型表的 `config_payload` jsonb；选择型 / 偏好型用配置型 append-only 替代。形态收敛减少了表数量，简化了同步引擎配置清单。

### 9.4 settings_jsonb 种子数据来源

阶段一 `platform_settings.settings_jsonb`（platform_version = 1）来自 `SillyTavern-latest/data/default-user/settings.json`，由生成器做三处指针清洗：

| 字段                                  | 清洗后值                           | 理由                                                          |
| ------------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `active_character`                    | `platform_<第一张种子卡 uuid>.png` | 决策 4 稳定命名，避免依赖文件系统中的 `第七开发部.png` 字面量 |
| `oai_settings.preset_settings_openai` | `platform_<预设 uuid>`             | 同上，预设引用名不带扩展名                                    |
| `main_api`                            | `"openai"`                         | 强制锁定，阶段一所有用户走平台 API                            |

清洗逻辑在 `packages/shared/scripts/generate-seed-sql.ts` 中实现，使用 canonical JSON 序列化（key 排序）后 sha256 计算 `content_hash`，由 UNIQUE 索引保证幂等。
