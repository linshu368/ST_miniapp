# 技术设计

## 1. 复用边界

复用现有 `features/voice/generate.ts`、`billing.ts`、voice config/route、`MiniappWalletRepository.chargeVoiceUsage`、`experience.chat_message_audio` 和 `billing.charge_voice_usage`。现有“Storage 已有可播放 URL后扣款并把 audio 收口为 ready”的事务边界保留。

父任务提供 `billing.feature_free_trials`、预留/续租/释放原语、`main_only` 钱包 allocator、幂等 refund 和 Shared 公共免费状态。子任务不得复制免费计数表、另建钱包更新或自行定义冲突错误码。

## 2. 状态流

```text
创建/确认 audio attempt
  -> reserve(feature=voice, reference_id=audio.id)
     -> reserved ordinal 1..3：本次免费
     -> quota exhausted：按现有语音价格检查 main_credits
  -> 调用 TTS + Storage
     -> 明确失败：release reservation + audio failed
     -> 成功可播放：settle_voice_generation
        -> 免费：consume reservation + audio ready
        -> 付费：main_only debit + audio ready
```

免费/付费决策和价格写入 audio attempt 快照，worker/重试只读取快照，不按重试时的余额或次数重新选择更有利分支。同一 audio ID是 reservation 和结算幂等键。

## 3. 原子与异常边界

- 免费成功：reservation 从 reserved 变 consumed 与 audio ready 在同一事务。
- 付费成功：main-only debit、ledger 与 audio ready 在同一事务。
- 余额不足：调用上游前拦截；最终结算遇到竞态不足时不呈现 ready，并沿现有失败状态收口。
- 明确失败：best-effort 释放后再由可重试 job/RPC兜底；释放操作自身幂等。
- reservation 已过期且 ordinal 被复用的迟到成功：不扣款、不呈现为成功，记录允许字段错误并进入可解释失败态。
- 已扣后业务补偿：以 debit ledger 调父任务 refund；退款与业务状态原子或通过稳定补偿键可重放。

## 4. API/UI

扩展现有 voice DTO/hook，不新增第二套语音接口。服务端返回本次 `billing_mode: free_trial|paid`、ordinal/remaining、price。确认按钮和入口使用同一响应展示；不得由本地计数推测。

## 5. 可靠性与回滚

- 上游超时、有限重试和文本长度规则沿用现有实现。
- reservation TTL 大于单次 TTS+Storage 硬超时；长流程在已有进度点续租。
- 功能开关默认关闭；父任务底座和新代码可先部署。关闭时不再发新 reservation，已受理 attempt 仍按快照收口。
- 回滚 UI/route 不删除免费事实。出现计费异常先关闭新语音受理，再用 ledger 审计/退款；不得清空计数。

## 6. 验证重点

必须增加高风险回归测试：并发第三次、失败释放、同 ID重放、迟到成功、只有 bonus、扣款与 ready 事务回滚、开关切换。父任务研究和总设计为本任务的上游技术依据。
