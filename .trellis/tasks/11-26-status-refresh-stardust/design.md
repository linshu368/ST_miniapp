# 设计：立即更新每次 6 星尘

## 1. 复用调研

| 检索对象                                                                                                                               | 结论                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing.apply_wallet_debit`（20261111 版，生产 11-26 实测类型白名单 `('chat_debit','image_generation','media_plaza_video_reserve')`） | **复用**。已有 `main_then_bonus`（专项优先）、`debit_key` 幂等、锁钱包行。只把类型白名单加一个 `status_refresh`，做法照抄 `20261117_media_plaza_video_wallet_entry_guard.sql`（只替换已知那一行，比对替换前后函数体与属性）。 |
| `billing.wallet_ledger_entry_type_check`（生产 NOT VALID）                                                                             | **扩展**，照抄 `20261118_media_plaza_video_production_base.sql` 的保留原表达式 + `OR entry_type = 'status_refresh'`，保持 NOT VALID，不重扫历史流水。                                                                         |
| `billing.usage_charges` + `usage_charges_kind_check`（生产 validated，4 个值）                                                         | **扩展** kind 加 `status_refresh`。CONTRACT §2「要收费」规定一次可计费动作一行、扣费函数同一事务写流水。                                                                                                                      |
| `billing.protect_chat_reserved_balance` 触发器                                                                                         | **不改，依赖它**：扣到低于聊天预留额时抛 `TOTAL_CREDITS_INSUFFICIENT`，状态更新扣费不会吃掉进行中那轮聊天的预留。                                                                                                             |
| `billing.guard_chat_reservation`（usage_charges BEFORE INSERT/UPDATE）                                                                 | 对 `status='charged'` 的新行只把预留列置 0，不影响。                                                                                                                                                                          |
| 语音 `charge_voice_usage` / 广场 `settle_image_plaza_generation`                                                                       | **不复用**：它们是旧位置的计费（registry 标 moving，"不要在旧位置扩展"），且绑各自业务表。新建 `billing.charge_status_refresh`，只做 usage_charges + apply_wallet_debit。                                                     |
| `MiniappWalletRepository.findByUserId`                                                                                                 | **复用**做余额预检（只读，没钱包当 0）。`precheckMainCredits` 只看通用，不适用。                                                                                                                                              |
| `wallet-spending.ts listMediaSpending`                                                                                                 | **扩展**一段 `status_refresh`，沿用视频那段的通用/专项拆分字段；前端明细页已会显示 `main_delta`/`bonus_delta`，不改页面。                                                                                                     |
| 前端 `lib/recharge-redirect.ts`                                                                                                        | **复用** `isInsufficientCreditsError`（认 `INSUFFICIENT_CREDITS`）与 `redirectToRecharge`。                                                                                                                                   |
| 前端 `paymentKeys.wallet()`                                                                                                            | **复用**，更新成功后 invalidate。                                                                                                                                                                                             |
| 面板 `chat-status-panel.tsx`、`use-status-gestures.ts` 的 `readLocal/writeLocal`                                                       | **扩展**。第一次说明卡的"看过"标记用 localStorage（同现有 `HINT_KEY`）。不进 `features.user_marks`：换设备再看一次说明无害，不值得一次网络写。                                                                                |
| `features/status-bar/service.ts refreshConversationStatus`                                                                             | **改**：去 VIP、加预检、算是否计费、调扣费。                                                                                                                                                                                  |
| `features/generation/`                                                                                                                 | 新文件 `status-refresh-billing.ts` 放扣费决策调用与日志（项目规则：计费走 generation）。                                                                                                                                      |

## 2. 流程

```
POST /status/refresh
 ├ requireSession
 ├ 限频（60s，进程内，不变；撞上进行中的更新不限频，不变）
 ├ resolveEffectiveStatusBar → statusEnabled
 ├ 余额预检：findByUserId → main + bonus ≥ 6？否 → 402 INSUFFICIENT_CREDITS（不调模型、不写 lastManual）
 ├ lastManual.set
 ├ statusJoined = statusEnabled && isStatusUpdating(sid)   ← 同步取，紧接着发起，中间没有 await
 │ memoryJoined = isMemoryChecking(sid)
 ├ 并行 runStatusUpdate / runMemoryCheck（不变）
 ├ 失败判定（不变）：状态失败，或状态关着且记忆失败 → 抛 STATUS_UPDATE_FAILED（不扣）
 ├ billable = (!statusJoined && status ∈ {ok, partial}) || (!memoryJoined && memory = recorded)
 ├ billable → chargeStatusRefresh（不抛；失败只记日志）
 └ readConversationStatus 返回
