# P3 设计：对话主链路拆分

## 原则

- **只移动，不改写逻辑**：每段代码原样搬进有名字的函数，闭包里共享的可变状态显式变成参数或一个小的状态对象。不顺手"优化"并发、重试或判断条件。
- **顺序即契约**：拆分后逐段对照原函数的 await 顺序与副作用顺序（写观测 → 发 SSE start → 预留额度 → 结算），不允许交换或合并 await。
- **不新建抽象层**：不引入类继承、DI、事件总线；新文件只放在原 feature 目录下，按阶段命名。
- 拒绝的方案：把整条链路改成状态机 / pipeline 框架（收益不抵风险）；统一 Prisma/Supabase 访问（与本任务无关）；改测试来适配新结构（失去行为未变的证据）。

## P3-1：`runConversationTurn`（generate.ts）

现结构是一个 504 行函数，闭包里共享约 15 个可变变量（`readyMs`、`checkpoint`、`observationBegun`、`firstTokenDeadlineElapsed`、计时器、轮询等）。

拆成：

| 新函数 / 模块                                 | 内容（原行号）                                                                                                                                          | 说明                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `prepareTurnInputs()` → `turn-preparation.ts` | 并行取数、准备期截止、`prepareGeneration` 预热（134–184）                                                                                               | 返回模型、用户设置、昵称、平台规则、窗口、预热 promise、chargeId、阶段时间戳 |
| `resolveFirstTokenPolicy()`                   | policy 默认值合并（203–213）                                                                                                                            | 纯函数                                                                       |
| `createTurnControl()` → `turn-control.ts`     | AbortController、首字计时器、110 秒总超时、取消轮询、`recordFirstTokenTimeout`、`readyMs`/`checkpoint`/观测开始状态、`dispose()`（229–323、finally 块） | 把散落的可变状态收进一个对象，供 delta、hooks、失败收口共用                  |
| `emitStart` / `emitVisibleDelta`              | SSE start 与可见增量（221–246、395–410）                                                                                                                | 依赖 turn control                                                            |
| `loadTurnPrompt()`                            | 注册观测 + 上下文 + 角色卡并行读取，组 prompt（332–363）                                                                                                |                                                                              |
| `createExecutionHooks()`                      | `onBeforeDispatch`/`onBeforeReserve`/`onBeforeSettle`/`onStreamOpen`/`onDelta`/`onReasoningDelta`（412–465）                                            |                                                                              |
| `settleExecutedTurn()`                        | execute 之后的 finalizeTurn、状态映射、未开流时的结果映射、done、诊断与收口日志（467–565）                                                              |                                                                              |
| `failTurn()`                                  | catch 块：首字超时标记、清理待确认、finalizeTurn、超时时补发 start（566–628）                                                                           |                                                                              |
| `interruptedFinishReason(row)`                | 4 处重复的 `cancelled/user_cancelled/timeout` 判断                                                                                                      | 纯函数，消除重复                                                             |

拆后 `runConversationTurn` 只剩：准备 → 开轮 → 建 control → try { 组 prompt → execute → settle } catch { failTurn } finally { dispose }，约 80–100 行。

## P3-2：`executeGeneration`（execute.ts）

引入一个**调用内**的上下文对象 `GenerationRun`（`request`、`hooks`、`log`、`signal`、`chargeId`、`billing`、`reservation`、`releaseReservation`、`finish`、`failed`），只在单次调用内存在，替代闭包共享。

| 新函数                       | 内容（原行号）                                                   |
| ---------------------------- | ---------------------------------------------------------------- |
| `assertPreparedIdentity()`   | 预热结果身份校验（367–378），纯函数                              |
| `admitPaidRound()`           | 计费方案、VIP 门槛、余额预检，返回 plan 或拒绝结果（427–484）    |
| `resolveUpstreamOrFail()`    | 上游/密钥解析与缺 key 失败（488–507）                            |
| `dispatchUpstream()`         | 首发/兜底竞速或直连派发与异常收口（543–681）                     |
| `consumeStreamingResponse()` | settleOnce、首字记录、SSE tap 与 pipeline、流中断收口（760–882） |

`executeGeneration` 保留：取预热 → 身份校验 → 预留额度 → try { 准入 → 上游 → onBeforeDispatch → 派发 → 非 2xx/非流/空 body 分支 → 流式消费 } catch { 中止前结算 / 释放 }，约 100–120 行。

## P3-3：`forwardWithFirstTokenFallback`（first-token-fallback.ts）

主体是两路请求竞速，共享状态最多、并发最敏感。初步方案：只把 215 行的 `peek`（读取一路 SSE 直到第一个可见 token）提取为独立函数，依赖以显式回调传入；竞速协调保持原样。P3-1/P3-2 上线稳定一周后再决定是否做。

## 可靠性与验证

- 故障模型：拆分最可能引入的错误是闭包变量被拷贝成值（状态不同步）、await 顺序变化、finally 清理遗漏。对策：可变状态只存在于 turn control / GenerationRun 一个对象里并按引用传递；逐段对照原 diff；现有 23 个（turn）+ 39 个（execute）+ 21 个（首字竞速）单测不改即通过，其中 lifecycle 测试覆盖取消、超时、余额不足、上游失败、并发重生成。
- 无法本地覆盖：真实上游 SSE 节奏与 Railway 实例行为。PR 预览后端（Ensure pr-N）当前 CI 基础设施失败，靠上线后指标观察兜底。
- 发布：每个子 PR 合 dev 后随正常发布进生产；上线后 24h 对比首字 P95、6 秒无首字率、Sentry 错误率、计费对账异常；退化即 revert。
- 迁移/数据：无。回滚：revert 对应 squash commit，无数据影响。
