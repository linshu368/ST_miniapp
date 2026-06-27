# 架构决策记录

本文档记录 ST_miniapp 项目中的关键架构决策，每个决策包含背景、选项分析和最终结论。

---

## 分区与形态总览

本节是 schema 设计的索引，所有具体决策都应回到这套框架。新增任何表前，先在本节定位它的归属和形态。

### 表的三类归属

| 类别                 | 真相源                                       | 数据流                                              | 阶段一例子（D011 后）                                                                    |
| -------------------- | -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **A 类：平台管控**   | Supabase 绝对真相                            | Supabase → ST 单向下发                              | `platform_settings` / `platform_presets` / `platform_api_configs` / `miniapp.characters` |
| **B 类：用户运行时** | runtime 时 ST 文件系统；跨会话 Supabase 接替 | ST → Supabase 异步镜像；下次登录 Supabase → ST 投影 | `user_st_settings` / `user_st_chats`                                                     |
| **身份/系统类**      | Bridge 内部确定性派生                        | 写一次后不变，不参与双向同步                        | `users.st_handle` / `users.st_initialized_at`                                            |

判断真相源的硬标准：发生冲突时谁的版本胜出。

### 两种核心形态（D011 简化后）

形态决定一张表怎么建、怎么同步。D011 后阶段一收敛为两种形态：

| 形态       | 描述                       | 表模式                                                     | 同步模式                | 阶段一例子                                                                           |
| ---------- | -------------------------- | ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| **配置型** | settings.json 类全量快照   | append-only，一行一个版本快照（含 version + content_hash） | 整块 jsonb 覆盖 / merge | `platform_settings` / `user_st_settings`                                             |
| **资源型** | 独立内容实体，可被指针引用 | 一行一资源 + 业务字段 + 内容字段                           | 文件级 upsert，低频写   | `platform_presets` / `platform_api_configs` / `miniapp.characters` / `user_st_chats` |

**资源型有两个亚型**（详见 D007）：

- `platform_<resource>`：平台池，A 类，单向下发
- `user_<resource>`：用户私有池，B 类，反向镜像

**已废弃的形态**（D011 改进）：

- ~~凭证型~~：API Key 等机密合并到资源型表的 `config_payload` jsonb（如 `platform_api_configs`），用统一 RLS minimal 模式 + 应用层硬约束保护
- ~~选择型 / 偏好型~~：用户运行时配置统一走配置型表 `user_st_settings`（append-only + 白名单子集），不再用"一用户一行 + 多列"的 `user_st_state` 模式

### 阶段一表清单与标签（D014 后 — 现状视图）

每张表的 `COMMENT ON TABLE` 必须显式带上这三个标签，供同步引擎从 `information_schema` 反向校验配置清单。

| 表                                                                    | partition | shape                  | direction | 备注                                                           |
| --------------------------------------------------------------------- | --------- | ---------------------- | --------- | -------------------------------------------------------------- |
| `public.users` (`st_handle`, `st_initialized_at`)                     | identity  | -                      | none      | D001、D011 不变                                                |
| `miniapp.characters` (复用 + 同步字段)                                | A         | resource:platform_pool | down      | D003 复用决策，D011 新增 `is_default`/`enabled`/`sort_order`   |
| `st_platform.platform_settings` (D011 新增核心)                       | A         | config                 | down      | settings.json 全量快照 + writable_paths 白名单                 |
| `st_platform.platform_presets` (D011 字段简化)                        | A         | resource:platform_pool | down      | display_name + preset_payload                                  |
| `st_platform.platform_api_configs` (D011 重命名+简化)                 | A         | resource:platform_pool | down      | 旧名 `platform_api_credentials`，合并为 `config_payload` jsonb |
| `st_users.user_st_settings` (D011 新增核心)                           | B         | config                 | up        | append-only，与 platform_settings 同构，只存白名单子集         |
| `st_users.user_st_chats` (D010；跨 schema FK 到 `miniapp.characters`) | B         | resource:user_pool     | up        | 占位最小结构                                                   |
| `st_infra.sync_tasks` (D6 + D014)                                     | infra     | queue                  | internal  | 反向同步任务持久化队列，独立于 A/B 分区                        |

> 注：`st_platform` / `st_users` / `st_infra` 三 schema 切分是 D014 的决策。D010/D011 时期表名前缀为 `st.*`，git 历史保留；D001-D013 决策正文中出现的 `st.xxx` 引用按 D014 映射到对应新 schema，不再回头修订旧决策的正文，以保持决策记录的历史稳定性。

**已废弃的旧方案表**（D011 替代）：

- ~~`st.user_st_state`~~ → 由 `st_users.user_st_settings`（append-only 配置型）替代
- ~~`st.platform_worldbooks`~~ → 设计文档"世界书跟随角色卡走，不单独建表"
- ~~`st.platform_api_credentials`~~ → 重命名为 `st_platform.platform_api_configs`，字段合并到 `config_payload` jsonb

### 框架边界

- **形态作为思考维度，不强求一一对应物理表**：阶段一只用了配置型（platform_settings / user_st_settings）和资源型（platform_pool / user_pool）两种形态。
- **未在框架内的需求 = 需要扩展框架的信号**：不要硬塞进现有形态，先回到本节补维度。
- **不建表也是合法决策**：ST 文件系统中的资源池，阶段一不需要的可以通过 `config.yaml` / `SAAS_CHANGES.md` 锁死单一默认值，等到真有运营需求时再建（参见 D006）。

