# ST_miniapp 阶段一 D1-D2 收尾汇报：从 ST 配置到 Supabase 表的"逐表走查"

> **⚠️ 历史性文档说明（D014 后追加）**：本文档反映 2026-05-28 D1-D2 收尾时的 schema 状态，所有 ST 同步层表都在统一的 `st` schema 下。2026-06-03 的 D014 决策将其拆分为 `st_platform` / `st_users` / `st_infra` 三个 schema。本文档正文保留原貌作为历史记录，**最新表清单与 schema 归属请查阅** [`packages/shared/migrations/README.md`](../packages/shared/migrations/README.md) 与 [`DECISIONS.md`](../DECISIONS.md) D014。文中出现的 `st.platform_*` / `st.user_st_*` / `st.platform_worldbooks` 等表名按 D014 映射如下：
>
> - `st.platform_*` → `st_platform.platform_*`
> - `st.user_st_*` → `st_users.user_st_*`
> - `st.platform_worldbooks` → 已废弃（D011：世界书跟随角色卡走，不单独建表）
> - `st.user_st_state` → 已废弃（D011：由 `st_users.user_st_settings` append-only 替代）
> - `st.platform_api_credentials` → 已废弃（D011 重命名为 `st_platform.platform_api_configs`）

**日期**：2026-05-28
**阶段**：阶段一 / 里程碑 A（D1-D2）已收尾
**面向**：项目负责人 / 技术合伙人
**与已有汇报的关系**：

- 上一份 `stage1-schema-framework.md` 回答"**为什么用两维分类法**"
- 本文回答"**这套分类法具体把 ST 的哪些配置、按什么取舍、放进了哪张表**"

---

## 一页纸结论

- **ST 在用户磁盘上长成什么样**：每个用户一个目录，里面有 13 类子目录 + 2 个核心 JSON 文件，覆盖角色卡、4 类预设、世界书、模板、皮肤、密钥、运行时设置等
- **阶段一往 Supabase 搬了 3 类**：角色卡、API 预设、API 密钥；另外加 2 张表负责把"用户当下选了什么 + 偏好"和"聊天记录"反向镜像回来
- **占位 2 张、显式不建 8 类**：世界书与聊天记录建空表占位，剩下 8 类（4 种模板、KoboldAI/NovelAI/TextGen 预设、皮肤等）阶段一**不建任何表**，靠 ST 自己的默认值跑
- **每张表的字段不是抄 ST 字段的并集**，而是按"运营要不要管 / 平台要不要查"两条标尺切出来的，剩下的全塞 JSONB 兜底
- **现在 Supabase 里能跑通的链路是**：种子数据已导入、6 张表全部锁死（service_role 唯一可访问）、跨 schema 外键验证通过

接下来 D3 起进入"配置清单 + 同步引擎"实施，**不会再有"该建哪张表 / 字段挑哪些"的反复**。

---

## 1. 我们要搬的"原物料"长什么样

在动 schema 之前必须先把 ST 这台机器拆开看一眼——**它真实的样子比文档描述的复杂**。

### 1.1 ST 用户目录的实物清单

用户 `tg_672913845` 在 ST 服务器上对应一个目录 `data/tg_672913845/`，里面长这样（取自我们自己在用的 `default-user`）：

```
data/<用户名>/
├── characters/              ← 角色卡（PNG，元数据嵌在 PNG 的 tEXt chunk 里）
├── chats/                   ← 聊天记录（按角色名分子目录，每段对话一个 .jsonl）
├── worlds/                  ← 世界书（JSON，给角色补充设定）
├── OpenAI Settings/         ← OpenAI 系预设（GPT、Claude、OpenRouter 都走这里）
├── TextGen Settings/        ← 本地推理预设
├── NovelAI Settings/        ← NovelAI 预设
├── KoboldAI Settings/       ← KoboldAI 预设
├── instruct/                ← Instruct 模板（控制对话格式）
├── context/                 ← Context 模板（控制上下文拼装）
├── sysprompt/               ← 系统提示词模板
├── reasoning/               ← 推理模板（思维链格式）
├── QuickReplies/            ← 一键回复短语
├── themes/                  ← UI 皮肤
├── backgrounds/             ← 背景图
├── User Avatars/            ← 用户自己的头像
├── settings.json            ← 大本营，跨会话需要保留的所有"开关 + 当前选了哪个"都在这里
└── secrets.json             ← 所有第三方 API key（明文）
```

