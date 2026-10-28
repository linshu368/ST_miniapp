# Shared API 契约目录与规则

## 当前 API 文件

| 文件                         | 领域                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `envelope.ts`                | 通用成功/失败包络                                                                                                                                                  |
| `characters.ts`              | 角色卡列表、详情和运营字段                                                                                                                                         |
| `favorites.ts`               | 收藏操作                                                                                                                                                           |
| `health.ts`                  | 健康检查                                                                                                                                                           |
| `payment.ts`                 | 支付计划、订单和回调相关公开形状                                                                                                                                   |
| `settings.ts`                | 用户/运行配置与 provider schema                                                                                                                                    |
| `word-count-tiers.ts`        | 回复长度档位配置                                                                                                                                                   |
| `lobby-ranking-params.ts`    | 大厅排序参数                                                                                                                                                       |
| `lobby-pinned-characters.ts` | 大厅置顶角色                                                                                                                                                       |
| `wallet.ts`                  | 钱包余额、流水和计费结果                                                                                                                                           |
| `conversations.ts`           | 会话/消息 DTO                                                                                                                                                      |
| `text-postprocess.ts`        | 后处理 source/artifact、Admin 草稿/发布/回滚/request lookup、版本批次与诊断                                                                                        |
| `voice.ts`                   | 语音生成请求、状态和计费响应                                                                                                                                       |
| `growth.ts`                  | 增长/裂变公共模型                                                                                                                                                  |
| `invite.ts`                  | 邀请关系和奖励                                                                                                                                                     |
| `community.ts`               | 官方社群状态与奖励                                                                                                                                                 |
| `models.ts`                  | 可用模型目录                                                                                                                                                       |
| `notifications.ts`           | 通知 DTO                                                                                                                                                           |
| `support.ts`                 | MiniApp 客服会话/消息 DTO                                                                                                                                          |
| `telemetry.ts`               | replay context 与 PostHog 安全事件形状；含 `return_source=webview_resume`、`recharge_entry_clicked`（`replay_context_id` 可选），不含 `user_cohort`/`pay_url`/正文 |

## 设计规则

短剧契约 `api/drama.ts`：列表和详情共享完整剧级文字；新增向后兼容可选 `first_published_at?: string | null`（新 Backend 必返回 ISO 时间或 NULL）。它是可播视频 `created_at` 的最早值，允许存量补录，不能当成真实历史上传证据。`VideoItem` 只承载自身原始元数据，不复用剧级 AI。具体回退和排序行为见[短剧目录契约](../../database/supabase/drama-catalog.md)。

- 请求、响应、分页、错误和 SSE event 使用明确领域命名；字段可选性必须表达真实协议，不为绕过编译器滥用 `?`。
- API DTO 只含业务所需字段，不复制数据库表；日期明确使用 ISO string，金额/credits 明确单位，ID 不混用。
- 不可信 JSON 或跨版本运营配置使用 Zod，并以 `z.infer` 保持类型同源；简单可信编译期形状可用 interface/type。
- 联合类型应有稳定 discriminator。SSE 新事件兼容扩展，consumer 对未知事件安全忽略/记录。
- 错误包络不泄露 SQL、stack、provider secret；可行动错误码稳定，展示文本可演进。

## 可靠性与演进

design 必须列 producer/consumer、旧客户端、部分部署、重试/幂等语义和发布顺序。优先新增可选字段/新联合成员；必须破坏时采用版本化或双读写过渡，并给出回滚。

## 文本后处理契约

- `ChatMessage.postprocess_version` 与 SSE `start.postprocess_version` 为向后兼容可选字段；旧消息缺失按 `NULL`，不得推断为当前版本。
- source 与 compiled artifact 各自固定 schema/policy version。artifact 是发布快照的一部分，不得由 Frontend/Admin renderer 从 source 临时生成。
- Admin mutation 使用 UUID `request_id`、明确 CAS 前提和稳定错误码；`RESULT_UNKNOWN` 表示提交结果未知，不等于失败，也不授权自动重试。
- 版本批次一次最多 20 个去重正整数；每个结果独立为 snapshot/unavailable，单个坏版本不得污染整批，也不得返回 source 或内部诊断正文。
- choice payload 是 renderer 输出的可信纯文本，但 consumer 仍负责“最新完整回复”资格、长度与防双击。

取消文字回复兼容字段（2026-10-26）：CancelConversationTurnRequest.reason?: user_stop | first_token_timeout。请求创建时的服务端策略位决定新旧政策，不以是否省略字段选价；producer必须验证枚举，Frontend手动和总截止分别填写。返回ChatMessage保持原形状，不新增扣费通知字段。