---

## D001: Handle 派生规则

**日期**：2026-05-27  
**状态**：已确定

**背景**：需要从 Telegram 用户身份确定性地派生出 ST 用户 handle，用于 ST 文件系统目录名和用户标识。

**决策**：`tg_<tg_id>`，如 `tg_672913845`

**理由**：

- `tg_id` 是 `users` 表已有的 TG 数字 ID 字符串，天然唯一
- 纯数字 + 下划线前缀，filesystem-safe，无需 slugify
- 确定性映射：同一 TG 用户永远派生出同一 handle
- 可通过 `parseTgIdFromHandle()` 反向提取原始 ID

**实现位置**：`packages/shared/src/st-bridge/handle.ts`

---

## D002: Bridge 与 Sync Engine 的代码位置

**日期**：2026-05-27  
**状态**：已确定

**背景**：Bridge（鉴权网关）和 Sync Engine（同步引擎）是两个功能模块，需要决定它们的代码组织方式。

**决策**：

- Bridge → 加入现有 `packages/backend`（新增路由 + 中间件）
- Sync Engine → 新建 `packages/sync-engine`（独立进程）
- 共享类型/函数 → `packages/shared`

**理由**：

- Bridge 是请求-响应模式，本质是几个 HTTP 端点，与现有 backend 共享 TG 鉴权、Supabase 客户端等基建，拆分会引入重复
- Sync Engine 是常驻守护进程（文件 watch + 队列消费），生命周期与 Web Server 完全不同，必须独立

---

## D003: 分区 A 角色卡池复用 miniapp.characters

**日期**：2026-05-27  
**状态**：已确定

**背景**：需要一个"平台管控的默认角色卡池"作为分区 A 数据，可以复用现有 `miniapp.characters` 或新建 `platform_characters`。

**决策**：复用 `miniapp.characters`

**理由**：

- 字段已高度对齐 ST CharaCard V2 规范
- 现有前端大厅已在读这张表，复用 = 一份数据同时服务展示和同步
- 新建会引入"用同步维护同步"的循环问题
- 未来需要管控字段（`is_published`、`sort_order`）只需 ALTER TABLE
- 如需 ST 侧独有元数据，加轻量关联表即可

---

## D004: 阶段一采用原生 SQL 迁移

**日期**：2026-05-27  
**状态**：已确定（阶段一临时策略）

**背景**：现有项目用 Prisma，但 schema 处于高频变动期。

**决策**：阶段一手写 SQL 迁移，文件放 `packages/shared/migrations/`，Schema 稳定后切 Prisma migrate。

**理由**：

- 现有 `schema.prisma` 本身是 `prisma db pull` 内省生成的，项目已是"先建表再 pull"模式
- 高频迭代期 Prisma migrate 的 reset/recreate 流程太重
- 原生 SQL 给 Supabase 执行更直接，与现有工作习惯一致

**迁移路径**：阶段一结束 → `prisma db pull` 刷新 schema → 切换到 `prisma migrate` 正式管理

---

## D005: 分区 B 的 user_st_state 表设计

**日期**：2026-05-27  
**状态**：已确定

**背景**：需要在 Supabase 中镜像用户的 ST 运行时状态，用于跨会话恢复。

**决策**：

- `user_id` 为主键，1:1 关联 `users` 表
- 关键状态字段独立列（`active_character_id`、`active_preset_name`）
- 其余 settings 用 `st_settings_snapshot` JSONB 兜底
- `sync_version` 做乐观锁

**理由**：

- 高频查询字段（active_character）独立列，便于索引和查询
- JSONB 兜底避免为每个 ST setting 字段都建列
- 乐观锁防止反向同步时旧数据覆盖新数据

---

## D006: 资源型切表规则

**日期**：2026-05-28  
**状态**：已确定

**背景**：ST 文件系统实际有 11+ 个独立内容池（`characters/` / `OpenAI Settings/` / `TextGen Settings/` / `NovelAI Settings/` / `KoboldAI Settings/` / `worlds/` / `instruct/` / `context/` / `sysprompt/` / `reasoning/` / `QuickReplies/` / `themes/` / `backgrounds/`），字段结构异构。需要决定"资源型"内部按什么粒度切表，以及阶段一暴露哪些。

**决策**：

1. **切表维度**：按"用户视角的资源类目"切，**不按 ST 文件目录硬切**。平台运营在 UI 上看到几类资源，Supabase 就有几张表。

2. **阶段一仅暴露 3 类平台资源**（schema 详见 D010）：
   - 角色卡 → 复用 `miniapp.characters`（详见 D003）
   - API 预设 → `st.platform_presets`（D010 后已迁入 `st` schema）
   - 世界书 → `st.platform_worldbooks`（同上）

3. **其余 ST 内容池阶段一锁死单一默认值，不建表**：
   - Instruct / Context / Sysprompt / Reasoning 模板 → 通过 `config.yaml` 或锁文件机制固定，进 `SAAS_CHANGES.md`
   - QuickReplies / Themes / Backgrounds / KoboldAI / NovelAI / TextGen → 阶段一不开放也不建表