**这意味着两件事**：

1. **ST 把配置切得极细**——光预设就分了 4 套（按 API 类型分目录），光"模板"就分了 4 类（instruct / context / sysprompt / reasoning），还各自独立目录
2. **真正决定"用户当前在用什么"的不是文件本身，而是 settings.json**——文件只是"备选池"，`settings.json` 里有大量 `active_xxx_name / preset_settings_openai / instruct.preset` 之类的指针字段指向某个文件

这两条决定了我们整个 schema 的形态：**资源池表（一行一份内容） + 选择型表（一用户一行，记指针）**。这不是我们发明的，**是直接继承自 ST 自己的设计**。

### 1.2 一个具体例子：用户切换角色，磁盘上到底发生了什么

```
1. characters/ 下放着 第七开发部.png、莫池来.png、贺商寒.png（三份"内容"）
2. 用户点击"莫池来"
3. settings.json 里 "active_character" 字段从 "第七开发部.png" 改为 "莫池来.png"
4. chats/莫池来/<最近一次.jsonl> 被 ST 读起来，渲染到界面
```

**characters/ 目录里的三个 PNG 没有任何变化**。变化的是 `settings.json` 这个"指针表"。

这就是为什么我们的 schema 必须分成两类表：

- **资源池表**（`miniapp.characters` / `st.platform_presets`）→ 对应 ST 的 `characters/` / `OpenAI Settings/` 目录里那些独立文件
- **选择型表**（`st.user_st_state`）→ 对应 ST 的 `settings.json` 里那些 `active_xxx` 字段

---

## 2. 11 个目录我们为什么只搬 3 个

这是阶段一最重要的取舍。下面这张表是**逐目录的决策依据**，每条都基于一个明确的问题——"运营有没有真实需求把这个东西管起来？"

| ST 目录                                                | 阶段一动作                                                                 | 决策依据                                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `characters/`                                          | ✅ **搬**：复用 `miniapp.characters`（这张表本来就是运营在管角色卡，D003） | 运营要按 tier 控制谁能用哪张卡、要在大厅展示。**运营必须能管**                              |
| `OpenAI Settings/`                                     | ✅ **搬**：建 `st.platform_presets`（带 `api_type` 字段为 4 类预设留位）   | 预设决定 token 上限、采样参数，**直接影响成本**。运营必须能集中下发                         |
| `secrets.json`                                         | ✅ **搬**：建 `st.platform_api_credentials`（每个 provider 一行）          | 这是平台**真金白银花钱买的 API key**。用户绝不能看到，必须由平台统一下发                    |
| `worlds/`                                              | ⏸ **占位**：建 `st.platform_worldbooks` 空表，**不写 seed**                | 框架要承认这个亚型存在（D006），但阶段一运营还没有"批量下发世界书"的需求，先建表不灌数据    |
| `chats/`                                               | ⏸ **占位**：建 `st.user_st_chats` 空表，**字段未细化**                     | 反向镜像最复杂的一类（用户私有 + 高频写 + 大体积），留到阶段二接 PostMessage 时再细化       |
| `settings.json`                                        | ✅ **搬**：建 `st.user_st_state` 来承接它（核心字段独立列 + JSONB 兜底）   | 跨会话恢复必须有它。但只挑两个高频字段独立成列，其他全 JSONB                                |
| `instruct/` / `context/` / `sysprompt/` / `reasoning/` | ❌ **不建表**：用 ST 配置层锁死单一默认值                                  | 这 4 类是"高级用户向"的模板，阶段一普通用户不感知。运营也没有"批量切换 instruct 模板"的需求 |
| `TextGen / NovelAI / KoboldAI Settings/`               | ❌ **不建表**：不开放对应 provider                                         | 阶段一只用 OpenAI 系（含 Claude、OpenRouter），其他 provider 阶段一不上线                   |
| `QuickReplies/` / `themes/` / `backgrounds/`           | ❌ **不建表**：用 ST 自带默认                                              | 体验型功能，运营不需要管，用户也很少改                                                      |
| `User Avatars/`                                        | ❌ **不建表**：阶段一不开放用户上传头像                                    | 阶段一用户头像直接用 TG 头像，不进 ST                                                       |