```

为什么"先跑后扣"而不是"先扣后退"：先扣后退要处理退款失败（会让用户白丢 6 星尘，得补偿任务），钱包明细还会出现一扣一退。先跑后扣的最坏情况是平台少收一次 6 星尘（余额在更新期间被花掉 / 被聊天预留占住 / 扣费 RPC 出错），不会多扣用户的钱。DAU≈50，可接受。

撞上进行中更新的处理：面板在 `updating` 时按钮本就禁用，只有极短竞态会撞上。撞上的那部分是自动更新（免费）跑出来的，不算这次的收费理由。

## 3. 数据库（一个迁移 `20261126_status_refresh_charge.sql`，domain: billing）

1. `wallet_ledger_entry_type_check`：读出现有表达式（要求 NOT VALID），DROP 后 `ADD ... CHECK ((原表达式) OR entry_type = 'status_refresh') NOT VALID`，保留注释。已含 `status_refresh` 时跳过（可重放）。
2. `usage_charges_kind_check`：DROP 后 `ADD CHECK (kind IN ('chat_text','chat_voice','plaza_image','plaza_video','status_refresh'))`。表小，事务内直接校验。已含时跳过。
3. `apply_wallet_debit` 类型白名单：`('chat_debit', 'image_generation', 'media_plaza_video_reserve')` → 末尾加 `'status_refresh'`；只替换这一处，替换后比对函数体只差这一行、OID/属性/权限不变；已是新值时跳过。
4. 新函数 `billing.charge_status_refresh(p_charge_id uuid, p_user_id uuid, p_session_id uuid, p_amount numeric) RETURNS jsonb`，`SECURITY DEFINER`、`search_path=pg_catalog`，只授 `service_role`：
   - 参数校验（非空、金额为正整数）。
   - 已有同 id 行：用户不同 → 报错；否则原样返回（`already_charged` / `insufficient`）。
   - `apply_wallet_debit(p_user_id, 'status_refresh:' || p_charge_id, 'main_then_bonus', p_amount, 'status_refresh', 'status_refresh', p_charge_id::text, '{}')`。`wallet_ledger.metadata` 存量冻结，不传新键。
   - 捕获 `TOTAL_CREDITS_INSUFFICIENT` → 记一行 `status='failed'`、`charged_credits=0`、`settled_at=now()`，返回 `{status:'insufficient'}`。其余异常照抛（整笔回滚）。
   - 成功 → 记一行 `kind='status_refresh'`、`subject_id=p_session_id`、`status='charged'`、`billing_mode='paid'`、`wallet_policy='main_then_bonus'`、`quoted_credits=charged_credits=p_amount`、`debit_ledger_id`、`quote={charge:{main_credits,bonus_credits}}`、`settled_at=now()`，`ON CONFLICT (id) DO NOTHING`。
   - 返回 `{status:'charged', ledger_id, split:{main_credits,bonus_credits}}`。
5. 尾检：两个约束含 `status_refresh`；`apply_wallet_debit` 含新白名单；新函数 secdef + search_path + 只有 service_role 可执行。

坐标（CONTRACT §3.2）：`billing.charge_status_refresh` 性质 M，权威写入 = 后端 `features/generation/status-refresh-billing.ts` 经 repository 调用；`usage_charges` 新 kind 行永久保留；跨域软引用 `subject_id → experience.chat_sessions.id`（不建外键，同 chat_text）。registry 同 PR 更新 usage_charges/wallet_ledger 的 owner 与说明。

## 4. 契约（`packages/shared/src/api/status-bar.ts`）

- 新常量 `STATUS_REFRESH_CREDITS = 6`（前后端同源）。
- `ConversationStatusData` 删 `manualUpdate`（不再有 VIP 区分）。前后端同一次发布，旧前端读不到字段时按"允许"处理，最多几分钟看不到首次说明卡。
- `StatusBarError` 删 `STATUS_VIP_REQUIRED`，加 `INSUFFICIENT_CREDITS`（402，和切模型同码，前端现成谓词能认）。

## 5. 后端文件

- `features/generation/status-refresh-billing.ts`（新）：`requireRefreshCredits(userId)`（预检，不够抛 `StatusBarError('INSUFFICIENT_CREDITS')`）、`chargeStatusRefresh({userId, sessionId, reason, log})`（生成 charge id、调 repository、记日志，从不抛）。
- `infrastructure/repositories/StatusRefreshChargeRepository.ts`（新，billing 域）：一个 `charge()` 调 RPC，5 秒超时；不塞进已 460 行的 `MiniappWalletRepository`。
- `features/status-bar/service.ts`：去 `VipStatusService`；`readConversationStatus` 不再读 VIP（GET /status 少一次查询）；`refreshConversationStatus` 按 §2 改。
- `routes/status-bar.ts`：错误码映射；注释改掉"仅限 VIP、不消耗星尘"。
- `wallet-spending.ts`：加 `status_refresh` 段，显示名「状态更新」，带通用/专项拆分。
- 注释更新：`status-bar-model.ts` 头注释、`update.ts`、`turn-execution.ts` 里"不扣星尘"说的是自动更新，保留并写清"手动 6 星尘"。

## 6. 前端

- `chat-status-panel.tsx`：
  - 去 `vipRequired`、`router.push('/vip')`。
  - 点「立即更新」：localStorage 没有 `st_miniapp_status_refresh_intro_seen` → 打开说明卡（不发请求）；有 → 直接更新。
  - 说明卡（新组件 `status-refresh-intro.tsx`）：居中、宝石图标、「立即更新」「6 星尘 / 次」、两行小字「每 3 轮自动更新，不花星尘」「没更新成功不扣」、主按钮「更新」、压暗的「先不用」。两个按钮都记"看过"。返回键 / Esc / 点遮罩先关卡片。
  - 标题「每 3 轮自动更新」后加 `?` 小按钮 → 小气泡三行（自动更新不花星尘 / 立即更新 ◇6 星尘一次 / 没更新成功不扣），点外面关。
  - 错误：`INSUFFICIENT_CREDITS` → 底部「星尘不够了 · 去充值 ›」，点了 `redirectToRecharge({ returnTo: 当前路径, requiredCredits: 6 })`；其他失败文案改「这次没更新成功，没扣星尘，再试一次」。
- `lib/api/status-bar.ts`：refresh 成功后 invalidate `paymentKeys.wallet()`。
- `profile-stardust-balance.tsx`：专项说明「轻量档对话专用」→「轻量档对话、状态更新可用」；头注释同步。
- `ui-tests/fixtures/memory-panel.ts`：删 `manualUpdate`。

## 7. 可靠性

- 超时：余额预检、扣费 RPC 各 5 秒；模型调用不变。
- 重试：扣费不重试（幂等键在，但失败只少收，不值得拖长接口）。
- 幂等：charge id 每次请求新生成 → `usage_charges.id` 主键 + `wallet_ledger.debit_key` 唯一，同 id 只扣一次。
- 并发：同会话并发手动刷新被限频 + 进程内去重挡住；跨会话并发扣同一钱包由 `apply_wallet_debit` 行锁串行，余额不会为负；聊天预留由触发器保护。
- 降级：扣费失败不影响更新结果返回。
- 限流：沿用 60 秒。
- 可观测：见 task.json `logging_integration`。
- 容量：每次手动更新多 1 次钱包读 + 1 次 RPC（近 7 天约 1600 次手动更新）。

## 8. 演进与恢复

- 发布顺序：迁移 TEST → 验证 → 生产 → 后端与前端同一次发布（同一 PR 进 main）。迁移只扩展（加约束值、加函数、白名单加一项），旧代码不受影响，可先执行。
- 旧数据：无。
- 停止条件：上线后出现多扣（同一次更新两条 status_refresh 流水）、负余额、扣费失败率 > 10%，回滚代码。
- 回滚：代码回滚即停止收费（旧代码不调新函数）；迁移不回滚（扩展项无害），如需清理：`DROP FUNCTION billing.charge_status_refresh(uuid,uuid,uuid,numeric)`，约束与白名单保留。

## 9. 拒绝的方案

- 先扣后退：要退款补偿任务，明细出现一扣一退（§2）。
- 价格进运营平台：现在没有改价需求，等要调价再加。
- "看过说明"进 `features.user_marks`：多一次写请求，换设备再看一次无害。
- 每次更新后提示"用了 6 星尘"（C 版）、按钮带价签（A 版）：用户选了 B。