4. **"延后建表"是合法决策，不是技术债**。等阶段三平台真要把某类资源做成可选项时再补 schema 和同步规则。

**理由**：

- 全部建表 → 阶段一就要 11+ 张 `platform_*` 表，大半在阶段一根本用不到，维护和 RLS 成本极高
- 统一 `platform_resources(kind, data jsonb)` → 丢失按 tag / api_type / 标签筛选的查询能力，未来想加索引需要重建表
- 按"用户视角类目"切 = 平台运营心智 = 客户端 UI 的资源 tab 数量，自然演化、自然解释

**反例（不应该这么做）**：

- 给 instruct 模板建 `platform_instruct_templates` 表，但 ST UI 上这个入口阶段一根本不开放——为不存在的需求建表
- 把多种异构资源合并到一张 `platform_resources` 表，再用 `kind` 列区分——会丢失类型化字段，未来反复扩 JSONB

---

## D007: 资源型的两个亚型（平台池 vs 用户池）

**日期**：2026-05-28  
**状态**：已确定

**背景**：原四形态框架的"资源型"只举了 `platform_*` 例子，但 `user_st_chats` 事实上已是一张"用户私有资源池"表（聊天记录是用户私有内容，反向镜像）。框架必须显式承认这个亚型，否则配置清单无法描述它，同步引擎得为它写 special case。

**决策**：资源型显式拆两个亚型：

| 亚型        | 表前缀                | 归属 | 数据流                 | 阶段一例子                                                |
| ----------- | --------------------- | ---- | ---------------------- | --------------------------------------------------------- |
| 资源-平台池 | `platform_<resource>` | A 类 | Supabase → ST 单向下发 | `platform_presets` / `platform_worldbooks` / `characters` |
| 资源-用户池 | `user_<resource>`     | B 类 | ST → Supabase 反向镜像 | `user_st_chats`                                           |

两个亚型的**表结构可能高度相似**（如未来的 `user_characters` 与 `miniapp.characters` 字段大半重叠），但：

- 数据流方向相反
- RLS 策略相反（平台池：service_role 写、anon 读；用户池：service_role 写、用户只读自己的行）
- **必须分开建表，不能合并**

**阶段一具体范围**：

- 已建 `user_st_chats` 作为用户池占位（阶段二实现具体同步逻辑）
- **阶段一不新建** `user_characters` / `user_worldbooks`
- 用户在 ST UI 中导入的私有角色卡 / 自建世界书，**阶段一不参与反向镜像**
- 反向同步验证范围限定在"平台下发卡之间的切换"：即 `user_st_state.active_character_id` 在 `miniapp.characters` 池内变化
- `user_st_state.active_character_id` FK 到 `miniapp.characters`；若用户切换到了 ST 里的私有卡，该字段记 NULL，不报错，等阶段二建 `user_characters` 后再补

**为什么阶段一不实现用户池资源同步**：

- 阶段一目标是"框架可运行"，不是"功能完备"
- 用户池资源的 RLS、引用关系、冲突策略比选择型复杂得多
- 阶段二接入 PostMessage 时统一处理，框架已为其留位

---

## D008: 凭证存储策略与表命名

**日期**：2026-05-28  
**状态**：已确定（阶段一策略）

**背景**：阶段一需要把平台的 OpenRouter / OpenAI 等 API Key 从 Supabase 下发到 ST 的 `secrets.json`。需要决定加密策略和表命名，否则阶段一无法实现 API Key 下发同步。

**决策**：

1. **阶段一存储策略**：明文 + 严格 RLS + 应用层硬约束
   - Supabase 列直接存明文（不加密）
   - RLS 策略：`anon` / `authenticated` 完全禁读；只有 `service_role` 可读写
   - 应用层硬约束：API key **永远不返回到客户端**，是代码层规约，不只是 schema 防护
   - 操作审计：所有读取和修改通过同步引擎进行，进 audit log

2. **表命名**：使用 `platform_api_credentials`，**不使用 `platform_secrets`**
   - "secrets" 语义太宽，未来会和 webhook secret / 签名密钥 / OAuth client_secret 混淆
   - "api_credentials" 明确范围：用于调用上游 LLM API 的凭证

3. **加密延后到阶段二**：使用 Supabase Vault（pgsodium）
   - 阶段一不上加密的核心理由：威胁模型主要是"key 泄露到客户端"和"运营误操作"，前者靠代码约束，后者靠 RLS + 审计；加密对 service_role 不透明，对真正威胁无防护增益
   - Vault 的边际收益是防 Supabase Studio 操作员肉眼看到明文，阶段一团队规模小，威胁面小
   - 阶段二上 Vault 时是无损升级：列加密，查询接口不变

**理由**：

- 不上加密 = 不阻塞阶段一交付
- 不直接命名 `secrets` = 避免未来表名冲突和误用
- 决策提前 = 同步引擎可以现在就按目标 schema 编码

**待办**（不阻塞 D1 收尾，归入 D2-D3 sync 引擎工作流）：

- ~~建表 migration `007_platform_api_credentials.sql`~~ ✅ D2 完成
- ~~RLS 策略 migration 单独提交~~ ✅ D2 完成（见 D009）

---

## D009: 阶段一 RLS 策略 = minimal 模式（service_role 唯一可读写）

