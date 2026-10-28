---
module_id: shared.business.conversation-contracts
title: 会话、语音与图片共享契约
scope: shared
category: business
status: active
owners: [shared]
last_verified_task: .trellis/tasks/10-28-first-token-race/
last_verified_at: 2026-10-28
---

# 会话与语音共享契约

## 职责与边界

## 当前状态

取消契约 CancelConversationTurnRequest {assistant_message_id:string} 与 CancelConversationTurnData {message:ChatMessage}；新 POST /api/v1/conversations/:id/cancel 采用既有 envelope，返回实际终态，待确认以错误表示。原 SSE 字段和消息状态兼容保留，producer-first 发布。

## 入口与调用者

## 涉及文件

| 路径                                       | 职责                                   |
| ------------------------------------------ | -------------------------------------- |
| `packages/shared/src/api/conversations.ts` | 会话与 SSE DTO                         |
| `packages/shared/src/api/voice.ts`         | 语音 DTO                               |
| `packages/shared/src/api/models.ts`        | 模型 catalog DTO                       |
| `packages/shared/src/api/images.ts`        | 图片 DTO 与校验                        |
| `packages/shared/src/api/telemetry.ts`     | replay context、支付与图片生成事件契约 |
| `packages/shared/src/index.ts`             | 公共出口                               |

## 关键实现链路

## 数据、契约与外部依赖

仅依赖 Zod；不得暴露数据库 row。`TELEMETRY_FORBIDDEN_PROPERTY_KEYS` 拒绝正文、`pay_url`、initData、token、图片 prompt、图片 URL、Storage path 和 provider request id 的 snake_case/camelCase 变体。
Shared 只定义浏览器可见 DTO、错误码、容量上限和 runtime validation schema，不包含数据库 row、连接串、service-role key、供应商 secret 或原始错误。
图片契约只公开普通图片配置与 `basic_image` 免费次数/结算预览；旧客户端携带的 tier 输入会被兼容剥离。历史 attempt 的 tier 字段暂留只读兼容，不再公开高级图片 capability、门禁错误或双档位配置。

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块

`backend.infrastructure.runtime-data-security`、`database.infrastructure.schema-security`、`backend.business.conversation-generation`、`frontend.business.conversation-ui`、`frontend.infrastructure.client-ui-foundation`。

## 图片创作广场 V2（2026-10-12）

`api/image-plaza.ts` 定义模型目录、配置、瀑布流、作品、会话、报价、attempt、参考图、点赞与分享 DTO/Zod schema。公开模型不暴露 provider model id/internal tags，参考图请求只接受当前用户 artifact id，不接受任意远端 URL。

图片广场提示词长度统一为最多 2000 字，快照、生成提交和前端输入共享同一常量。Civitai Image ID、源 URL 与源热度属于内部导入元数据，不进入公开 feed/detail DTO；对外热度仍使用站内 `like_count`。

图片广场标签配置为最多 80 项的统一图片/视频目录；每项包含稳定 tag id、label、分组 ID/名称/顺序和 chip/grid 布局。旧配置缺少分组时默认归入「风格」组；公开 DTO 暂时保留统一为 image+video 的 `media_types` 兼容字段，供旧 Frontend 混部读取，新 consumer 不得据此拆分目录。

## 变更记录

- 2026-10-28：任务 `10-16-creation-plaza-video-planning` 增加标签分组契约与旧配置/旧客户端兼容默认值。

- 2026-10-13：任务 `10-10-image-plaza-v2` 将提示词上限统一为 2000 字，并明确种子来源字段不公开。

- 2026-09-18：任务 `图片生成 PostHog 接入规划`（`.trellis/tasks/archive/2026-09/09-17-image-generation-posthog-plan/`）写入图片生成 telemetry 事件契约与禁止字段；commit：`7ab4a18ac4924d9a23d35dfc6f4f75be0401c9fe`。
- 2026-10-20：任务 `Remove confirmed repository noise`（`.trellis/tasks/archive/2026-10/10-20-remove-confirmed-repository-noise/`）删除无法恢复的乱码变更记录；commit：`63eee1e847f678f4b2c434f872425a40fc7f891a`。

## Scenario: 对话思考开关与进度流（2026-10-23）

### 1. Scope / Trigger

角色聊天默认请求思考；思考是临时进度，不能变成角色正文或历史上下文。

### 2. Signatures

`SendMessageRequest` / `RegenerateRequest` 追加 `thinking_enabled?: boolean`；SSE 追加 `{type:'reasoning',text:string}`，`start.thinking_enabled?:boolean`。

### 3. Contracts

新UI默认显式true，HTTP缺字段按false兼容旧客户端；`start` 表示请求设置，不保证模型执行或公开思考。每轮转发最多 `MAX_CONVERSATION_REASONING_LENGTH=65_536` 字符。ChatMessage 历史 DTO 不新增思考字段；无新数据库/环境变量。兼容滚动部署：旧客户端未传开关按正文首字处理；新客户端遇旧服务仍可显示正文。

### 4. Validation & Error Matrix

非布尔开关→开轮前400；无公开文本/加密块→不编造；只有思考无正文→既有失败/不扣费；关闭仍返回思考→不向浏览器转发。遵照产品范围，只传平台通用参数，不对强制思考型号新增判断或特殊重试。

### 5. Good / Base / Bad Cases

Good：reasoning进度后delta正文，正文开始自动收起。Base：非推理模型只有delta。Bad：把reasoning拼进content，再用于语音/图片/收费。

### 6. Tests Required

开关默认/非法/send/regenerate、流事件顺序、关闭后意外思考、reasoning-only计费隔离；全消费者typecheck。fixture不能作为真实Provider/扣费或手机键盘实测。

### 7. Wrong vs Correct

Wrong：`{type:'delta',text:reasoning}`。Correct：`{type:'reasoning',text}` 单独消费，正文/后续prompt/历史不变。

首字统一口径：开启深度思考时，真实思考文本首字与正文首字等效，满足原首字放行/截止/观测；关闭只算正文。等待提示、thinking标题、密文占位不计；只有思考无有效正文仍不得扣费。

## 2026-10-23 可运营回复风格

reply-style-options定义内部目录与公开metadata两个strictschema；公开仅id/name/description。两套用户偏好DTO增加optional pref_reply_styles布尔map，PATCH是部分map赋值。id为style-前缀、目录最多24项、偏好最多64键；旧响应缺失兼容。标记与规则不是公开用户数据。

## 主动停止原价与权益结算（2026-10-26）

取消请求显式区分user_stop与first_token_timeout。新业务标记user_cancelled在已冻结报价的生成中按原型号原价格/VIP/免费权益一次结算；免费轮消费免费次数，前端不增加扣费通知。系统超时、上游失败、历史cancelled和未报价取消保持免扣；新请求服务端策略位默认生效，取消CAS RPC按截止与已见观测裁决，不以调用方省略原因选价。免费权益先收口再解锁，钱包按原charge_id后台结算，缺generationId也不重发上游；回捞保留新业务原因及同账单幂等。契约/后端/数据库/前端联动，具体执行证据见本任务release-review。

## 历史：可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。

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
