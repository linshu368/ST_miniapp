# Task Breakdown

## Tasks

| ID  | Status | Task                                                          | Files / Scope                                                                           | Depends On | Verification                            |
| --- | ------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------- | --------------------------------------- |
| T1  | Done   | shared 契约：access 配置、PublicFreeZone 新状态、VIP 弹窗载荷 | packages/shared/src/api/free-zone.ts, growth-prompts.ts                                 | -          | shared test + typecheck                 |
| T2  | Done   | 开放判定纯函数 + 单测（时区/边界/重叠/到期/开关关）           | backend features/free-zone/access.ts                                                    | T1         | backend test                            |
| T3  | Done   | 用户事实读取 + 视图/选择/目录/生成接入（失败放行）            | access-facts.ts, zone-view.ts, selection.ts, resolve-model.ts, routes/models.ts         | T2         | backend test + typecheck                |
| T4  | Done   | VIP 弹窗资格与频次（去 50 轮）                                | growth/prompt-rules.ts, routes/growth-prompts.ts                                        | T2         | backend test                            |
| T5  | Done   | 运营平台 access 表单                                          | admin freeZoneForm.ts, FreeZoneConfigEditor.tsx                                         | T1         | admin test + build                      |
| T6  | Done   | 前端栏目卡五种身份 + 状态文字/边界                            | lib/free-zone.ts, chat-free-zone-section.tsx, chat-model-switcher.tsx, chat-top-bar.tsx | T1         | frontend test + typecheck               |
| T7  | Done   | 分隔线                                                        | chat-message-list.tsx, lib/free-zone.ts                                                 | T6         | frontend test                           |
| T8  | Done   | VIP 弹窗并排双券 + 资格刷新                                   | growth-prompt-card.tsx, growth-prompt-host.tsx                                          | T1         | frontend test + 人工                    |
| T9  | Done   | 开通后自动选回畅聊；VIP 页权益行                              | recharge/[orderId]/page.tsx, vip/page.tsx                                               | T6         | 人工                                    |
| T10 | Done   | 文档 + 全量验证 + PR → dev                                    | docs/ARCHITECTURE.md                                                                    | T1–T9      | pnpm -r typecheck / test / lint / build |
| T11 | Todo   | TEST 验收 → 发布分支 → 生产 → CLI 开开关（11-22 00:00 前）    | -                                                                                       | T10        | 线上核对                                |

## Execution Log

- 2026-11-17：规划完成；用户确认产品规则与对比稿（弹窗 A、第二排、提示 B）。
- 2026-11-17：T1–T10 完成。实现中发现 `ChatMessage.model_id` 存的是上游模型名，分隔线改为用新增可选字段 `credits_per_turn`（映射已有 `deduction_rate`，0=免费轮）判断，不改库。验证：shared 241 / backend 1872 / admin 114 / admin-client 32 / admin-cli 24 / frontend 839 测试通过，`pnpm -r typecheck`、`pnpm lint`、lint:complexity / legacy / db-contract / backend-logging、`pnpm -r build` 通过。