**日期**：2026-05-28
**状态**：已确定（阶段一策略）

**背景**：D2 需要为 6 张同步相关表（`characters` / `platform_presets` / `platform_worldbooks` / `platform_api_credentials` / `user_st_state` / `user_st_chats`）确定 RLS 粒度。可选：

| 选项                     | 描述                                                                        | 主要风险                                                              |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 严格模式                 | 分区 A 让 anon 可读 enabled 行；分区 B 让 authenticated 只读自己 user_id 行 | 给前端开了直连 Supabase 的口，未来 D8 Bridge 接入时多一个鉴权通路要管 |
| **minimal 模式（已选）** | 全部锁死，service_role 唯一可访问，所有读写走 backend / sync engine 中转    | 未来前端真要直读时需要单独开 policy                                   |
| 逐表讨论                 | 每张表单独决定                                                              | 决策开销大，阶段一不必要                                              |

**决策**：阶段一统一采用 **minimal 模式**。

**理由**：

- **现有架构兼容**：通过 grep 已验证 `packages/frontend/src` 无 supabase 客户端，所有访问都走 backend → Prisma → `DATABASE_URL`（postgres 用户，BYPASSRLS）。锁死 anon/authenticated 不会破坏任何现有功能
- **同步引擎一致**：D2 同步引擎用 `service_role`（也是 BYPASSRLS），无需关心 RLS policy 细节，所有同步操作行为可预测
- **D008 凭证表强约束**：`platform_api_credentials` 本来就要求 anon/authenticated 全禁，让其余 5 张表也走相同策略 = 全表统一规则，认知负担最低
- **阶段二可演进**：未来真要给前端开直读（如大厅展示），在 `008_rls_policies.sql` 末尾追加 `CREATE POLICY ... FOR SELECT TO authenticated USING (...)` 即可，是**加法演进**而不是推翻

**实现细节**：

