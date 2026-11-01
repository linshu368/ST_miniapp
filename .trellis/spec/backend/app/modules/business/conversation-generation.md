---
module_id: backend.business.conversation-generation
title: 会话与生成
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/10-30-image-plaza-edit-400-compat/
last_verified_at: 2026-10-30
---

# 会话与生成

## 职责与边界

## 当前状态

文字回复新增基于数据库标记的显式取消；生成计费前抢占没有取消标记的 streaming 终态。取消先释放免费额度，再确认 interrupted；上下文/上游异常统一恢复，详情读取回收过期生成。执行副本未确认时取消返回可重试待确认。无需 migration，真实 TEST/Preview SSE、钱包/额度及真机验收仍未执行。

AI 回复后处理版本由数据库 current-postprocess RPC 在开轮事务内读取正式指针、校验不可变快照并绑定；成功必返回非空版本。配置/RPC/快照异常在 LLM、计费和 SSE 之前拒绝开轮，不再由 Backend 冷启动缓存降级成永久 `NULL` 消息。

自研会话链路已上线。图片生成代码已落地但 runtime 开关默认关闭：当前只保留单一普通图片路径，由 DeepSeek 写中文分镜或保留用户中文稿，在 worker 中直译英文后优先调用 Grok/Liaobots，主通道失败时以相同内容降级到 Replicate Z。普通图片继续使用 `basic_image` 免费次数，耗尽后按普通价格结算；高级图片入口、provider 分流、VIP 门禁与高级价格已退场。图片 telemetry 与结算未知语义保持不变。

## 入口与调用者

## 涉及文件

| 路径                                                                                | 职责                              |
| ----------------------------------------------------------------------------------- | --------------------------------- |
| `packages/backend/src/routes/conversations.ts`                                      | HTTP/SSE 入口                     |
| `packages/backend/src/features/conversations/`                                      | 轮次编排                          |
| `packages/backend/src/features/generation/`                                         | 生成与计费出口                    |
| `packages/backend/src/features/text-postprocess/config.ts`                          | Admin 正式版本指针严格读取        |
| `packages/backend/src/infrastructure/repositories/ConversationHistoryRepository.ts` | current-postprocess 开轮 RPC      |
| `packages/backend/src/features/image/`                                              | 图片任务编排与 telemetry observer |
| `packages/backend/src/features/image/ImageGenerationTelemetry.ts`                   | 图片生成安全事件 observer         |
| `packages/backend/src/routes/images.ts`                                             | 图片 HTTP 入口                    |

## 关键实现链路

图片链路为“ownership/回复资格 → 普通图片免费名额预留或付费预检 → 中文稿 → pending attempt → DB 租约 → DeepSeek 直译 → Grok（失败则 Z 降级）→ Storage → `settle_image_generation` 原子消费免费次数或扣费并置 current ready”。旧客户端的 tier 输入被兼容忽略，新 attempt 固定为 basic。

## 数据、契约与外部依赖

OpenRouter mapper、计费读取和回捞仓储统一使用专表的厂商原名字段；`llm_generation_id`、`llm_generation_data` 为明确保留的例外。主表 `recordBillingOutcome` 显式接收金额、结算时间和业务结束原因，禁止复用并修改 OpenRouter 元数据对象承载计费列。`usage_cache` 可缺失，不作为元数据完整性的必需条件。Venice 的 mapper/repository 不参与本次命名调整。原名代码需先执行 `20261016_openrouter_original_metadata_fields.sql`；远端未执行前不能部署。

消费 shared conversations/images/telemetry 契约、experience 会话与图片 attempt、OpenRouter、DeepSeek、Grok/Liaobots、Replicate Z、Supabase Storage 和服务端 PostHog capture。

## 关键节点与约束

流前错误使用 HTTP；响应头发出后使用流内 error。聊天与图片上游适配不得旁路 `features/generation`。图片 provider 前租约可恢复；Grok 失败只允许切换一次 Z，Z dispatch 后结果未知必须失败关闭。结算明确余额不足删除对象，结算响应未知则保留对象和 storing 状态待幂等对账，且不发送 PostHog 终态事件。事件不得包含 prompt 正文、图片 URL、Storage path、provider request id 或错误 body。