**8 类"不建表"的核心理由**：**不要为不存在的需求建表**。一张永远没数据的空表，权限、迁移、文档成本都是真实的，但承担的业务价值是零。等阶段三某天真要开放"高级模板切换"，那时再加表也只是 1-2 小时的事。

**值得专门说的两条延后**：

- **世界书占位**：知道一定要有这个亚型，知道字段结构怎么大致放，**但不灌数据**——因为运营还没决定"哪些世界书是平台默认推荐的"。一旦决定，写 seed 就行
- **聊天镜像占位**：知道反向镜像复杂度最高，**阶段一只把表名占住，字段除了主键和外键之外全留空**——避免现在写错字段，阶段二接入 PostMessage 时被迫推翻

---

## 3. 已建的 7 张表逐张走查

下面是真正的核心。**每张表的字段不是抄 ST 字段的并集**，每个字段都过了两个筛子：

> 筛子 1：**运营要不要在 Supabase 这一侧管它**？（要 → 独立列）
> 筛子 2：**平台要不要按这个字段做查询、聚合、风控**？（要 → 独立列 + 索引）
> 两个筛子都不过 → 塞进 JSONB 兜底字段

### 3.1 `public.users`（扩展）：身份桥的"钥匙"

```
新增字段：
  st_handle          TEXT UNIQUE
  st_initialized_at  TIMESTAMPTZ
```

**为什么只加这两个字段**：

- `st_handle`：每个 TG 用户在 ST 文件系统里对应的目录名。我们的规则是 `tg_<tg_id>`，**完全由 `tg_id` 派生**——意味着这个字段技术上是"冗余"的，但我们还是单独存了一列。理由：未来万一规则改了（比如加前缀做命名空间），有这一列做迁移锚点；同时唯一索引能保护住"一个 TG 用户绝不会被映射到两个不同的 ST 目录"
- `st_initialized_at`：标记"这个用户的 ST 工作目录已经被首次下发过了"。NULL = 还没初始化过；非 NULL = 之后登录走"快速恢复"路径，不再重跑全量下发

**这两个字段都不参与双向同步**——它们是 Bridge 一次性写入的身份信息，不归同步引擎管。

### 3.2 `miniapp.characters`（复用，22 列）：平台角色卡池

**这张表本来就存在**（运营产品的角色卡库），D003 决定复用而不是另建 `platform_characters`。

字段大致分三类：

| 类别                       | 字段                                                                                                                                                                                                               | 用途                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **运营管控字段**（独立列） | `id` / `name` / `avatar_url` / `creator` / `tags` / `created_at`                                                                                                                                                   | 大厅展示、按 tag 筛选、按创建者归档                                         |
| **ST 内容字段**（独立列）  | `description` / `personality` / `scenario` / `first_mes` / `mes_example` / `system_prompt` / `post_history_instructions` / `creator_notes` / `alternate_greetings` / `character_version` / `spec` / `spec_version` | 这些是 ST `chara_card_v3` 规范里的字段，下发到 ST 的 PNG 时要按这些字段拼回 |
| **半结构化兜底**（JSONB）  | `character_book` / `extensions`                                                                                                                                                                                    | 世界书绑定 + 扩展数据，结构 ST 自己也不稳定，整段 JSONB 不解析              |

**为什么 ST 内容字段几乎全独立成列**：因为这张表本来就是运营在大厅里展示卡片的源数据，前端要直接读 `first_mes`、`description` 这些字段渲染。如果塞 JSONB 里，前端每次要解开来用，没意义。

**为什么没有 `is_published` / `required_tier` 这些列**：因为阶段一运营还没明确分级规则。这些是 **D010 演进路径**里明确"低成本未来加列"的，**现在加是过度设计**。

