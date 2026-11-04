# Task Breakdown

| ID  | Status | Task                                                          | Files / Scope                                  | Depends On  | Verification                                       |
| --- | ------ | ------------------------------------------------------------- | ---------------------------------------------- | ----------- | -------------------------------------------------- |
| T1  | Todo   | P3-1 纯函数：resolveFirstTokenPolicy、interruptedFinishReason | conversations/generate.ts                      | -           | conversations 测试不改即过                         |
| T2  | Todo   | P3-1 turn control 收拢可变状态与计时器                        | conversations/turn-control.ts, generate.ts     | T1          | lifecycle 16 例不改即过                            |
| T3  | Todo   | P3-1 准备阶段与 prompt 组装提取                               | conversations/turn-preparation.ts, generate.ts | T2          | 同上 + typecheck                                   |
| T4  | Todo   | P3-1 执行 hooks、收口、失败处理提取；编排 ≤120 行             | generate.ts                                    | T3          | 全量 backend test、lint:complexity、测试 diff 为空 |
| T5  | Todo   | P3-1 上线 24h 指标对比                                        | Grafana/Sentry                                 | T4 合并发布 | 首字 P95、6s 无首字率、错误率、对账异常无退化      |
| T6  | Todo   | P3-2 executeGeneration 拆分（GenerationRun）                  | generation/execute.ts                          | T5          | generation 测试不改即过、全量                      |
| T7  | Todo   | P3-2 上线 24h 指标对比                                        | Grafana/Sentry                                 | T6          | 同 T5                                              |
| T8  | Todo   | P3-3 是否拆 peek 的决策                                       | generation/first-token-fallback.ts             | T7 + 一周   | 记录决定                                           |

## Execution Log

- 2026-11-04：规划完成，等待评审。