## 验证方式

`pnpm --filter @miniapp/backend typecheck && pnpm --filter @miniapp/backend test`；真实上游、PostHog Preview 和 SSE 缓冲使用可重复人工回归，已删除的 `mvp:regression` 不再使用。

## 已知缺口与待核验项

本地已实现主表调用字段清退：正常读写为显式业务投影，finalizeTurn 不接收调用 ID，上游前 await 快照/专表占位、首次 ID 持久化；已接收 SSE/非流式正文在 metadata 失败时仍保留。五路恢复消费对应专表身份/已存事实，业务取消/超时与计费归属保持。未部署，真实环境验收见任务 T8 报告。

角色卡更多人设字段和自建预设格式仍待后续任务；图片真实 DeepSeek/Grok、Storage、重启/并发、PostHog Preview 事件与发布观测仍待 test 环境验收。

## 关联模块

`frontend.business.conversation-ui`、`backend.infrastructure.runtime-data-security`、`shared.business.conversation-contracts`、`database.business.conversation-storage`。

## 图片创作广场 V2（2026-10-12）

`features/image-plaza` 是图片创作广场的独立任务域，不复用聊天 `features/image` attempt。链路为报价快照 → 幂等受理 → worker 租约 → Venice 单次写调用（明确超时、不自动重试）→ 私有 Storage → 原子结算；上游结果不确定时进入 `failed_unknown` 且不扣费。

Venice 单图编辑按报价快照的 `sizingMode` 组装尺寸字段：所有编辑请求保留 `aspect_ratio`，仅 `resolution` 模式且档位为 `1K`/`2K` 时发送 `resolution`；`aspect_ratio`/`pixels` 模式的内部 `fixed` 占位不得改写为上游 `1K`。明确非 2xx 仍单次失败且不进入图片结算。

审核后的 Civitai 初始数据通过独立离线导入器进入公开作品，不伪造用户、会话或生成 attempt。导入保留最多 2000 字原始提示词与模型映射，超限行隔离且不截断；apply 必须同时提供逐条审核清单、明确 test/production 目标、原图存储确认和有限批次，生产还需额外确认。

Feed/config 始终返回图片与视频共用的启用标签目录及分组元数据；单标签、多标签和计数都按标签中文 label 在 `snapshot.prompt_zh` 做转义后的字面包含匹配，多标签为 OR，再与 search/media 取交集，不按作品 `tags` 数组筛选。「全部」不限制标签。`image_plaza_tags_feature_enabled` 只控制分享时空 tags 的自动打标。

视频创作复用该模块的会话与公开作品投影，但走独立 `video-repository`、`video-upstream`、`video-job`：提交只预扣并返回 202，queue 超时记 `failed_unknown` 且不自动重投；retrieve/download/complete 仅做有限安全重试。视频不调用 LLM 提示词优化。列表 DTO 不含 MP4，详情/工作室签名 URL 复用 `storage.ts` 的有界 LRU。

## 变更记录

- 2026-10-28：任务 `10-16-creation-plaza-video-planning` 统一图片/视频标签目录，并将多标签与计数收口到 `prompt_zh` ILIKE。

- 2026-10-30：任务 `10-30-image-plaza-edit-400-compat` 修复固定尺寸 Venice 编辑请求的 `resolution` 兼容，并保持 resolution 模型原有档位语义。
- 2026-10-15：任务 `10-15-image-plaza-tag-prompt-filter` 解耦标签展示与自动打标，feed 标签筛选改为 `prompt_zh` 中文包含匹配。
- 2026-10-13：任务 `10-10-image-plaza-v2` 增加经审核初始作品的离线导入路径与 apply 门禁。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片描述/受理/worker 终态 PostHog observer；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## Scenario: 两平台思考参数与流解析（2026-10-23）

### 1. Scope / Trigger

新增默认开启的对话思考开关，仍只有generation一条生成/计费出口。

### 2. Signatures

