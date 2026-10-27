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


## 可恢复交付协议 v3（2026-10-27）

本节取代旧版“当前未可见→自动取消/免单”的运行规则。后端4秒首发、2秒兜底、10秒总首字预算仍由正式配置决定；模型在预算内选中有效首字后立即放行，意图/身份持久化与传输并行，结算前必须确认。断连写入返回false，不冒充客户端已收到；断连不终止生成。

客户端v3记录真实接收/显示时间，收到后视口未显示不触发取消；hidden/page_left是观测中断，返回实际显示可更新记录且保留后台标记。前台超过预算未收到的事实锁存，不因后续可恢复而抹除。新策略拒绝旧页面的first_token_timeout取消指令；真实截止由生成服务控制，明确user_stop仍走原价一次结算。

回复恢复复用有权限的会话详情与原活动轮询。活动快照最多128轮、125秒，每轮正文256Ki字符/公开思考64Ki字符，按user/session/revision隔离；一次first_token_preview检查点最多2048字符，最终正文仍由chat_history持久化。跨实例/进程重启读取检查点和最终结果，不宣称进程内快照持久。公开思考不写入正文或后续prompt。

recoverable_delivery仅新Backend显式启用；旧请求/终结账单不回填、不追扣。离页/后台已完整保存且可取回的正常回复不免单；真实系统截止/前台无接收超时免费，主动停止原报价原权益一次。缺回报继续pending，预算+15秒仍缺报按保守免单处理，避免服务端完成先扣费而客户端随后报告失败。只有思考无完整正文不自动收费。内部billing gate复用visible返回值表示已满足该轮交付策略，并非声称用户当时正在看。

唯一新增迁移20261027_recoverable_chat_delivery.sql：experience拥有策略/首字检查点，billing资格函数读取事实；analytics只追加无正文的策略/时刻/失败锁存字段。无新cron、逐token数据库写、业务回填或公开权限。先TEST、后生产迁移、后Backend/Frontend。回退保留新增对象和终账，必要时forward-fix。

验证：本任务release-review记录自动化、真实PG、TEST流/浏览器和生产版本证据；测试通过不等于线上1%目标已达成。看板v3区分前台等待超时与系统无首字截断，显示分布只用浏览器业务侧实际时长，后台/缺报不填0。
