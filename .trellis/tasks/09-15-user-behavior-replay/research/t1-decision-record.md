# T1 书面确认记录

确认时间：2026-09-15  
确认会话：执行阶段 AskQuestion；需求方声明自己为隐私责任人。  
状态：**T1 完成。** `user_cohort` 本期跳过，留作后期精细化检索，不阻塞 T2。

本文只记录已批准决策。未勾选项不得由实现自行补全。

## 已确认

### 隐私例外

- 隐私责任人：需求方（本任务确认会话）。访问审计责任人与到期删除责任人与其同一人。
- 批准完整聊天正文出现在 **Session Replay 画面** 中，覆盖：
  - 即将接入的 PostHog Session Replay；
  - 现有 Sentry Session Replay（维持 `maskAllText: false`、100% 采样，本期不改）。
- 该例外已授权更新 `.trellis/spec/frontend/app/api-dataflow-and-state.md`。
- 事件属性、应用日志、Sentry 事件（非 replay 画面）、错误上报仍禁止携带用户输入、模型回复、完整 initData、`pay_url`、支付表单、token/secret 或错误 response body。
- 支付密码、账号、验证码、银行卡/支付账号仍须 browser-side 屏蔽。

### 区域、访问与保留策略

- PostHog 云区域：**US Cloud**。
- 数据处理：采用 PostHog US Cloud 标准处理条款；项目级 DPA 文件与套餐能力截图的互证放 **T7**，不在 T1 伪造已验证。
- 访问角色：仅产品与工程；回放/含聊天正文的导出、共享、下载按同一审批约束。
- Session Replay 保留策略：**以当前 PostHog 套餐上限为准，到期自动删除**。
  - **当前项目为 Free 套餐，最长 30 天。** 不得把 60 天写成当前能力、验收项或已开通开关。
  - 2026-09-15 早先讨论过 60 天上线策略；同日需求方确认免费套餐无法提供 60 天，该目标仅在升级付费套餐后才可能。T7 只核验 **30 天到期删除**（及套餐设置截图），不核验 60 天。
- 100% 录制：上线要求。手动 `startSessionRecording` 不得被项目级 sampling/ingestion control 丢弃；项目级互证放 **T7**。不得自行降采样。

### Idle 超时

- 时长：**15 分钟**。
- 仅在用户没有输入、点击、滚动、可见页面活动，且当前没有流式生成时计时。
- 流式回复进行中、lifecycle 处于 `external_payment_pending` 时，不因 idle 结束 context。
- 正常离开聊天、`pagehide`（非付费墙延续）与 idle 超时结束 context；余额不足进入充值/邀请/订单结果页不结束 context。

### 双录制

- 保留现有 Sentry Session Replay；接受与 PostHog 双录制。
- PostHog 是本期产品检索与付费墙证据通道；Sentry Replay 继续排障。本期不关闭、不降采样、不替换 Sentry Replay。

## 本期跳过

### `user_cohort`（新/老用户）

2026-09-15 需求方确认：本期不做该标签，作为后期精细化检索待办。因此：

- replay context / 事件契约 **不得** 包含 `user_cohort`、`user_cohort_version`。
- 不得把邀请绑定的 30 分钟新用户窗、客服 `total_round > 40` 默认 SQL，或钱包 `first_paid_at` 当成分析分群。
- 本期用户标签仅保留服务端 `is_paid_user` 与 `total_chat_rounds`。

## 明确不在 T1 伪造的互证

以下仍属 T7 / 实施前剩余门禁，不因本记录变成已验证：

- 目标项目 Session Replay 采样率 100% 的项目设置证据；
- `posthog-js` 具体版本与 Next.js/Telegram WebView 兼容性（I3，T4 已记录 SDK 版本；WebView 真机仍属 T7）；
- 当前 Free 套餐下 Session Replay **30 天**到期删除的项目设置与套餐能力截图（不是 60 天）。

2026-09-15 T7：需求方确认**无隔离 test 项目**；项目 `610481` 用于 Preview 验收与日后生产，接受初期遗留数据。该项不再作为 T7 停止条件。Production 配置启用仍须 30 天 / 100% / 敏感字段 / 支付 `order_id` 互证。书面记录：`research/t7-verification-record.md`。
