# 可执行任务拆分

> 任务已进入实现阶段。代码完成与环境发布分开记录；migration 未在测试库执行前不得视为交付完成。

| ID  | 状态    | 任务                                                                  | 主要文件范围                                                   | 依赖         | 验证                           |
| --- | ------- | --------------------------------------------------------------------- | -------------------------------------------------------------- | ------------ | ------------------------------ |
| T0  | Blocked | 确认 Bot 权限、环境群信息、既有成员基线、开关策略                     | 本任务 `prd.md`                                                | 无           | 缺 chat_id、启用时间和基线导入 |
| T1  | Done    | 定义入口、领取状态与验证响应 shared 合同                              | `packages/shared/src/api/community.ts`, shared index           | T0           | shared typecheck/test 通过     |
| T2  | Partial | migration：claim、update receipt、ledger 类型、原子发奖 RPC、配置     | `packages/shared/migrations/108_official_community_reward.sql` | T0           | 代码完成；待 test DB 验证      |
| T3  | Done    | 扩展 Telegram client/webhook：chat_member、update 去重、getChatMember | backend community route/client/feature/tests                   | T1,T2        | backend 专项测试通过           |
| T4  | Done    | community entry 与主动验证 API，接 runtime config/RPC                 | backend community feature/routes/app                           | T1,T2,T3     | backend typecheck/test 通过    |
| T5  | Partial | 前端 hooks、Telegram 打开封装、底部 Sheet                             | frontend api/telegram/profile component                        | T1,T4        | 编译/hook 测试通过；缺组件测试 |
| T6  | Partial | “我的”页接入口顺序、奖励展示、余额/未读刷新                           | frontend profile page                                          | T5           | 代码完成；待真机视觉检查       |
| T7  | Pending | 测试环境 Bot/群/webhook/config 配置与 E2E UAT                         | 运维配置、测试记录                                             | T2-T6        | UAT、四方对账                  |
| T8  | Pending | 生产评审、开关启用、监控和回滚演练                                    | 发布记录                                                       | T7、经年确认 | 指标正常、无重复发奖           |

## 阻塞关系

- T0 是开发前置门槛；shared 合同必须先于 handler 和 consumer。
- migration 手工执行；代码完成不代表已部署，必须先在测试环境验证。
- T5/T6 可在后端合同稳定后推进，联调依赖测试后端。
- T8 不因测试通过自动执行，必须由经年明确确认。

## 执行记录

- 2026-09-03：完成需求、仓库调研、技术设计和任务拆分；尚未开始产品代码开发。
- 2026-09-03：完成 shared/backend/frontend/migration 主体实现；事务内复核开关、配置金额与活动资格，补齐官方通知文案、前端状态和 webhook 到账轮询。
- 2026-09-03：本地 shared 62/62、backend 390/390、frontend 58/58 测试及三包 typecheck 通过；单一 Community Bot token 调整后 backend 专项 13/13 通过。测试库 migration、真实 Telegram UAT、账务对账及生产发布仍未执行。
