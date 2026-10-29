---
module_id: database.business.conversation-storage
title: 会话、语音与图片存储
scope: database
category: business
status: active
owners: [database]
last_verified_task: .trellis/tasks/10-29-chat-reply-likes/
last_verified_at: 2026-10-29
---

# 会话与语音存储

## 职责与边界

## 当前状态

新发送与重生成使用 `experience.start_chat_history_*_with_current_postprocess`：在开轮事务内读取 `app_core.runtime_config` 当前正式指针、校验不可变 artifact 快照，再复用既有显式版本 wrapper 写入非空 `chat_history.postprocess_version`。旧 wrapper 的 `NULL=不绑定` 保留兼容，旧行不回填。

## 入口与调用者

## 涉及文件

| 路径                                                                                  | 职责                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared/migrations/069_miniapp_chat_sessions.sql`                            | 会话基线                                         |
| `packages/shared/migrations/077_context_window.sql`                                   | 上下文水位                                       |
| `packages/shared/migrations/080_chat_message_voice.sql`                               | 语音元数据                                       |
| `packages/shared/migrations/20260914_chat_message_images.sql`                         | 图片 attempt、租约与 Storage bucket              |
| `packages/shared/migrations/20260930_bind_current_text_postprocess_on_turn_start.sql` | 开轮原子绑定当前正式展示版本                     |
| `packages/shared/migrations/20261029_conversation_branches.sql`                       | 固定历史引用、独立分支会话、继承上下文与开轮适配 |
| `packages/shared/migrations/20261029_chat_message_likes.sql`                          | 按会话与固定回复版本隔离的个人点赞               |
| `scripts/test-conversation-branches-migration.sh`                                     | PostgreSQL 17 隔离分支验收入口                   |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

`experience.openrouter_chat_history` 按唯一 `chat_history_id` + 父 FK `ON DELETE CASCADE` 保存 OpenRouter 调用元数据。`20261016_openrouter_original_metadata_fields.sql` 以 expand 方式将 11 列改用厂商原名；`llm_generation_id`、`llm_generation_data`、主键与审计字段保持现名。旧别名仅用于迁移窗口兼容；新 Backend 不读写别名，旧 writer 退出后需补核窗口数据，清理另交 contract migration。主表业务 `llm_finish_reason` 和计费事实保持原归属；Venice 表不调整。文件声明不等于目标环境已执行。

“当前”只认 `miniapp_text_postprocess_config` 指针，不使用 `MAX(version)`。配置缺失、协议错版、artifact 快照不可用或 RPC 未部署时整轮失败，不留下 history 半写；发布顺序为 migration → Backend。

## 验证方式

## 已知缺口与待核验项

已交付主表12调用列与专表11重复别名的独立contract，保留主表业务llm_finish_reason/计费及专表ID/data；PG17+PostgREST双处真删列后实际repository/视图读写通过。TEST catch-up/views已记账，两个DROP未执行；Production状态独立复核。旧raw JSON/历史分类及共享旧消费者退出仍是门禁，Venice旧账本漂移不修复。

## 关联模块

`backend.business.conversation-generation`、`backend.infrastructure.runtime-data-security`。

## 图片创作广场 V2（2026-10-12）

图片广场持久化位于 `experience` 域，覆盖会话/消息、短期报价、参考资产、生成 attempt、artifact 和公开作品；生命周期由 Backend service-role 和受限 RPC 权威写入，客户端不直接读表。生成任务通过 `FOR UPDATE SKIP LOCKED` 租约领取，过期不确定任务可收口为 `failed_unknown`。

`20261013_image_plaza_seed_catalog.sql` 将提示词约束前向扩至 2000 字，并为 artifact/work 增加互斥的 `generated`/`civitai_seed` 来源不变量。种子作品可无用户和 attempt，只能由 service-role 导入 RPC 原子创建；Civitai ID 唯一，源 URL/源热度仅内部保存，站内点赞从 0 独立累计。`20261013_image_plaza_seed_large_assets.sql` 仅将经审核 seed 所需的 artifact/bucket/RPC 容量扩至 50 MiB，普通用户图片仍由 Backend 限制为 20 MiB；三份 migration 已在 test 验证。

## 变更记录

- 2026-10-19：增加离线 TEST seed 导出与目标初始化模板，复用既有 RPC，不增加永久对象；仅导出 active seed 内容与图片元数据，目标重新分配 UUID，排除用户行为。真实数据不入 Git，Storage 实体复制和生产执行独立审批。见 `ops/image-plaza-seed-migration.md`；未进行生产导入。

- 2026-10-13：任务 `10-10-image-plaza-v2` 增加初始作品来源模型和 2000 字约束前向迁移。

last_verified_task: .trellis/tasks/10-29-chat-reply-likes/
last_verified_at: 2026-10-29

- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除重复的历史变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## T9 专表旧别名清理（本地实现，远端未执行）

新增独立 `20261016_openrouter_chat_history_drop_legacy_aliases.sql`：删除11个重复别名，保留canonical原名列、llm_generation_id/data及UNIQUE/FK/ACL；仅填NULL原名安全字段、非空冲突/未知依赖/超过2000候选拒绝。显式删除8个旧别名CHECK，canonical CHECK保留。不把待回捞metadata空值判为失败，不改父行业务事实或Venice。可先清专表，主表DROP仍有独立历史JSON/结算和运行门禁；不搬raw JSON、不伪造结算。PG17/PostgREST双处真实删列回归见任务T9报告；真实环境覆盖与所有旧writer退出仍需独立验收。

## T10 历史处置（本地实现，未远端执行）

新history_disposition只保全类型化原名调用字段/受控诊断，清父表raw并规范化已有OR诊断；不存未知JSON、自由文本错误或原始归档，Venice/业务/账务不写。LIMIT2001先预算、最多2000、指纹CAS/事务/ID/provider/类型守卫。主表DROP仅在两库未执行证明后修正：以真实snapshot schema账本边界分类旧终态账单/dedup/失败/真实pending，旧pending原样保留不伪造结算；现代未知/漏快照/身份或状态冲突/关联reserved继续阻断。先处置文件成功记账再主表DROP，TEST证据不替代Production；超窗旧账务停止自动回捞、独立核验。

## 主动停止原因与政策（2026-10-26）

chat_generation_requests.user_stop_billing_enabled在创建请求时确定：存量false、新轮true。service-only experience.cancel_chat_generation锁定具体session/history并裁决终态原因；新请求省略reason也按手动停止处理，不允许参数直接写入免费timeout。真实primary/fallback/global阶段截断优先免扣，未验证自动截止由现有watchdog确认。报价前不伪造账单；业务原因user_cancelled由billing资格读取，原报价和charge_id不改，历史无回填。

## 历史：可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。

## 聊天准备阶段减负（2026-10-27）

新增 migration 20261027_chat_charge_lookup_index.sql，为高频 llm_charge_id 等值查找建立非空部分 B-tree。生产原查询计划为全表扫描；索引 CONCURRENTLY、无外层事务、有限资源/超时，失败无效索引先核验再恢复。不改收费函数、历史数据或权限。执行证据见任务 release-review。

## 客户端首字交付 v4（2026-10-28）

新客户端用 `client_committed_v4` 替换屏幕可见检测：提交动作 → 本轮正文或已开启的公开思考首次提交到 React 消息界面状态。它是业务侧交付口径，不是像素/阅读证明。滚动位置、气泡是否在视口、思考是否折叠均不参与；received 仅供分段排查，不能取消截止。提交时间达到当轮 deadline 即归超时，计时器延迟不能变成超时后的成功。

send/regenerate 携带可选 `first_token_measurement`；后端通过既有 begin RPC 的同一次 INSERT 写入现有 measurement_method，缺报请求仍属于 v4。每轮首次结果不可改写；离页/后台独立终态，生成仍可继续并在返回时恢复。迟到回复可展示但不改写已超时记录。旧 v1-v3 保留兼容，历史独立筛选。

统计复用现有 first_token_visible_ms 列承载按版本定义的时长，不增加表、cron、轮询或逐 token 写入。主指标为前台已知结果的无字时间截断率；成功分布只取截止前已交付样本，离页/缺报及覆盖率同时显示。后台和缺报不能当成功，不用服务端或供应商 latency 填补客户端数据。v4只改变观测口径；最新竞争策略见后文，总首字上限10秒与1%目标保留。

系统超时免费、免费预留释放；主动停止沿原报价/权益一次结算。计费继续用一次交付结果和服务端持久化终态保障正确性，不依赖滚动/阅读。已结算记录只补调用元数据，不重进计费；归档明细依永久去重返回显式 archived 终态，不重扣、不伪造账单；failed 进入已有有界退避。缺报沿用原预算+15秒保守收口，不增加新计费任务。

迁移为 `20261028_client_committed_first_token.sql`、`20261028_llm_archived_charge_result.sql`，均仅替换既有函数，保留 ACL 和历史数据。先 TEST 验证、合 dev，再生产迁移 → Backend → Frontend/看板。发布证据见任务 release-review；1%是否达成须由上线后的 v4 样本判断。

## 首发与兜底竞争交付（2026-10-28）

首发实际派发后达到型号阈值（默认4秒）启动兜底，首发继续；两路共用原10秒首字截止，任一路先出现有效正文或已开启公开思考即锁定唯一赢家，立即中止败方。`fallback_timeout_ms`字段保留兼容，默认2000仅作为前置过慢时提前启动兜底的预留时间，不再是兜底自身硬截止。同型号不并发重复请求，可等到总截止；首发明确失败只允许一次顺序兜底。历史阶段预算不回填，新旧策略按实际发布时刻分窗；客户端仍用v4，总耗时不相加两路并行等待。

只消费赢家的replay与原charge_id结算，原报价/权益、超时免扣、主动停止和离页恢复规则不变。败方立即取消，不为排查drain；只把已接收的正文/公开思考有界片段和race_lost原因并入原attempt一次异步终态写，不发给用户、不进上下文、不另计费。正常attempt最多派发/终态两次observe；删除旧首发额外元数据补读，无新cron/轮询。diagnostic保存不阻塞首字，赢家身份仍须持久化才能结算。

新迁移`20261028_first_token_race.sql`扩展现有attempt诊断列并解除禁止首发回赢的守卫，保留数据库单赢家CAS/PT409；Grafana仅获原指标列权限，不能读诊断正文。先本地与TEST验证、合dev，再生产迁移和应用/Admin/看板。回退应用保留诊断列与原账务，不扩权限，不改历史数据。

## 历史轮次分支（2026-10-29，本地实现）

`experience.chat_branch_turns` 保存新会话的局部轮次到原始 `chat_history.id` 的固定引用，冻结分支时实际看到的 revision。`chat_sessions` 增加 `branch_source_session_id`、`branch_source_turn_index`、`branch_source_message_id`、`branch_inherited_turns`、`branch_request_id`。新分支属于独立会话，来源信息仅供身份与溯源，不要求返回来源入口。

service-only `experience.fork_chat_session(uuid,uuid,uuid,uuid,integer)` 验证来源归属、当前 success 且非空回复，截至所选轮取最近 min(A, 可用轮数)，映射为 1..N。幂等键按用户唯一，事务 advisory lock 使用 `conversation-branch:` 用户命名空间，避免跨域读用户表；创建频率为每用户每分钟 10 次，A 硬保护 1..1000。源会话行锁与既有开轮/重生成串行化。只增加会话与引用，不复制 prompt、生成、计费或单独记忆事实。

`session_chat_history` 是 invoker 只读投影：本会话当前生成优先，固定继承引用补齐，暴露 `is_inherited`。仅用于展示和上下文，媒体写入仍查本会话真实 `current_chat_history`。原分析与计费入口不改。继承引用直接指向真实 ID，不递归查询父分支；源软删除、后续重生成不改写既有分支。源历史 FK 使用 deferred NO ACTION 阻止误删，完整账户删除可完成级联。

基础开轮从 `max(本地轮次,N)+1` 开始，基础重生成可在继承最后轮创建真实新 revision，继续复用原 A/B 高低水位。会话展示计数包含继承轮次，真实生成统计不包含继承映射。两个 current-postprocess wrapper 仅将缺诊断表达式改为 `NOT COALESCE(v_previous_exact,false)`；缺行 NULL 回 full，保留原版本绑定与其他逻辑。迁移检查唯一替换锚点及函数 OID/owner/ACL/config 不变。

验收入口覆盖 200→20、200→60/A50、嵌套、窗口推进、普通开轮/重生成、来源独立、权限、四连接并发幂等、异常整笔回滚及账户级联。详细边界见任务 `database-verification.md`。本地隔离验证不代表 TEST/生产已执行。上线顺序为 TEST 验证、生产迁移、Backend、Frontend；分支存在后可隐藏新增入口，但须保留可读取继承前缀的 Backend/RPC 与数据，不能用完全旧 Backend 或删表当作完整恢复方案。

## 单条回复点赞（2026-10-29，本地实现）

`experience.chat_message_likes(session_id,message_id,created_at)` 保存会话主人对固定回复版本的个人反馈；按核心互动状态归属 experience，与角色卡直接点赞分开保存；大厅角色总数通过只读聚合累计两种事实。复合主键保证每会话每版本只有一条；message_id 指真实 history ID，两个同域 FK 删除级联，并有 message_id 索引。RLS 开启，显式撤销默认权限，service_role 仅可 SELECT；唯一权威写入口为 `set_chat_message_like(uuid,uuid,uuid,boolean)`。

RPC 锁定本人未删除会话，验证当前可见、success 且非空回复（含固定继承），以显式 true/false 插入或删除，天然幂等。锁等待 3 秒、声明语句预算 5 秒，SECURITY DEFINER 固定 pg_catalog，禁止 PUBLIC/anon/authenticated 执行。外人/已删除会话返回 P0002；不可见/未完成/失效 revision 返回 P0423。没有用户表跨域读取，没有模型、钱包或会话排序更新。

`session_chat_history` 仅末尾追加 liked，两个 leg 按 session+history ID 读取反馈；只在消息展示投影选择，原上下文查询不选。重新生成的新 history ID 不继承旧点赞，旧版本反馈保留；分支创建不复制反馈，即使固定 history ID 相同，session 不同仍独立。新迁移必须在 conversation_branches 之后执行，不能在 liked 已追加后重跑旧 view 定义。

复用原 `test-conversation-branches-migration.sh` 与 `tests/conversation_branches.sql`，覆盖点亮/取消/重复、权限、普通与继承重生成、分支/嵌套独立、软删阻写、级联、四连接同目标写，以及 EXPLAIN 证明上下文投影不访问点赞表。原分支验收全部保留。测试只使用隔离 PG17 合成数据；迁移未在 TEST/生产执行。应用回退可忽略 liked，保留表/权限/反馈；不必为回退删除用户反馈。

回复点赞计数补充：experience.get_character_reply_like_counts(uuid[])批量返回最多40个角色的所有手动回复赞，miniapp_features.get_character_socials通过该accessor与直接卡片赞相加，保留liked为直接卡片开关。旧版本/独立分支手动赞均计入，取消减回；不复制计数或新增跨域写入。PG用例覆盖多回复累计、幂等、双取消、分支不自动加数、显式分支赞、旧/新revision及批量角色隔离。