## 历史：可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。

短剧诊断上报契约 `api/drama-timing.ts`：`POST /api/telemetry/drama-timing` 请求为 `DramaTimingReportSchema`（嵌套 strict、有限状态、有限数值、最多 12 个 query/每 query 4 次尝试），响应 `{ accepted: true }`。body 最多 32 KiB，只允许关联 ID/耗时/状态；负查询起点用于进入前在途复用，其他耗时非负。纯函数 `dramaTimingLogFields` 统一浏览器/Railway 字段，媒体 URL/路径/签名/正文不得进入报告。Backend 先于 Frontend 发布。

## 媒体启动诊断契约

1. **Scope / Trigger**：只扩展短剧启动观察的可选诊断，不改变播放业务、API 次数或数据库。
2. **Signatures**：`DramaTimingReportSchema` 增加可选 `media`；公开 `DramaMediaState`、`DramaMediaEvent` 和 `DRAMA_TIMING_MAX_MEDIA_EVENTS=32`。`dramaTimingLogFields(report)` 将 media 原样映射为日志字段。
3. **Contracts**：media 为 `{events, eventsTruncated, snapshot?}`。事件仅允许有限 name、相对入口 atMs、trigger（automatic/user）、error 分类与 state。state 包含 readyState 0..4、networkState 0..3、paused/muted/seeking、非负有限 currentTimeMs/bufferedAheadMs 可选值、visibility（visible/hidden/unknown）。新增首次 marks 为 play_called/play_resolved/play_rejected/loadeddata/canplay。
4. **Validation & Error Matrix**：嵌套全部 strict；超过 32 条、未知字段/枚举或非法状态/耗时返回 400；整个 body 超过 32 KiB 仍返回 413。旧客户端省略 media 接受，旧 Backend 拒绝新字段，因此必须 Backend 先发布；保留原 401/429/503 语义。
5. **Good/Base/Bad Cases**：Good 为带等待事件和即时缓冲的慢报告；Base 为无 media 的旧报告；Bad 为 state 中夹带 URL/token、任意错误消息或非有限 bufferedAheadMs。
6. **Tests Required**：既有 telemetry-contract.test.ts 验证旧/新报告和嵌套拒绝，backend telemetry.test.ts 验证 Pino 映射；frontend 媒体测试覆盖即时状态、截断与迟到隔离；所有 consumers typecheck。
7. **Wrong vs Correct**：错误做法是将缺失状态记为 0、buffered 最远 end 当连续缓冲或上传原始 Error/媒体地址；正确做法是只记录当前位置连续缓冲与固定错误分类，不可读时省略。字段解释和真机场景以 docs/drama-playback-timing.md 为准。

## 客户端首字交付 v4（2026-10-28）

新客户端用 `client_committed_v4` 替换屏幕可见检测：提交动作 → 本轮正文或已开启的公开思考首次提交到 React 消息界面状态。它是业务侧交付口径，不是像素/阅读证明。滚动位置、气泡是否在视口、思考是否折叠均不参与；received 仅供分段排查，不能取消截止。提交时间达到当轮 deadline 即归超时，计时器延迟不能变成超时后的成功。

send/regenerate 携带可选 `first_token_measurement`；后端通过既有 begin RPC 的同一次 INSERT 写入现有 measurement_method，缺报请求仍属于 v4。每轮首次结果不可改写；离页/后台独立终态，生成仍可继续并在返回时恢复。迟到回复可展示但不改写已超时记录。旧 v1-v3 保留兼容，历史独立筛选。

统计复用现有 first_token_visible_ms 列承载按版本定义的时长，不增加表、cron、轮询或逐 token 写入。主指标为前台已知结果的无字时间截断率；成功分布只取截止前已交付样本，离页/缺报及覆盖率同时显示。后台和缺报不能当成功，不用服务端或供应商 latency 填补客户端数据。4秒首发、2秒兜底、10秒总预算和1%目标不因换口径调整。

系统超时免费、免费预留释放；主动停止沿原报价/权益一次结算。计费继续用一次交付结果和服务端持久化终态保障正确性，不依赖滚动/阅读。已结算记录只补调用元数据，不重进计费；归档明细依永久去重返回显式 archived 终态，不重扣、不伪造账单；failed 进入已有有界退避。缺报沿用原预算+15秒保守收口，不增加新计费任务。

迁移为 `20261028_client_committed_first_token.sql`、`20261028_llm_archived_charge_result.sql`，均仅替换既有函数，保留 ACL 和历史数据。先 TEST 验证、合 dev，再生产迁移 → Backend → Frontend/看板。发布证据见任务 release-review；1%是否达成须由上线后的 v4 样本判断。
