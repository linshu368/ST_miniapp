# 语音付费上线 Runbook

> 立项：2026-08-28。语音按次扣费（`feature/lbw-voicefee`）上线前的部署顺序、验证与回滚。
>
> 关联：
>
> - [`packages/shared/migrations/101_voice_billing.sql`](../packages/shared/migrations/101_voice_billing.sql) — 计费列、`charge_voice_usage` RPC、`runtime_config` 七键、`validate_managed_config_value` 重写
> - [`packages/shared/migrations/102_voice_pending_unique.sql`](../packages/shared/migrations/102_voice_pending_unique.sql) — pending 唯一索引 + 会话非部分索引（自带存量清理）
> - [`packages/backend/src/features/voice/generate.ts`](../packages/backend/src/features/voice/generate.ts) — 语音生成主流程
> - [`packages/backend/src/infrastructure/repositories/ChatMessageAudioRepository.ts`](../packages/backend/src/infrastructure/repositories/ChatMessageAudioRepository.ts) — `markReady` 已加固：计费列缺失时降级，音频仍 ready

---

## 0. 上线前必须确认的两件事

1. **代码已加固**：`ChatMessageAudioRepository.markReady` 把 `credits_charged` / `charge_id` 拆出主 update，列不存在（`42703`）时只打 warn 不抛错。这意味着 backend 先于 migration 101 部署也不会让语音功能 100% 失败。
2. **migration 102 自带存量清理**：在 `CREATE UNIQUE INDEX uq_chat_message_audio_pending` 前先把同一 message 多余的 pending 收口成 failed，避免 23505 整体回滚。

这两条把"部署顺序错位"的 P0 风险降级为"功能降级而非功能不可用"，但**仍强烈建议按下方顺序执行**，避免计费列缺失期间无法记账。

---

## 1. 严格上线顺序

| 步骤 | 环境 | 操作                                                               | 验证                             |
| ---- | ---- | ------------------------------------------------------------------ | -------------------------------- |
| 1    | test | GitHub Actions → Database Migration → `101_voice_billing.sql`      | 见 §2                            |
| 2    | test | 同上 → `102_voice_pending_unique.sql`                              | 见 §3                            |
| 3    | test | 部署 backend（Railway `stminiapp-backend`）                        | 语音生成可用、计费开关默认 false |
| 4    | test | 部署 frontend / admin（Vercel）                                    | 语音入口、价格展示、402 跳转     |
| 5    | test | 按 §4 跑 101 人工核对清单                                          | 所有非法值仍报错                 |
| 6    | prod | 重复步骤 1–5                                                       | 同上                             |
| 7    | prod | 确认 `voice_billing_enabled = false` 后，单独决定开启时机（见 §5） | 开关默认 false                   |

**关键约束**：migration 101/102 必须在 backend 部署前完成。代码加固让顺序错位不再致命，但计费列缺失期间 `credits_charged` 恒为 NULL，消费明细与对账会缺数据。

---

## 2. 101 执行后验证

```sql
-- 计费列已加
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'miniapp' AND table_name = 'chat_message_audio'
  AND column_name IN ('credits_charged', 'charge_id');
-- 必须返回两行

-- RPC 已建
SELECT proname FROM pg_proc
WHERE proname = 'charge_voice_usage';
-- 必须返回一行

-- 七个 voice_* 配置键已种入
SELECT key FROM miniapp.runtime_config
WHERE key LIKE 'voice_%' ORDER BY key;
-- 必须返回 7 行：voice_billing_enabled / voice_draft_failed_hint /
--   voice_generation_credits / voice_max_spoken_chars / voice_over_limit_hint /
--   voice_price_label / voice_tts_failed_hint

-- 计费开关默认值（生产必须为 false）
SELECT value FROM miniapp.runtime_config
WHERE key = 'voice_billing_enabled';
-- 必须是 false
```

---

## 3. 102 执行后验证

```sql
-- pending 唯一索引已建（必须有一行）
SELECT indexname FROM pg_indexes
WHERE schemaname = 'miniapp' AND tablename = 'chat_message_audio'
  AND indexname = 'uq_chat_message_audio_pending';

-- 会话非部分索引已建（必须有一行）
SELECT indexname FROM pg_indexes
WHERE schemaname = 'miniapp' AND tablename = 'chat_message_audio'
  AND indexname = 'idx_chat_message_audio_session_all';

-- 清理后不应再有同一 message 多条 pending（必须 0 行）
SELECT message_id, count(*) FROM miniapp.chat_message_audio
WHERE status = 'pending'
GROUP BY message_id HAVING count(*) > 1;
```

若 `uq_chat_message_audio_pending` 不存在：说明 102 事务回滚了。检查 102 执行日志中的 `RAISE EXCEPTION` 或 23505，处理完存量数据后重跑 102。

---

## 4. 101 人工核对清单 — `validate_managed_config_value` 分支完整性

