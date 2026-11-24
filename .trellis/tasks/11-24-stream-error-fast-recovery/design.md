# 技术设计

## 改动

| 位置                                                       | 内容                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/generation/upstream.ts` `createSseTap`           | 新增可选回调 `onFailed`：一个网络包处理完后，若已见错误块或 `content_filter` / `error` 结束原因，触发一次。放在整包之后，保证同包里的用量、`[DONE]` 已读到                                                    |
| `features/generation/stream-pass.ts` `runStreamPass`       | `stallMs` 非空（中断兜底开着）时，`onFailed` 掐断这一路；`classifyEnd` 对主动掐断的不再因「没有 `[DONE]`」误记 `disconnected`，而是按错误块 / 结束原因记 `stream_error` / `content_filter` / `provider_error` |
| 同上（第 4 条）                                            | 卡顿计时到点时，若已见 `stop` 或 `[DONE]` 且没有错误块 → 记 `completed`，`result.completed = true`                                                                                                            |
| `features/generation/generation-stream.ts` `logPrimaryEnd` | 加 `tail_gap_ms`（第 5 条）                                                                                                                                                                                   |
| `platform/observability/safe-log.ts`                       | 放行 `stream_end` `skip_reason`（枚举文本）、`visible_chars`（数字）（第 5 条）                                                                                                                               |

## 影响面

- `runStreamPass` 有两个调用方：首发（胜出那一路）与出字后重写那一路。重写那一路收到报错也会提前结束，兜底不再兜底不变。
- Surplus 调用记录：提前掐断的报错轮 `call_status` 由 `completed` 变为 `interrupted`（与卡顿掐断一致）。代码里没有按这两个值分支的读者；
  错误码、用量在同一个包里时已记下；不在时由现有的请求记录补取任务补齐。
- 计费：救回的轮次沿用首发 `generationId` 取供应商元数据，与卡顿掐断同一条路。Venice 的用量在流尾，提前掐断会缺用量——
  与现在卡顿掐断相同，且这类轮次由兜底交付。
- 指标 `st_chat_turns_total`：分类不变（都属中断 / 拒答）；第 4 条会让被误判的轮次从中断回到成功。

## 可靠性

- 超时：不新增；卡顿阈值仍是没有报错时的上限。重试：不新增，兜底仍只一次。
- 并发：掐断用 AbortController，用户停止 / 字数上限优先级更高，顺序不变。
- 降级：关 `interruption.enabled` 即回到现状（不提前掐断）。

## 拒绝的方案

- 报错后不掐断、后台继续读完：能保住尾部用量，但要多维护一条后台读流与收尾时机，收益小。
- 收到 `[DONE]` 就断开所有正常流：会影响全部正常轮次的 Surplus 记录，风险大于收益。

## 发布与回滚

feature → dev → 从 main 拉发布分支 → main，只有后端。无表、无配置改动。回滚 = 回退代码；应急可关 `interruption.enabled`。