1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`（6 张表）
2. `REVOKE ALL ON ... FROM anon, authenticated`（兜底，防 RLS 被绕过）
3. `GRANT ALL ON ... TO service_role`（显式声明，意图清晰）
4. 用 DO 块清理 6 张表上可能遗留的允许 anon/authenticated 的 policy

**验证手段**（`010_rls_verify.sql`）：

- 元数据校验：RLS 是否启用、anon/authenticated 是否有任何表级权限、是否有允许它们的 policy
- 真实切角色验证：`SET LOCAL ROLE anon` 后 SELECT，所有 6 张表 visible_rows 必须为 0
- `SET LOCAL ROLE service_role` 后 SELECT，种子数据必须可见

**反例（不应该这么做）**：

- 让前端拿 anon key 直读 `miniapp.characters`，绕过 backend —— 短期省事，长期失去对查询的可观测性、限流、付费校验等中间层能力
- 在每张表写复杂的 multi-tenant policy —— 阶段一单源写入（service_role），policy 不增加安全性只增加维护成本

---

## D010: 双 schema 分离（`miniapp` 业务 / `st` 同步）

**日期**：2026-05-28
**状态**：已确定

**背景**：D2 收尾时发现，`miniapp` schema 同时承载了两类不同性质的数据：

| 性质                             | 表                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 运营业务表（付费、签到、会话等） | `app_messages` / `app_sessions` / `miniapp_user_settings` / `runtime_config` / `characters`                 |
| ST 同步层新增表（D1-D2）         | `platform_presets` / `platform_worldbooks` / `platform_api_credentials` / `user_st_state` / `user_st_chats` |

两类数据的运维特征完全不同：运营表服务前端展示和支付链路（可能开放 anon 直读），同步表必须 service_role 唯一可访问（凭证敏感）。

混在同一 schema 里有以下问题：

- 权限边界不清：无法把"运营操作员可以看的"和"绝对不能看的"用 schema 自然隔开
- 备份/恢复粒度粗：导出测试数据时无法只导出 ST 同步层
- 新增表归属决策不明显：未来加新表时缺一个硬约束
- 命名碰撞：未来加 `user_settings`、`presets` 等通用名称时容易冲突

**决策**：将 5 张 D1-D2 新增表迁移到独立的 `st` schema：

| 原位置                             | 新位置                        | 备注                 |
| ---------------------------------- | ----------------------------- | -------------------- |
| `miniapp.platform_presets`         | `st.platform_presets`         | 平台预设池           |
| `miniapp.platform_worldbooks`      | `st.platform_worldbooks`      | 平台世界书池（占位） |
| `miniapp.platform_api_credentials` | `st.platform_api_credentials` | 凭证池（D008）       |
| `miniapp.user_st_state`            | `st.user_st_state`            | 用户状态镜像         |
| `miniapp.user_st_chats`            | `st.user_st_chats`            | 用户聊天镜像（占位） |

**保留在 `miniapp` 不动**：

- `miniapp.characters` —— D003 复用决策仍然成立。这张表"两边都用"（运营大厅展示 + ST 同步下发），归属语义是"运营内容池"，跨 schema FK 由 PG 原生支持
- `app_messages` / `app_sessions` / `miniapp_user_settings` / `runtime_config` 等纯运营表

**理由**：

1. **数据流向决定 schema 归属**：
   - `miniapp.*`：服务前端 UI / 运营后台 / 支付链路的数据 → 可能开放更宽的访问策略
   - `st.*`：ST 同步层的"投影/镜像"数据 → 永远 service_role 唯一
2. **现在做迁移成本最低**：5 张表中 4 张空表 + 1 张只有 1 行种子，10 分钟完成；D3 配置清单一旦写好就会硬编码路径，再迁移成本指数级上升
3. **跨 schema FK 是 PG 一等公民**：`st.user_st_state.active_character_id REFERENCES miniapp.characters(id)` 完全合法，外键约束、级联删除都正常工作
4. **schema 权限做硬约束**：`REVOKE USAGE ON SCHEMA st FROM anon, authenticated`，未来即使有人误开了某张 `st.*` 表的 RLS policy，schema USAGE 缺失会在更早一层 deny，作为兜底
5. **复用决策（D003）保持**：`miniapp.characters` 不动，运营 backend 代码 0 改动，跨 schema FK 维持引用完整性

**实现细节**：

- 新增迁移：`011_split_schema_to_st.sql`，用 `ALTER TABLE ... SET SCHEMA st` 原子搬迁
- ALTER TABLE SET SCHEMA 自动保留：所有列 / 约束 / 索引 / 跨 schema FK / RLS 启用状态 / GRANT
- schema 级 USAGE：`REVOKE FROM anon, authenticated; GRANT TO service_role, postgres`
- 改写 003-007、008、010 的表名前缀：`miniapp.xxx` → `st.xxx`（仅 5 张迁移表；characters 保留）
- 改写 `generate-seed-sql.ts`：预设 INSERT 目标改 `st.platform_presets`；角色卡仍 `miniapp.characters`

**未来演进**：

- 新增 ST 同步相关表 → `st.*`
- 新增运营业务表 → `miniapp.*`
- 新增跨 schema 引用 → 大胆用（如 `st.user_resources` FK 到 `miniapp.users` 之类）

**反例（不应该这么做）**：

- 把 `miniapp.characters` 搬到 `st.characters` —— 破坏 D003 复用决策，运营 backend 全要改路径
- 在 `st` 和 `miniapp` 各建一份 `characters` 做单向同步 —— D003 已明确拒绝的"用同步维护同步"
- 给所有新表都套个 schema（如 `st_credentials` / `st_state` / `st_chats` 三个 schema） —— 过度切分；按"业务/同步"二分已经足够

---

## D011: 用配置型 schema 替换原"选择型 + 偏好型"方案

**日期**：2026-05-30  
**状态**：已确定（替代旧方案）

**背景**：D2 收尾后复盘旧 schema（`user_st_state` 选择型+偏好型合表 / `platform_worldbooks` / `platform_api_credentials`）发现三个结构性问题：

1. **缺一张承载 settings.json 全集的表**：用户配置的"权威源"散落在 `user_st_state.active_character_id` / `active_preset_name` / `st_settings_snapshot` 三处，无法一站定位"用户当前在哪个 settings 版本上"
2. **白名单（writable_paths）没有归属表**：旧方案没有显式表达"这个版本下哪些字段允许用户改"，导致反向同步时只能硬编码白名单或额外建表
3. **`user_st_state` 是"原地 update"模式**：丢失审计、回滚、灰度对照能力。append-only 方案的存储成本（一年内不需要 GC）远小于上述三个能力的价值

**决策**：阶段一引入**两维方案**（权威源 × 数据形态），用配置型表对替换旧设计：

| 旧方案                                               | 新方案                                                           | 形态变化                              |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `st.user_st_state`（一行/用户，选择型 + 偏好型合表） | `st.user_st_settings`（append-only，一行/版本）                  | 偏好型/选择型 → 配置型                |
| 没有 settings 全集表                                 | `st.platform_settings`（append-only，含 writable_paths 白名单）  | 新增配置型                            |
| `st.platform_api_credentials`（凭证型，列拆分）      | `st.platform_api_configs`（资源型，`config_payload` jsonb 整块） | 凭证型 → 资源型，配 D008 应用层硬约束 |
| `st.platform_worldbooks`（资源型占位）               | 不建表                                                           | 设计文档"世界书跟随角色卡走"          |
| `miniapp.characters`（仅 D003 复用）                 | + `is_default` / `enabled` / `sort_order`（同步管控字段）        | 复用决策不变，加管控列                |

**理由**：

1. **指针模型统一**：用户的所有"选择"现在都体现为 `user_st_settings.settings_jsonb` 中的指针字段（如 `active_character: "platform_<uuid>.png"`），通过 `writable_paths` 的 `transform` 类型校验和兜底。比"独立列 + JSONB 兜底"的混合模型更内聚
2. **白名单和默认值绑定冻结**（决策 2）：白名单作为 `platform_settings.writable_paths` 字段和默认值一起 append-only。同一行就是一个自洽的快照状态，运营回滚一键回退
3. **B 表语义自洽**（决策 1）：`user_st_settings.settings_jsonb` 只存白名单 `lodash.pick` 后的子集，表里有什么键 = 用户在该版本白名单下被授权改过，不需要联查反推
4. **append-only 的成本小于收益**（设计原则 2）：用 `(user_id, content_hash)` UNIQUE 幂等去重 + 应用层防抖（2-5 秒静默）控制行数膨胀，一年内不需要 GC
5. **凭证型并入资源型**：D008 早就指出阶段一凭证保护本质是"应用层硬约束 + RLS minimal"，不靠列结构。合并到 `config_payload` jsonb 减少 ALTER TABLE 频率

**实现细节**：

- 新 migration 序列 `003_create_st_schema.sql` ~ `011_seed_data.sql`（共 9 个新文件 + 保留 001/002）
- `generate-seed-sql.ts` 重写：新增 `platform_settings` 全量快照 + 三处指针清洗（`active_character` / `oai_settings.preset_settings_openai` / `main_api`）+ canonical content_hash（key 排序后 sha256）
- 旧迁移文件 003-011 全部删除
- 已部署旧方案的环境通过 `DROP TABLE ... CASCADE` 回退后重跑 003-011（详见 `migrations/README.md`）

**反例（不应该这么做）**：

- 让 `user_st_settings` 既存白名单内字段又存非白名单字段 —— 破坏决策 1 的语义自洽性
- 给 `platform_settings` 加"原地 update"模式 —— 违背原则 2，丢失审计能力
- 把 settings.json 拆成几百列 —— 违背原则 3，给自己背 ST 演进的维护税

---

## D012: 配置型表统一 append-only

**日期**：2026-05-30  
**状态**：已确定（设计原则升级为决策）

**背景**：D011 引入两张配置型表（`platform_settings` 和 `user_st_settings`）后，需要明确它们的写入语义。append-only 在数据库视角下是一个"反直觉"的选择（同一逻辑实体跨多行），需要写入决策记录避免后人原地 UPDATE。

**决策**：所有配置型表（当前的 `platform_settings` / `user_st_settings`，以及未来新增的同形态表）严格 **append-only**：

1. **不允许原地 UPDATE 内容字段**（`settings_jsonb` / `writable_paths` 等）
2. **每次变更都 INSERT 一行新版本**，带上：
   - 单调递增的版本号（`platform_version` 或 `user_revision`，由应用层取 `MAX + 1`）
   - canonical content_hash（key 排序后 sha256，由应用层计算）
3. **同 hash 拒绝重复写入**：通过 UNIQUE 索引强制（`platform_settings.content_hash` / `user_st_settings(user_id, content_hash)`）
4. **读取永远取最新行**（`ORDER BY platform_version DESC LIMIT 1` / `ORDER BY user_revision DESC LIMIT 1`）

**理由**：

- **审计**：每次变更都有完整记录，谁、何时、改了什么一目了然
- **回滚**：发现新版本有问题，运营把"取最新"改成"取最大且小于 N"即可秒回滚，不需要从备份恢复
- **灰度对照**：未来可以让一部分用户读 v3，另一部分读 v4，通过 `audience` 字段实现，无需改 schema
- **存储成本可控**：
  - `platform_settings`：运营节奏，一年最多 100 行
  - `user_st_settings`：单用户用 `(user_id, content_hash)` UNIQUE 去重 + 应用层 2-5 秒防抖；100K MAU、每用户每天 5 个有效改动 = 一年 1.8 亿行，按 jsonb 平均 5KB 算约 900GB——一年内可控，必要时阶段三上 GC（保留近 N 个版本）
- **决策 7 字段提升的懒初始化**：A→B 字段提升时不需要批量回填用户的 B 表，新版本自然在用户下次操作时落地，append-only 让这种"被动迁移"语义成立

**实现细节**：

- `platform_settings` 主键 `id` (UUID) + `platform_version` UNIQUE
- `user_st_settings` 主键 `id` (UUID) + `(user_id, user_revision)` UNIQUE + `(user_id, content_hash)` UNIQUE
- 所有写入应用层先做 `canonicalize(jsonb) → sha256 → hash` 计算，再 INSERT；同 hash 被 UNIQUE 拒绝就直接跳过（幂等）

**未来演进**：

- 阶段三需要 GC 时，加一个保留窗口（如最近 30 天 + 最近 10 个版本），后台批量 DELETE 老版本
- 阶段三需要 audience 灰度时，应用层写入时填 `audience` 列，读取时附加 WHERE 子句

**反例（不应该这么做）**：

- 给 `user_st_settings` 加 `UPDATE` 路径 —— 破坏审计 / 回滚能力
- 不计算 content_hash，让相同内容的多个 watch 事件都落地 —— 一周内表会膨胀到 GB 级
- 把 hash 算法从 canonical 改成 `JSON.stringify(value)` —— PG 原生序列化不稳定，相同语义的 jsonb 算出不同 hash，去重失效

---

## D013: 角色卡 PNG 在 Supabase 端的存储位置

**日期**：2026-05-30  
**状态**：已确定（阶段一策略 + 阶段二演进路径）

**背景**：D003 决策复用 `miniapp.characters`，但旧表只存 chara_card_v3 的 JSON 元数据，没有 PNG 二进制本体。运营发布角色卡时需要决定 PNG 存哪：

| 选项                                      | 描述                                                                           | 主要风险                                |
| ----------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| **本地文件系统**（已选阶段一）            | PNG 落在 ST 服务器 `data/<handle>/characters/platform_<id>.png`，Supabase 不存 | 多 ST 实例 / 跨机器同步时本地副本不一致 |
| Supabase Storage                          | PNG 上传到 Storage bucket，运营后台通过签名 URL 下载下发                       | 多一层 IO，但有版本管理和 CDN 加速      |
| 直接在 `miniapp.characters` 加 `bytea` 列 | PNG 二进制直接进表                                                             | 单行可能 1-2MB，pg 性能不友好；备份膨胀 |

**决策**：

1. **阶段一**：PNG 放在 ST 服务器本地文件系统，命名 `platform_<id>.png`（决策 4 稳定命名），Supabase 不存二进制本体
   - 运营发布新卡：把 PNG 放到一个固定的 `seeds/` 目录 + 通过 `generate-seed-sql.ts` 提取 chara_card_v3 元数据写 Supabase
   - 同步引擎初始化分发：从该目录拷贝 PNG 到 `data/<handle>/characters/platform_<id>.png`
   - 阶段一**单 ST 实例**前提下不存在多副本一致性问题（D2 已说明）

2. **阶段二（未来）**：迁移到 Supabase Storage
   - PNG 上传到 `st-platform-assets` bucket，路径 `characters/<id>.png`
   - 同步引擎从 Storage 签名 URL 下载到 ST 本地（保留 ST 文件系统依赖，不改 ST 源码）
   - chara_card_v3 元数据继续存 `miniapp.characters`，加一列 `storage_path` 指向 Storage 对象

**理由**：

- **阶段一不上 Storage 的核心理由**：单 ST 实例，本地文件系统就是真相源，加一层 Storage 只增加运维复杂度无收益
- **不在 PG 存 bytea 的核心理由**：PG 不擅长大二进制，备份膨胀严重，未来想加 CDN 还是得迁出
- **`platform_<id>` 稳定命名是阶段一/阶段二共同基础**（决策 4）：阶段二迁 Storage 时，`miniapp.characters.id` 保持不变，settings.json 中的 `active_character` 指针不需要重写
- **chara_card_v3 元数据和 PNG 二进制可以分离**：JSON 部分进 `miniapp.characters` 给运营查询和大厅展示用；PNG 部分纯粹给 ST 用

**实现细节（阶段一）**：

- `generate-seed-sql.ts` 已实现 PNG 元数据提取
- 同步引擎初始化分发器（D2 待实现）需要：
  1. 读 `miniapp.characters` 列出所有 enabled = true 的卡
  2. 从约定的本地 `seeds/characters/` 目录找对应 `platform_<id>.png`
  3. 拷贝到 `data/<handle>/characters/platform_<id>.png`
  4. 校验拷贝成功后再下发 `settings.json`（决策 5：先资产层后配置层）

**未来演进（阶段二）**：

- 新增 `miniapp.characters.storage_path TEXT NULL` 列，阶段一为 NULL（fallback 到本地）
- 同步引擎检测：`storage_path IS NOT NULL` → 从 Storage 下载；否则从本地拷贝
- 渐进式迁移：旧卡保留本地，新卡走 Storage，最终全量切

**反例（不应该这么做）**：

- 在 `miniapp.characters` 加 `bytea avatar_data` 列 —— PG 性能不友好，备份膨胀
- 阶段一就上 Storage —— 单实例无收益，徒增复杂度
- 让 ST 直接从 Supabase Storage 读 —— 改 ST 源码（黑盒约束被破坏）

---

## D014: 三 schema 切分（`st_platform` / `st_users` / `st_infra`）取代 D010 二分

**日期**：2026-06-03  
**状态**：已确定（修订 D010 反例第三条）

**背景**：

D010 当时把 ST 同步层统一进 `st` schema，并在反例中显式拒绝过"三 schema 切分"，理由是"过度切分；按业务/同步二分已经足够"。但 D011-D012 演进后，`st` schema 实际承载了**三类语义不同的表**：

| 表                                                                         | 语义                         |
| -------------------------------------------------------------------------- | ---------------------------- |
| `st.platform_settings` / `st.platform_presets` / `st.platform_api_configs` | 分区 A，平台管控数据         |
| `st.user_st_settings` / `st.user_st_chats`                                 | 分区 B，用户运行时镜像       |
| `st.sync_tasks`（D6 D012 新增）                                            | 同步引擎运维基建（任务队列） |

当 schema 同时承载多种语义时：

1. **schema 名失去表达力**：仅看 `st.user_st_settings` 与 `st.sync_tasks` 在同一 schema 下，无法直接区分"用户镜像数据"与"引擎运维基建"。
2. **D010 的"业务/同步二分"前提失效**：同步层不再服务单一目的，二分轴失去解释力。
3. **未来 audit / metrics / worker_locks 等基建表会继续往 `st` 塞**，进一步加剧歧义。

**决策**：拆三个 schema，按"语义角色"切分：

| Schema        | 角色                                                | 阶段一表                                                          |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `st_platform` | 分区 A，平台管控数据（Supabase=真相，单向下发）     | `platform_settings` / `platform_presets` / `platform_api_configs` |
| `st_users`    | 分区 B，用户运行时镜像（runtime ST=真相，反向镜像） | `user_st_settings` / `user_st_chats`                              |
| `st_infra`    | 同步引擎运维基建（队列、未来 audit/metrics/locks）  | `sync_tasks`                                                      |

**保留不动**：

- `public.users`（identity，不属于 ST 同步层）
- `miniapp.*`（运营业务，D003 复用决策仍然成立）

**命名规则**：`st_<role>`，role 用语义角色（platform / users / infra），不用业务领域。

**理由**：

1. **schema 名直接表达内容**：运维 / 客服 / 合规索引 `information_schema.tables` 时，仅看 schema 名即可定位"这是平台管控数据"还是"用户镜像数据"还是"引擎基建"。这是 D010 二分时无法做到的。
2. **schema 提供的不只是命名前缀，更是权限与运维边界**：
   - `REVOKE USAGE ON SCHEMA st_users` 与 `REVOKE USAGE ON SCHEMA st_platform` 可以独立调整（未来如果运营后台只读 A 区可以单独开 `st_platform` 给运营 role，而不开 `st_users`）
   - `ALTER DEFAULT PRIVILEGES IN SCHEMA st_<x>` 让"未来在该 schema 下新建的表"自动继承一致权限，跨 schema 自然分类
   - 备份 / 导出 / 归档可以按 schema 粒度独立处理（A 区低频运营节奏；B 区高频用户写入；基建按引擎周期）
3. **与 D003 复用决策正交不冲突**：`miniapp.characters` 仍在 `miniapp` schema，跨 schema FK（`st_users.user_st_chats.character_id → miniapp.characters.id`）是 PG 一等公民，约束、级联删除、查询性能正常。
4. **D014 推翻 D010 反例第三条，但保留 D010 核心收益**：D010 提出"权限边界由 schema 自然承担"——这一原则在 D014 下被进一步强化，不是削弱。
5. **三 schema 不是过度切分**：D010 反例当时举的例子是 `st_credentials / st_state / st_chats` 三 schema 各装一两张表——按"表名"切。D014 是按"语义角色"切，每个 schema 承载明确的一类数据，未来会继续在该角色下扩表（如 `st_platform.platform_member_tiers`、`st_infra.audit_log`），不会再切碎。

**与 D010 的关系**：

D010 是阶段性决策——在 schema 只承载单一语义时，二分够用。D014 是 schema 实际承载三类语义后的演进，**不否定 D010 的核心原则（权限/运维边界由 schema 承担）**，只修订其中"二分足够"这一具体结论。

**实现细节**：

1. Migration `003_create_st_schemas.sql`（重命名自 `003_create_st_schema.sql`）：建三个 schema + 各自 schema-level USAGE/DEFAULT PRIVILEGES 锁
2. Migration 005-009：表名前缀
   - `st.platform_*` → `st_platform.platform_*`
   - `st.user_st_*` → `st_users.user_st_*`
3. Migration 010 RLS：targets 数组按三 schema 分组（不含 `st_infra.sync_tasks`，那张表的 RLS 在 012 中独立设置）
4. Migration 011 seed：INSERT 目标改 `st_platform.*`
5. Migration 012：`st.sync_tasks` → `st_infra.sync_tasks`
6. `registry.yaml`：`version: 1` → `version: 2`，`supabase.schema` 字段从 `st` 拆为 `st_platform` / `st_users`
7. `sync-engine` 代码：14 处 `.schema('st')` 调用拆为 `.schema('st_platform')` / `.schema('st_users')` / `.schema('st_infra')`
8. `generate-seed-sql.ts`：INSERT 模板目标 schema
9. 文档：本文件顶部"现状视图"已更新；`Schema划分设计.md` / `migrations/README.md` 同步；`stage1-d1d2-walkthrough.md` 与`执行计划.md`作为历史性文档保留 `st.*` 引用，仅在文首加 D014 演进注解

**迁移路径**：

部署可重置环境的执行步骤：

```sql
-- 1. 删除旧 st schema 及其下所有表（已部署但可重置的环境）
DROP SCHEMA IF EXISTS st CASCADE;