**关键的一句**：这张表是分区 A 的，意味着同步引擎只往 ST 方向写，**永远不会反向**。即使用户在 ST 里改了某张默认卡（理论上他改不了，但假设他绕过去了），下一次同步会把他改的覆盖掉——这是设计的，不是 bug。

### 3.3 `st.platform_presets`（9 列）：平台 API 预设池

```sql
id          UUID PRIMARY KEY
name        TEXT NOT NULL
api_type    TEXT NOT NULL DEFAULT 'openai'  -- openai / textgen / novelai / koboldai
preset_data JSONB NOT NULL                  -- 整个 ST preset JSON 原样塞这
is_default  BOOLEAN                          -- 新用户初始化用哪份
sort_order  INT
enabled     BOOLEAN
created_at / updated_at
```

**关键字段取舍的原因**：

- **`name` 独立列、有唯一索引**：因为 ST 在 `settings.json` 里用名字而不是 UUID 引用预设（`preset_settings_openai: "Default"`）。同步引擎写入 ST 时是 `OpenAI Settings/<name>.json`，**名字就是文件名**，必须保证唯一
- **`api_type` 独立列**：为未来 4 类预设留位。即使阶段一只用 openai，这个字段也必须存，否则未来加 TextGen 预设时整张表要重做
- **`preset_data` 走 JSONB 整段塞**：因为 ST preset JSON 有 280+ 字段（温度、top_p、各种 token 上限、各种 prompt 模板……），**这些字段运营完全不关心，平台也不会按它们做查询**——典型的"两个筛子都不过"。整段 JSONB 是最经济的存法
- **`is_default`**：新用户初始化时，同步引擎挑 `is_default=true` 的那条作为默认预设。这是"种子默认值"语义，**不是用户运行时的选择**

**现在表里有什么**：1 行——`Default` 预设，从 `data/default-user/OpenAI Settings/Default.json` 抽出来，配的是 OpenRouter + claude-sonnet-4.5。

### 3.4 `st.platform_worldbooks`（8 列，**空表占位**）：平台默认世界书池

字段结构和 `platform_presets` 几乎一样（`name` / `worldbook_data JSONB` / `is_default` / `sort_order` / `enabled`）。

**为什么字段不细化**：因为阶段一不灌数据，没有真实样本，**现在猜字段必然有偏差**。等运营真要灌第一份世界书时，从 `worlds/<某本>.json` 反推哪些字段需要独立成列，比现在闭门造车准。

**为什么仍然建表**：占据命名空间（`st.platform_worldbooks` 这个名字预定），同步引擎在 D3 的配置清单里能引用一个"存在的表名"，而不是"留个 TODO 等以后建"。这是软件工程里"留接缝比留 TODO 强"的实践。

### 3.5 `st.platform_api_credentials`（10 列）：平台 API 凭证池

```sql
id              UUID PRIMARY KEY
provider        TEXT NOT NULL              -- openai / claude / openrouter / makersuite ...
display_name    TEXT NOT NULL              -- 运营后台展示用，"OpenRouter 主账号"
api_key         TEXT NOT NULL              -- [SENSITIVE] 阶段一明文
api_base_url    TEXT                       -- 自建代理时用
model_whitelist JSONB NOT NULL DEFAULT '[]'-- 风控用
is_active       BOOLEAN
sort_order      INT
notes           TEXT
created_at / updated_at
```

**核心设计抉择**：

1. **一个 provider 同时只允许一条 active 记录**（有部分唯一索引 `WHERE is_active = true`）。
   原因：避免运营误操作"为同一个 provider 配了两把 key"导致下发结果不确定。要换 key 必须先把旧 key 置 inactive。

2. **`provider` 字段必须与 ST 自己的 `SECRET_KEYS` 枚举对齐**。
   原因：同步引擎写 ST 的 `secrets.json` 时，按 `provider` 字段决定写到哪个 key 里。如果我们这边叫 `claude`、ST 那边叫 `claude_anthropic`，写出来就找不到。这是**强字符串契约**，必须在表注释里写死。

