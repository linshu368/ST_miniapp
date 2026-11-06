# Task Breakdown

| ID  | Status | Task                                                          | Files / Scope                                  | Depends On  | Verification                                       |
| --- | ------ | ------------------------------------------------------------- | ---------------------------------------------- | ----------- | -------------------------------------------------- |
| T1  | Done   | P3-1 纯函数：resolveFirstTokenPolicy、interruptedFinishReason | conversations/generate.ts                      | -           | conversations 测试不改即过                         |
| T2  | Done   | P3-1 turn control 收拢可变状态与计时器                        | conversations/turn-control.ts, generate.ts     | T1          | lifecycle 16 例不改即过                            |
| T3  | Done   | P3-1 准备阶段与 prompt 组装提取                               | conversations/turn-preparation.ts, generate.ts | T2          | 同上 + typecheck                                   |
| T4  | Done   | P3-1 执行 hooks、收口、失败处理提取；编排 ≤120 行             | generate.ts                                    | T3          | 全量 backend test、lint:complexity、测试 diff 为空 |
| T5  | Todo   | P3-1 上线 24h 指标对比                                        | Grafana/Sentry                                 | T4 合并发布 | 首字 P95、6s 无首字率、错误率、对账异常无退化      |
| T6  | Done   | P3-2 executeGeneration 拆分（GenerationRun）                  | generation/execute.ts                          | T5          | generation 测试不改即过、全量                      |
| T7  | Todo   | P3-2 上线 24h 指标对比                                        | Grafana/Sentry                                 | T6          | 同 T5                                              |
| T8  | Todo   | P3-3 是否拆 peek 的决策                                       | generation/first-token-fallback.ts             | T7 + 一周   | 记录决定                                           |

## Execution Log

- 2026-11-04：规划完成，等待评审。
- 2026-11-04：用户批准 P3；T1–T4 完成。runConversationTurn 504→105 行，generate.ts 758→340 行，新增 turn-control/turn-preparation/turn-scope/turn-execution/turn-repositories；1314 个后端测试不改即过。
- 2026-11-06：P3-1 已于 11-04 16:46 发布（#670，main→dev 同步 #671）。T6 完成：executeGeneration 557→约 110 行，execute.ts 1228→599 行；新增 generation-run（GenerationRun 与准入）、generation-dispatch（请求体、竞速/直连派发、头前失败与非 2xx）、generation-stream（流式消费与结算）；backend 1385 个测试不改即过。T5 指标核对进行中。
