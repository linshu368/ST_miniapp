# 可执行任务

依赖：[父任务](../11-19-mobile-performance-round2/task.md)证据已完成；本子任务无其他子任务完成前置。共享文件以聊天→角色创作→影像→冷启动审计顺序串行集成，后任务先重读前任务diff；四者都不自动部署。

| ID  | 状态      | 执行项                                                                                                                                                                      | 范围/验证                                                                                                                          |
| --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CO1 | LocalDone | 先重用6个已查询启动诊断做阶段分类并取得可重现响应头；C196... Android script_max_fetch_ms=4201、efca...=7361，iOS两条connect_to_request约5135/5168ms，明确两类独立故障模型。 | `packages/frontend/next.config.mjs`、`packages/frontend/src/app/providers.tsx`、`packages/frontend/src/lib/perf/startup-phases.ts` |
| CO2 | LocalDone | 核对构建chunk与Providers静态依赖树；仅在证实阻塞时移动可选reader/监控模块到已有afterFirstScreen/enrich点，保留shared query与取消。                                          | `packages/frontend/next.config.mjs`、`packages/frontend/src/app/providers.tsx`、`packages/frontend/src/lib/perf/startup-phases.ts` |
| CO3 | LocalDone | 按@startup现有fixture检查root alias/cookie/History/支付回流；同负载构建比较与真机观测分别留证。                                                                             | `packages/frontend/next.config.mjs`、`packages/frontend/src/app/providers.tsx`、`packages/frontend/src/lib/perf/startup-phases.ts` |
| CO4 | LocalDone | 验证全部失败路径和consumer、日志安全                                                                                                                                        | 见implement.md命令/固定失败场景                                                                                                    |
| CO5 | LocalDone | 执行质量检查、记录本地和真机/发布后边界                                                                                                                                     | 见implement.md命令/固定失败场景                                                                                                    |

Local implementation complete; production acceptance remains pending. See verification.md.