3. **`model_whitelist` 留 JSONB 数组**。
   原因：为风控留接缝（"用户付费 tier 决定能用哪些模型"）。阶段一空数组等于"不限制"，未来不需要改 schema 就能开启限制。

4. **没有 `expires_at` 字段**。
   原因：阶段一团队规模小，运营手动管理 key 生命周期。等 key 数量上 10+ 时再加这个字段（**显式延后，写在决策里**）。

5. **`api_key` 明文存**（D008 决策）。
   核心权衡：阶段一加密的真正防护对象是"运营误看 + 数据库脱库"，威胁优先级远低于"代码层保证不返回到客户端"。后者靠规约和 code review，**加密改不了**。阶段二上 Supabase Vault 时，列名不变，查询接口不变，是无损升级。

**这张表是 D008 之后专门改名的**——原计划叫 `platform_secrets`，但"secrets"语义太宽，未来还会有 webhook secret、签名密钥等，混在一起会出事，所以改成精确语义的 `platform_api_credentials`。

### 3.6 `st.user_st_state`（7 列）：用户运行时状态镜像

这张表是阶段一的核心——**所有"用户运行时反向镜像"的需求都先汇聚到这一张表**。

```sql
user_id              UUID PRIMARY KEY               -- 1:1 关联 users
active_character_id  UUID NULL                      -- ← 选择型字段
active_preset_name   TEXT NULL                      -- ← 选择型字段
st_settings_snapshot JSONB NOT NULL DEFAULT '{}'    -- ← 偏好型兜底
last_synced_at       TIMESTAMPTZ
sync_version         INT NOT NULL DEFAULT 0         -- 乐观锁
created_at / updated_at
```

**这张表为什么是合表（选择型 + 偏好型）的**：理论上应该建两张表（`user_st_selection` + `user_st_preferences`），但两张表的共同特征是"一用户一行、低频写、字段稀疏"，物理形态完全一致。强行拆两张表 = 多一次 JOIN，多一份 RLS 规则，**两边都得维护**。合并的代价是在表注释里显式分段标注哪些字段是 selection、哪些是 preference，避免后人乱塞。

**字段取舍**：

- **`active_character_id` 升列**：高频读（每次进 ST 都要读"我上次在跟谁聊"），需要按它做 JOIN（联到角色卡表显示头像、名字），所以必须独立列
- **`active_character_id` FK 到 `miniapp.characters`**（跨 schema 外键，PG 原生支持）：保证引用完整性。**用户切到 ST 私有卡时**（阶段一不支持，但物理上可能发生），此字段记 NULL 而不是报错，这样反向同步永远不会因为找不到外键而失败
- **`active_preset_name` 升列**：理由同上，前端展示"你在用 GPT 还是 Claude"要读这个
- **`st_settings_snapshot` 走 JSONB**：ST `settings.json` 有几百个字段（UI 设置、各种开关），运营不关心、不查询，**两个筛子都不过 → JSONB**
- **`sync_version` 乐观锁字段**：阶段一其实不会冲突（单设备），但留这一列是为阶段二多设备登录时的冲突防御。每次反向同步带版本号，旧版本不能覆盖新版本

**这张表是阶段一反向同步唯一真实跑数据的表**——其他用户池表（`user_st_chats`）都是占位。底线验收里说的"用户在 ST 里切换角色 → Supabase 里能看到 `active_character_id` 变了"，**走的就是这张表**。

### 3.7 `st.user_st_chats`（10 列，**空表占位**）：用户聊天镜像

```sql
id              UUID PRIMARY KEY
user_id         UUID NOT NULL                    -- FK users
character_id    UUID                              -- FK miniapp.characters
st_chat_file    TEXT NOT NULL                     -- chats/<char>/<filename>.jsonl
chat_data       JSONB NOT NULL DEFAULT '[]'       -- 阶段二再细化
message_count   INT
last_message_at TIMESTAMPTZ
last_synced_at  TIMESTAMPTZ
created_at / updated_at
```

**为什么占位但还是建出来**：

