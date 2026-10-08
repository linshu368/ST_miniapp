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
| `wishes.ts`                  | 心愿功能                                                                                                                                                           |
| `cs-platform.ts`             | Telegram 回访后台 DTO                                                                                                                                              |
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
