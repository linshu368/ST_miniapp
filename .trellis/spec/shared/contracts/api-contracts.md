# Shared API 契约目录与规则

## 当前 API 文件

| 文件                         | 领域                             |
| ---------------------------- | -------------------------------- |
| `envelope.ts`                | 通用成功/失败包络                |
| `characters.ts`              | 角色卡列表、详情和运营字段       |
| `favorites.ts`               | 收藏操作                         |
| `health.ts`                  | 健康检查                         |
| `payment.ts`                 | 支付计划、订单和回调相关公开形状 |
| `settings.ts`                | 用户/运行配置与 provider schema  |
| `word-count-tiers.ts`        | 回复长度档位配置                 |
| `lobby-ranking-params.ts`    | 大厅排序参数                     |
| `lobby-pinned-characters.ts` | 大厅置顶角色                     |
| `wallet.ts`                  | 钱包余额、流水和计费结果         |
| `conversations.ts`           | 会话/消息 DTO                    |
| `voice.ts`                   | 语音生成请求、状态和计费响应     |
| `wishes.ts`                  | 心愿功能                         |
| `cs-platform.ts`             | Telegram 回访后台 DTO            |
| `growth.ts`                  | 增长/裂变公共模型                |
| `invite.ts`                  | 邀请关系和奖励                   |
| `community.ts`               | 官方社群状态与奖励               |
| `models.ts`                  | 可用模型目录                     |
| `notifications.ts`           | 通知 DTO                         |
| `support.ts`                 | MiniApp 客服会话/消息 DTO        |

## 设计规则

- 请求、响应、分页、错误和 SSE event 使用明确领域命名；字段可选性必须表达真实协议，不为绕过编译器滥用 `?`。
- API DTO 只含业务所需字段，不复制数据库表；日期明确使用 ISO string，金额/credits 明确单位，ID 不混用。
- 不可信 JSON 或跨版本运营配置使用 Zod，并以 `z.infer` 保持类型同源；简单可信编译期形状可用 interface/type。
- 联合类型应有稳定 discriminator。SSE 新事件兼容扩展，consumer 对未知事件安全忽略/记录。
- 错误包络不泄露 SQL、stack、provider secret；可行动错误码稳定，展示文本可演进。

## 可靠性与演进

design 必须列 producer/consumer、旧客户端、部分部署、重试/幂等语义和发布顺序。优先新增可选字段/新联合成员；必须破坏时采用版本化或双读写过渡，并给出回滚。
