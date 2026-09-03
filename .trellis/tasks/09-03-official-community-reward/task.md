# 可执行任务拆分

> 当前全部保持 `Pending`。用户确认 PRD/设计且补齐阻塞配置后，才运行 `task.py start`。

| ID | 状态 | 任务 | 主要文件范围 | 依赖 | 验证 |
| --- | --- | --- | --- | --- | --- |
| T0 | Pending | 确认 Bot 权限、环境群信息、既有成员资格、开关策略 | 本任务 `prd.md` | 无 | 待确认项关闭 |
| T1 | Pending | 定义入口、领取状态与验证响应 shared 合同 | `packages/shared/src/api/community.ts`, shared index | T0 | shared typecheck/test |
| T2 | Pending | migration：claim、update receipt、ledger 类型、原子发奖 RPC、配置 | `packages/shared/migrations/<next>_official_community_reward.sql` | T0 | test DB 重复/并发/回滚/对账 |
| T3 | Pending | 扩展 Telegram client/webhook：chat_member、update 去重、getChatMember | backend bot route/client/feature/tests | T1,T2 | webhook/client/backend tests |
| T4 | Pending | community entry 与主动验证 API，接 runtime config/RPC | backend community feature/routes/app | T1,T2,T3 | backend typecheck/test/路由注释 |
| T5 | Pending | 前端 hooks、Telegram 打开封装、底部 Sheet | frontend api/telegram/profile component | T1,T4 | frontend test/typecheck |
| T6 | Pending | “我的”页接入口顺序、奖励展示、余额/未读刷新 | frontend profile page | T5 | 页面交互与视觉检查 |
| T7 | Pending | 测试环境 Bot/群/webhook/config 配置与 E2E UAT | 运维配置、测试记录 | T2-T6 | UAT、四方对账 |
| T8 | Pending | 生产评审、开关启用、监控和回滚演练 | 发布记录 | T7、经年确认 | 指标正常、无重复发奖 |

## 阻塞关系

- T0 是开发前置门槛；shared 合同必须先于 handler 和 consumer。
- migration 手工执行；代码完成不代表已部署，必须先在测试环境验证。
- T5/T6 可在后端合同稳定后推进，联调依赖测试后端。
- T8 不因测试通过自动执行，必须由经年明确确认。

## 执行记录

- 2026-09-03：完成需求、仓库调研、技术设计和任务拆分；尚未开始产品代码开发。