`GenerationRequest.thinkingEnabled?:boolean`、`GenerationHooks.onReasoningDelta`、`createSseTap.onReasoningDelta`；route传递本轮值，HTTP缺字段按false兼容旧客户端，新UI默认显式true。

### 3. Contracts

OpenRouter：`reasoning:{enabled,exclude:!enabled}`；Venice：`reasoning:{enabled}`与`venice_parameters:{include_venice_system_prompt:false,disable_thinking:!enabled,strip_thinking_response:!enabled}`，stream继续请求usage。不开新模型目录/特殊重试。SSE读取reasoning_content/reasoning或可读details，忽略encrypted/signature及官方加密占位；同轮出现结构化思考后不重复转发旧标签内容。只识别正文前导think区，跨chunk标签/UTF8可拆分，正文中的后续字面标签保留。

### 4. Validation & Error Matrix

非法bool开轮前400；上游非2xx保留既有拒绝/释放预留，不传原始错误正文给hook；首次provider ID仍先持久化再转发。关闭不发送思考；每轮思考最多64Ki字符，不保存到snapshot.content/DB/日志。普通模式保留4秒单次兜底，深度思考模式不启动快速兜底；两种模式的6秒阈值都只记录首字SLA超时，不主动取消或中断上游，并受110/120秒绝对期限和显式取消约束。只读准备使用独立20秒有限预算。取消、绝对超时与身份写失败不重放生成；只有思考不得触发完成结算或消费免费额度；首字选择/放行独立于最终有效正文判定。

### 5. Good / Base / Bad Cases

Good：思考→正文→DONE/stop，按原正文交付结算。Base：只正文。Bad：将reasoning_tokens再加到completion_tokens重复计费；把reasoning-only认定成功；流后自动重试。

### 6. Tests Required

现有upstream/execute/lifecycle与route回归：双平台on/off、默认、非法值、UTF8字节拆分、前导think拆分/正文标签保留、结构化+标签去重、密文、思考上限、ID-await销毁、只有思考无正文不扣费。

### 7. Wrong vs Correct

Wrong：`replyChunks.push(reasoning)`。Correct：思考只进`onReasoningDelta`，`content/deltaCount`只统计正文，原`[DONE]+可见正文+stop`计费条件保持。

首字统一口径：开启深度思考时，真实思考文本首字与正文首字等效并完成首字观测；静默思考跨过快速SLA时只记超时事实，不触发fallback或取消。关闭只算正文并保留4秒单次fallback，但6秒同样只观测、不终止。等待提示、thinking标题、密文占位不计；只有思考无有效正文仍不得扣费。

## 2026-10-23 可运营回复风格

展示feature reply-style-options仅从runtime-config读取已发布目录，GET/PATCH严格投影id/name/description。用户pref_reply_styles默认{}，部分map只走service_role invoker RPC原子合并；公开HTTP/SSE、日志与Engine不接收marker/rules。该功能只负责UI目录与用户选择。

## 主动停止原价与权益结算（2026-10-26）

取消请求显式区分user_stop与first_token_timeout。新业务标记user_cancelled在已冻结报价的生成中按原型号原价格/VIP/免费权益一次结算；免费轮消费免费次数，前端不增加扣费通知。系统超时、上游失败、历史cancelled和未报价取消保持免扣；新请求服务端策略位默认生效，取消CAS RPC按截止与已见观测裁决，不以调用方省略原因选价。免费权益先收口再解锁，钱包按原charge_id后台结算，缺generationId也不重发上游；回捞保留新业务原因及同账单幂等。契约/后端/数据库/前端联动，具体执行证据见本任务release-review。

## 历史：可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。

## 首发明确失败立即兜底（2026-10-27）