migration 101 用 `CREATE OR REPLACE` 重写了 `admin.validate_managed_config_value`，注释声称"其余分支与 093 保持逐字一致"。093 的内容不在本次 diff 中，**无法从 diff 证伪是否有分支被遗漏**。执行 101 后必须在 test 库逐个 key 喂明知非法的值，确认都仍然报错。

对以下每个 key，构造一个明显违反其校验规则的值，调用 `admin.validate_managed_config_value(key, value)`，**期望都抛错**：

- [ ] `llm_model_catalog`
- [ ] `llm_pricing_config`
- [ ] `system_instructions`
- [ ] `pref_word_count_tiers`
- [ ] `lobby_ranking_params`
- [ ] `lobby_pinned_characters`
- [ ] `miniapp_payment_plans`
- [ ] `miniapp_recharge_page_config`
- [ ] `miniapp_free_quota_exhausted_dialog_config`

```sql
-- 示例：对每个 key 喂一个明显非法的值
SELECT admin.validate_managed_config_value('llm_model_catalog', '"not-an-array"'::jsonb);
-- 期望：RAISE EXCEPTION，而非返回 ok
```

**判定**：任一 key 变成"什么都能存"（返回 ok 而非抛错）→ 该分支被抹掉，需回滚 101 并修复 `validate_managed_config_value`。

同时建议反向验证：对每个 key 喂一个合法值，确认返回 ok（避免校验过严误伤）。

---

## 5. 开启计费开关前检查

```sql
-- 1. 101 已在 prod 执行（有行）
SELECT * FROM miniapp.runtime_config WHERE key = 'voice_billing_enabled';

-- 2. 102 索引存在（见 §3 的查询，必须各有一行）

-- 3. 单次扣费额配置正确（默认 15）
SELECT value FROM miniapp.runtime_config WHERE key = 'voice_generation_credits';

-- 4. 价格文案配置正确（默认 "15 星尘"）
SELECT value FROM miniapp.runtime_config WHERE key = 'voice_price_label';
```

全部确认后再开启：

```sql
UPDATE miniapp.runtime_config
SET value = 'true'::jsonb
WHERE key = 'voice_billing_enabled';
```

开启后观察 5–10 分钟生产日志，确认 `voice.charge.ok` 正常打点、无 `voice.charge.fail` 异常堆积。

---

## 6. 回滚方案

### 6.1 计费开关回滚（最常见，无需回滚代码）

```sql
UPDATE miniapp.runtime_config
SET value = 'false'::jsonb
WHERE key = 'voice_billing_enabled';
```

开关关闭后受理阶段不做 402 预检、后台不扣费，行为与现网完全一致。已扣的费不退（音频已生成）。

### 6.2 backend 回滚

Railway 把 `stminiapp-backend` 回滚到上一个 deployment。代码加固后此步**非必须**（旧 markReady 不写两列，新代码缺列时也降级），但保留为稳妥步骤。

### 6.3 migration 回滚

migration 101/102 对旧代码无害（加列 + 加索引），**一般保留**。若必须回滚：

```sql
-- 回滚 102（backend 必须一并回滚，否则失去并发保护）
DROP INDEX IF EXISTS miniapp.uq_chat_message_audio_pending;
DROP INDEX IF EXISTS miniapp.idx_chat_message_audio_session_all;

-- 回滚 101（谨慎：会丢已扣费记录的 credits_charged / charge_id）
ALTER TABLE miniapp.chat_message_audio
  DROP COLUMN IF EXISTS credits_charged,
  DROP COLUMN IF EXISTS charge_id;
DROP FUNCTION IF EXISTS miniapp.charge_voice_usage(...);
-- 七个 voice_* 配置键可保留（旧代码不读）
```

**注意**：回滚 102 后，`ChatMessageAudioRepository.createPending` 现在插的是 `is_active=false` 的 pending，旧 active 索引拦不住连点两下。必须把 backend 一并回滚到旧 `createPending`（插 active pending）才能恢复并发保护。

---

## 7. 故障速查

| 现象                                              | 可能原因                                                 | 处理                                                  |
| ------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| 每次语音生成都 failed                             | migration 101 未执行，且代码未加固（旧版）               | 先跑 101；或回滚 backend 到加固版                     |
| 102 执行报 23505                                  | 存量同一 message 多条 pending                            | 102 已自带清理；若仍报错，手动跑 §3 的清理 SQL 后重试 |
| 连点两下扣两次费                                  | 102 索引未建 + backend 已是新 createPending              | 立即关计费开关；建索引；回滚 backend                  |
| 消费明细里语音显示"角色语音"而非配置文案          | `metadata.voice_price_label` 未传（已知，fallback 正确） | 非故障，见 plan 改动三                                |
| `validate_managed_config_value` 对某 key 不再报错 | 101 重写时抹掉了该分支                                   | 回滚 101，修复函数后重发                              |
