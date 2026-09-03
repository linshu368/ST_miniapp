# 测试环境执行与验收说明

> 数据库 migration 为手工执行；本次未自动连接或修改任何环境。

## 执行顺序

1. 在测试库执行 `packages/shared/migrations/105_voice_billing_atomic.sql`。
2. 先保持 `voice_billing_enabled=false` 部署 backend/frontend，验证语音旧流程可用。
3. 在测试库将 `app_core.runtime_config.voice_billing_enabled` 改为 `true`，刷新 PostgREST schema cache。
4. 验证默认生成、自定义生成、重新生成、余额不足、超限、文本处理失败、TTS 失败。

## 数据断言

- 成功一次：钱包总额减少 15；新增一条 `billing.wallet_ledger(reference_type='voice_usage')`；对应 audio 为 `ready`、`credits_charged=15`、`debit_ledger_id` 非空。
- 同一 attempt 重放结算：不得新增第二条 ledger，钱包不得重复减少。
- 超限/文本处理失败/TTS 失败/余额不足：audio 为 `failed`，`credits_charged=0`，无 voice_usage ledger。
- 重新生成成功：新 attempt 产生新的 15 星尘扣费；失败后入口恢复可重试。

## 回滚

1. 先将 `voice_billing_enabled=false`，确认不再受理收费请求。
2. 回滚应用版本。
3. 如必须回滚 schema，按 migration 文件尾部 Rollback 注释执行；历史 ledger 属财务记录，不应物理删除，需另走冲正流程。