首个可见 token 前，HTTP 非 2xx、连接/读取异常、空 EOF/DONE、流内 error、refusal 或无输出 finish_reason 立即进入同一条单次兜底流程，不等首发阈值，也不等结束帧后的连接关闭。先看到公开思考或正文则保留该模型，不混入另一模型；显式取消、全局截止和观察期限终止不触发重试。首发型号等于兜底时，明确失败允许一次顺序重试，静默等待仍不并发重发相同型号。切换清掉旧首发计时器，兜底仍受自身2秒和原总10秒预算约束。失败观测复用原 attempt；报价/权益/charge_id 沿用用户选择，成功一次结算、两次失败免扣，不新增表、统计任务或 API。验证由 first-token-fallback.test.ts 和 execute.test.ts 覆盖双平台、付费/免费及取消/期限竞态。

## 聊天准备阶段减负（2026-10-27）

取消轮询只取 status,llm_finish_reason；新轮身份写入与历史上下文读取并行，prompt 快照保存与独立定价/权益准备并行，真正派发前仍 await 身份、快照、报价。首字观测/检查点/供应商补录不阻塞显示，结算继续等待必要的交付事实。4/2/10 秒与计费语义不变。

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

## 从历史回复开启分支（2026-10-29，本地实现）

`POST /api/v1/conversations/:id/branch` 接受严格 UUID `{message_id, request_id}`，身份来自认证，不接收客户端用户 ID 或上下文轮数。后端读取现有 `fetchContextWindowLimits().retainTurns`（A），调用 `experience.fork_chat_session`，原子验证本人会话、当前可见的已完成回复及请求幂等性。分支截至所选回复保留 `min(A, 可用轮数)`，轮次归一化为 1…N；后续新轮继续使用原 A/B 窗口规则。没有独立记忆抽取：各轮正文中的记忆随该轮继承，所选回复之后的内容不得进入分支。

分支通过 `experience.chat_branch_turns` 固定引用真实 `chat_history` 行，不复制生成、计费或统计记录；再次分支直接展开固定引用。新 `session_chat_history` 只用于消息分页和入模上下文，显式投影业务列；本会话新 revision 覆盖同轮继承引用。`current_chat_history` 仍是实际生成与媒体写入的来源，`findCurrentTurnById` 不改用叠加视图。

响应沿用 `GetConversationData`，初始最多最近 25 轮，更多内容由原分页读取；普通开场白和后处理版本语义保持。`ChatSession.branch` 提供来源轮次和继承数量，`ChatMessage.inherited` 标记继承消息，继承消息不暴露来源请求 ID，也不开放来源消息的生图/语音写入。创建不调用模型、不扣费、不消耗免费额度；历史正文及原请求内容不进入分支事件日志。

RPC 与列表读取设 5 秒请求预算；UUID 校验失败返回 400，源不存在或非本人统一 404，不可分支/请求冲突返回 409，创建频率限制返回 429。返回使用 `Cache-Control: no-store`。同一请求 ID 重试恢复已创建的分支，即使首次响应丢失或来源随后被软删；前端只手动重试，不自动创建循环。

验证扩展既有上下文、后处理与错误码测试，并补充分支路由边界和本地 SQL 回归；本节不表示已发布。发布必须先执行新增 migration，再发布 Backend/Frontend；回退应用时保留新增对象和用户分支数据。

## 回复点赞（2026-10-29，本地实现）

`PUT /api/v1/conversations/:id/messages/:messageId/like` 接受严格 `{liked:boolean}`，认证用户由后端传入 `experience.set_chat_message_like`。RPC 以会话归属及当前可见回复版本为边界，包含分支继承回复；显式目标值使重复提交幂等。不存在或非本人会话统一 404，失效或未完成回复返回 `reply_like_not_allowed`（409）。响应只含 `session_id/message_id/liked`，设置 `no-store`，仓库调用有 5 秒预算，日志不包含正文或 prompt。

反馈存储于 `experience.chat_message_likes`，按会话和实际 history ID 隔离。消息列表从既有叠加视图一次读取 `liked`，只投影到 assistant 消息；上下文查询不选该字段，不影响模型输入、会话排序、角色卡热度或钱包。重生成新版本不继承旧赞，创建分支不复制来源会话的赞。迁移顺序为分支迁移 → 点赞迁移 → Backend → Frontend；新增点赞迁移执行后不得再重跑会删去其末列的旧分支视图定义。应用回退可忽略新增字段，保留反馈事实。