-- 2. 跑全量 003-012（已是新版本，建三个 schema + 在新 schema 下建表）
```

未部署环境直接顺序跑 003-012。

**反例（不应该这么做）**：

- 给每张表单独一个 schema（`st_settings` / `st_presets` / `st_chats`）—— 回到 D010 反例第三条，过度切分，schema 内容稀疏
- 用抽象命名（`st_a` / `st_b` / `st_c`）—— 失去角色语义，新人入职无法理解
- 把 `sync_tasks` 塞进 `st_users`（"反正都是和用户相关"）—— 违背"schema 名直接表达内容"原则；任务队列是引擎运维表，不是用户镜像数据
- 保留 `st` schema 仅放 `sync_tasks`（"剩下的就放 st"）—— 让 `st` 这个名字含义漂移（D010 时是"ST 同步层"，现在变成"引擎基建"），破坏决策记录的稳定性。新名字 `st_infra` 干净

**未来演进**：

- 阶段二接 PostMessage / 多租户：可在 `st_users` 维度扩展（如未来按 `audience` / 租户切 row level，schema 不变）
- 阶段三引擎基建膨胀：audit / metrics / worker_locks 都进 `st_infra`，无需再切新 schema
- 如果未来 A 区分化出"会员等级"等新资源池：建 `st_platform.platform_<resource>`，命名规则不变

---

## 决策模板

```
## DXXX: 标题

**日期**：YYYY-MM-DD
**状态**：已确定 / 待讨论 / 已废弃

**背景**：...
**决策**：...
**理由**：...
```