1. **占据命名空间**——同步引擎在 D3 配置清单里能引用 `st.user_st_chats` 这个表名，不会有"待补建表"的悬挂状态
2. **确认两个跨 schema FK 能跑通**——`user_id → public.users` + `character_id → miniapp.characters`，这两条边在 D010 的迁移测试里都验证过
3. **字段名上写死了"按 ST 文件路径定位"**（`st_chat_file`）——意味着将来阶段二实现时，反向镜像的"位点"是 ST 文件，不是 ST 消息 ID 之类的不稳定标识。这是**用字段命名传递设计意图**

**为什么字段都没细化**：聊天数据是用户私有 + 高频 + 大体积，三个特性叠加在一起，是最难设计的一类反向镜像。**强行在阶段一确定字段必然会推翻**。占位让阶段二有空间细化（比如"是分卷存 chat_data 还是单独建 messages 表"这个问题，阶段一不需要决定）。

---

## 4. 三个跨表的设计抉择

字段表讲完，下面是几条贯穿多张表的设计决策，**这些是项目负责人最该看清的**——因为它们一旦定了，未来很多场景都会受这几条决策的约束。

### 抉择 1：双 schema 物理分离（D010）

不是把所有同步表都塞进 `miniapp` schema，而是**新建一个 `st` schema** 专门装 5 张同步表，只把"D003 已复用"的 `miniapp.characters` 留在原位。

**为什么这么干**：

- **权限边界靠 schema 自然隔开**：`miniapp` schema 未来可能要给前端 anon 直读（大厅展示），`st` schema **永远** service_role 唯一可访问。混在一起的话，权限规则要写在每张表上，很容易漏
- **新增表的归属决策硬约束**：未来加新表，名字进 `st.*` 还是 `miniapp.*`，**问"它是同步层数据还是运营业务数据"就行**，不需要拍脑袋
- **跨 schema 外键不是问题**：`st.user_st_state.active_character_id → miniapp.characters.id` 这种跨 schema FK 是 PG 一等公民，约束、级联删除、查询性能全都正常

**代价**：Prisma 配置要在 `datasource` 里加 `schemas = ["public", "miniapp", "st"]`，一次性的小工作量。

### 抉择 2：所有同步表 minimal RLS（D009）

**所有 6 张同步相关表，anon 和 authenticated 角色完全禁读**。所有数据访问必须走后端（postgres 用户，BYPASSRLS）或同步引擎（service_role）。

**为什么这么严**：

- 现有前端**已经不直连 Supabase**——通过 grep 验证 `packages/frontend/src` 里没有任何 supabase 客户端。所有 API 都走 backend → Prisma → 数据库
- 锁死直连路径 = **不会破坏任何现有功能**，但能预防"未来某个外包开发者拿 anon key 在前端直读"的事故
- `platform_api_credentials` 本来就要求严格禁读，**让其他 5 张表也走同一条规则**比"每张表单独决策"省脑子

**未来阶段二**如果真要前端直读某张表（如大厅）：加 `GRANT USAGE ON SCHEMA st TO authenticated` + 加一条 SELECT policy，是**加法演进**而不是推翻。

### 抉择 3：所有表带"三标签"COMMENT，让数据库自证其规则

每张表都在数据库里带这样的标签：

```
COMMENT ON TABLE st.platform_presets IS
  '[partition=A][shape=resource:platform_pool][direction=down] 平台管控的默认预设池，单向下发到 ST OpenAI Settings/';
```

**为什么要这么做**：因为同步引擎（D4-D7 要写的）需要一份"配置清单"来知道每张表怎么同步。如果清单只写在代码里，**代码和数据库容易脱节**——比如有人改了表结构忘了更新代码，同步引擎会用错误的规则操作。

把规则**同时写在数据库的 COMMENT 里**，意味着同步引擎启动时可以反向去 `information_schema` 读这些标签，**和代码里的清单做交叉校验**。两边不一致就启动失败，**永远不会出现"代码 + 表结构互相不知道对方变了"的隐藏 bug**。

这是阶段一 schema 设计里一个不显眼但很值钱的细节。

---

## 5. 数据已经"落地"了——可验证

