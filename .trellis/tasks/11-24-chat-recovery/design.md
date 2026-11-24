# 设计：出字后兜底（擦掉重写）

## 1. 位置与边界

- 首字竞速（`first-token-fallback.ts`）不动：出字后 `consumeStream`（`generation-stream.ts`）接手。
- `stream-pass.ts`：读一路流给用户，同时做卡顿看门狗与拒答检测，给出结束方式（`StreamEnd`）。
- `stream-recovery.ts`：是否兜底、兜底调用、擦除时机、结算用的合并结果、台账。
- `chat-recovery-config.ts`：托管配置读取（进程内缓存 30 秒，过期先用旧值后台刷新；准备阶段预热）。
- 兜底调用复用 `generation-dispatch.ts createForward`（`createRecoveryForward`）：首字兜底同一模型与供应商偏好，关闭思考展示（`thinkingEnabled: false`）。

## 2. 识别（我方规则，不等供应商事后元数据）

| 结束方式                                       | 来源                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `stalled`                                      | 看门狗：可见增量（正文、已显示的思考）间隔达到 `stall_ms` 即掐断                  |
| `stream_error`                                 | 流内 `error` 块（`createSseTap` 新增 `streamError`）；Surplus `x-si-truncated` 头 |
| `content_filter` / `provider_error` / `length` | 流内 `finish_reason`                                                              |
| `disconnected`                                 | 无 `[DONE]` 断开                                                                  |
| `refused`                                      | 正文前 `check_chars` 字命中词池（`createRefusalDetector`，只判定不压输出）        |
| `cancelled` / `output_cap` / `completed`       | 用户停止或执行截止 / 5400 字上限 / 正常                                           |

卡顿与「很慢」在当下无法区分：按用户要求接受误判；`max_gap_ms` 写日志，用来回看误伤。

## 3. 兜底

- 触发：`refused`（拒答开关）或中断五类（中断开关），且距 110 秒执行上限 ≥ 20 秒。
- 一律按原 messages 重写（用户否决续写；另：2026-11-24 实测 assistant prefill 在 Together 上输出乱码，续写指令方式可用但已不需要）。
- 擦除时机：兜底第一段正文发出前调用 `hooks.onReset` → 清空进程内交付缓存（重连恢复用）并下发 SSE `{type:'reset'}`；5400 字上限重新计。兜底没出字就失败 → 不擦。
- 兜底 `fallback_first_token_ms` 内没出正文 → 放弃；兜底这一路有卡顿看门狗、不做拒答检测（兜底不再兜底）。
- 未成年人：拒答命中时查「已看到的前 N 字 + 上一条回复 + 用户原话」，涉及则不掐断照常输出；`content_filter` 时查「已输出正文 + 同上上下文」，涉及则不重写；其它中断不查。上下文不用最后一条 user 消息（平台规则被 `wrapUserInput` 包在里面，含未成年人限制文字）。

## 4. 结算与计费

- 救回（兜底 `completed` 且有正文）：落库内容 = 重写正文，`generationId`/用量沿用首发（交付身份不变），走 success 分支正常扣费。
- 没救回：按中断免扣；落库内容 = 用户屏幕上留着的（擦过 → 兜底已输出部分；没擦 → 首发内容，含拒答原文）。`finish_reason`：`stalled` / `refusal` / `error` / `upstream_truncated` / 供应商原值。
- 计费金额来自开轮冻结报价，不改 billing。

## 5. 前端

- 契约 `ConversationStreamResetEvent { type: 'reset' }`。
- `conversation-stream.ts`：丢掉两个批处理器里未提交的增量，调 `onReset`。
- `use-conversation-turn.ts`：清空 streaming 正文与这条消息的思考文本（`resetStreamText`、`clearMessageThinking`）。
- 旧前端忽略未知事件：流式期间「原内容 + 重写」拼在一起，done 后 invalidate 取落库内容恢复。

## 6. 记录（`ops.llm_calls`，迁移 `20261124_llm_calls_stream_end.sql`，只加不删）

- `stream_end`：交付那一路的结束方式（首发/首字兜底胜出行 + rewrite 行）。胜出行异步插入，`recordStreamEnd` 未命中时 1.5 秒后重试一次。
- `llm_calls_role_check` 增加 `rewrite`。成本由现有补查任务按 generation_id 补。
- 发布顺序：迁移 TEST → 生产 → 后端。迁移未执行时写入失败只记 warn。

## 7. 配置 `chat_recovery_config`

```json
{
  "fallback_first_token_ms": 3000,
  "interruption": { "enabled": false, "stall_ms": 3000 },
  "refusal": { "enabled": false, "check_chars": 30, "keywords": [] }
}
```

读不到/配坏 → 两个开关视为关闭并记 warn（不在代码放默认词池）。Admin 专门编辑器经 `dedicatedConfigEditors.tsx` 分发（`ConfigValueEditor.tsx` 已超长，不再往里加）。

## 8. 拒绝的方案

- 按供应商事后元数据判定（太晚，用户否决）。
- 续写半段（用户否决，改为擦掉重写）。
- 压住正文再放（用户：允许用户看到拒答，压住没有意义）。
- 小模型判官（用户：成本高）。
- 正则词池（运营难维护，子串足够）。
