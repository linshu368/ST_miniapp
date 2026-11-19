# 可执行任务

依赖：[父任务](../11-19-mobile-performance-round2/task.md)证据已完成；本子任务无其他子任务完成前置。共享文件以聊天→角色创作→影像→冷启动审计顺序串行集成，后任务先重读前任务diff；四者都不自动部署。

| ID  | 状态      | 执行项                                                                                                                          | 范围/验证                                                                                                                         |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| CO1 | LocalDone | 在registerConversationDetail的onClose与catch之间建立明确的取消来源判定，只处理已销毁传输的已知abort，使用现有HTTP观测一次终态。 | `packages/backend/src/routes/conversation-detail.ts`、`packages/backend/src/lib/user.ts`、`packages/backend/src/lib/user.test.ts` |
| CO2 | LocalDone | 以现有detail阶段耗时为诊断入口；身份shared-inflight不绑定某个等待者abort，避免一人离页取消他人的身份读取。                      | `packages/backend/src/routes/conversation-detail.ts`、`packages/backend/src/lib/user.ts`、`packages/backend/src/lib/user.test.ts` |
| CO3 | LocalDone | 扩展既有route/identity/会话hook测试验证取消、5秒deadline、真500、并发共享和恢复；真实慢依赖保留err及cause。                     | `packages/backend/src/routes/conversation-detail.ts`、`packages/backend/src/lib/user.ts`、`packages/backend/src/lib/user.test.ts` |
| CO4 | LocalDone | 验证全部失败路径和consumer、日志安全                                                                                            | 见implement.md命令/固定失败场景                                                                                                   |
| CO5 | LocalDone | 执行质量检查、记录本地和真机/发布后边界                                                                                         | 见implement.md命令/固定失败场景                                                                                                   |

Local implementation complete; production acceptance remains pending. See verification.md.