D2 收尾时，下面这些都是**已经在数据库里跑过的事实**，不是计划：

| 验证项                                                                                   | 结果                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 11 个 SQL migration 全部跑通（001-011）                                                  | ✅ 序号连续，无空洞                                                 |
| 3 张角色卡（第七开发部 / 莫池来 / 贺商寒）从 ST PNG 抽出元数据导入 `miniapp.characters`  | ✅ `chara_card_v3` 规范解析完成，幂等可重跑                         |
| 1 份 OpenAI 预设（Default = OpenRouter + claude-sonnet-4.5）导入 `st.platform_presets`   | ✅ 整段 JSON 用 dollar-quoting 安全嵌入 SQL                         |
| 6 张同步表全部启用 RLS + 撤销 anon/authenticated 权限                                    | ✅ `010_rls_verify.sql` 三块验证全部 PASS                           |
| `st` schema 的 USAGE 权限正确（anon 无 / service_role 有）                               | ✅ 验证脚本里块 1 验证 0a/0b/0c 全 PASS                             |
| 跨 schema 外键（`st.user_st_state.active_character_id → miniapp.characters.id`）保留有效 | ✅ `011` 迁移里的 FK verification 块打印了完整链路                  |
| 种子数据生成器可重跑（基于 ST 真实 PNG / JSON）                                          | ✅ `packages/shared/scripts/generate-seed-sql.ts`，文档化了使用方式 |

**这意味着 D3 起可以放心写同步引擎了**——它会读到的所有 schema 都是确定的、有数据的、权限边界清晰的。

---

## 6. 显式的"现在不做"清单

每条都是主动决策，**不是疏漏**：

| 不做的事                                          | 阶段一不做的原因                                                                | 计划在哪里做                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| 灌世界书种子数据                                  | 运营还没决定哪些是平台默认推荐                                                  | 阶段二或阶段三，按运营节奏                |
| 细化 `user_st_chats` 字段                         | 反向镜像最复杂的一类，避免现在猜错                                              | 阶段二接 PostMessage 时                   |
| 用户上传的私有角色卡反向镜像                      | 框架已为 `user_<resource>` 亚型留位，但具体表（如 `user_characters`）阶段一不建 | 阶段二                                    |
| API key 加密                                      | 威胁模型分析后，阶段一边际收益低                                                | 阶段二上 Supabase Vault                   |
| 给 `platform_*` 表加 `required_tier` 列           | 运营分级规则未定                                                                | 一旦商业化分级规则明确，**加列 1-2 小时** |
| Instruct / context / sysprompt / reasoning 模板表 | 阶段一普通用户不感知，运营也没批量管理需求                                      | 阶段三（如果开放高级用户向功能）          |
| TextGen / NovelAI / KoboldAI 预设表               | 阶段一不上线对应 provider                                                       | 看商业化需要                              |
| 多 ST 实例 / 分片                                 | 阶段一用户量远未到瓶颈                                                          | **不在框架内**，等用户量到阈值再评估      |

---

## 7. 一句话总结

**D1-D2 做完的事**：把 ST 散落在 13 个目录、2 个 JSON 文件里的"配置原物料"，按"运营要不要管 + 平台要不要查"两条筛子过了一遍，挑出阶段一真正需要管的 3 类资源（角色卡 / 预设 / 凭证），加 2 张反向镜像表（运行时状态 / 聊天占位）和 1 个身份扩展，**总共 6 张同步表 + users 扩展**，物理上分进 `miniapp` 和 `st` 两个 schema，权限上全部锁到 service_role 唯一可访问，并在每张表的注释里写死了"它属于哪个分区、什么形态、数据往哪流"。

**接下来 D3 起**，所有同步规则都从这套已经冻结的 schema 里读字段、读注释、读标签，**不需要再问"该建哪张表 / 字段挑哪些 / 权限怎么定"**。

如果项目负责人需要在某一项上推翻或调整，**现在是最便宜的时机**——5 张同步表里 4 张是空表，1 张只有 1 行种子，10 分钟可以重做。**进入 D3 后，配置清单一旦硬编码这些字段名，回头改的成本会指数级上升**。
