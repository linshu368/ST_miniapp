# 实施计划：语音生成收费与 300 字限制

## 实施原则

- 按 shared 契约 → migration/RPC → backend → frontend → 全链路验证实施。
- 用户最终确认规划并执行 `task.py start` 后才修改产品代码。
- 新 migration 只新增文件，不修改历史 migration；test 验证后才允许生产执行。
- 计费、ledger 与 ready 状态由单个数据库事务收口，不采用“先 ready 再普通 deduct”。
- 每阶段完成后执行局部检查，最终执行全部受影响包检查。

## Phase 0：基线与激活

1. 用户确认 `prd.md`、`design.md`、`implement.md`、`task.md`。
2. 验证 `implement.jsonl`、`check.jsonl` 已配置真实上下文。
3. 执行 `python ./.trellis/scripts/task.py start 09-01-voice-generation-billing-limit`。
4. 记录 `git status --porcelain`，不覆盖用户已有改动。
5. 运行现有语音测试建立基线。

## Phase 1：Shared 契约

1. 扩展 `packages/shared/src/api/voice.ts`：
   - billing / limits / hints DTO；
   - 300 字共享常量改为最终语音文本上限语义；
   - 更新自定义文本说明，明确自定义也经过文本处理。
2. 复用现有 API 错误 envelope 的余额字段，不私建公开 DTO。
3. 确认 shared 根导出。
4. 验证：
   - `pnpm --filter @miniapp/shared typecheck`
   - `pnpm --filter @miniapp/shared test`

## Phase 2：数据库 migration 与原子计费

1. 在 `packages/shared/migrations/` 新增 migration：
   - `experience.chat_message_audio` 增加扣费事实列；
   - 新增非空唯一索引；
   - 创建 `billing.charge_voice_usage` 原子 RPC；
   - 在 `app_core.runtime_config` 种入 voice 配置，计费开关默认关闭；
   - 补充权限、注释、自检与 rollback 说明。
2. RPC 覆盖 attempt/user 校验、attempt 行锁、幂等命中、钱包行锁、bonus 优先扣减、ledger 写入及 ready 收口。
3. 测试库逐文件手工执行并验证：余额 15/14、bonus/main 拆分、同 attempt 重复/并发、不同 revision 分别收费、余额不足无部分更新。

**回滚点 A：** 保持计费开关关闭；RPC 未通过时回滚 migration，不接后端。

## Phase 3：后端配置与 generation 计费边界

1. 新增 `features/voice/voice-billing-config.ts`，只通过 `platform/runtime-config.ts` 批量读取配置并安全兜底。
2. 在 `features/generation/` 增加：
   - 语音余额预检；
   - 原子结算 RPC 适配；
   - `charged / already_charged / insufficient_balance` 严格判别类型。
3. 补充配置缺失/损坏、余额边界、RPC 结果映射测试。

## Phase 4：文本处理与生成编排

1. 更新 `voice-prompt.ts` / `voice-draft.ts`：
   - 明确最终输出不超过 300 字；
   - 支持 default/custom source mode；
   - 自定义不再跳过文本处理。
2. 更新 `runVoiceGeneration`：
   - 两类输入统一处理和规范化；
   - TTS 前执行最终硬校验；
   - 301 字标记 `voice_text_too_long`，不调用 TTS/结算；
   - TTS/存储成功后调用原子结算，不再独立 `markReady`；
   - 结算失败不暴露成功结果，并 best-effort 清理孤儿对象。
3. 更新 `ChatMessageAudioRepository` 的计费列、原子 pending 接口与映射；内部账务字段不进入 DTO。
4. 更新 `routes/voice.ts`：配置响应、动态上限、余额预检、402 响应、异步参数；保留 `@frontend-ready: true`。
5. 清理“本期不扣费”“自定义跳过写稿”等过时注释。
6. 测试默认/自定义、300/301、失败不扣、幂等、重新生成、余额竞争与 stale pending。

**回滚点 B：** 代码部署期间保持 `voice_billing_enabled=false`；异常时关闭开关并回滚应用，新增数据库列保持兼容。

## Phase 5：前端价格、限制与行内提示

1. `src/lib/api/voice.ts` 适配契约，继续使用 React Query。
2. 聊天页向 `ChatMessageVoiceFooter` 传递 price label、limits 与 hints。
3. `chat-message-voice.tsx`：
   - 生成/重试入口显示 15 星尘；
   - 超限在当前消息下显示指定红色小字；
   - 文本处理/TTS 失败显示可重试提示；
   - pending、ready 或正常状态清除旧提示；
   - 保持播放条、展开文字框、自定义入口和紧凑布局。
4. 自定义页使用配置上限，采用 `maxLength` 与 change 截断双保险，并展示成功收费提示。
5. 语音 ready 后仅使钱包 query 失效一次，更新余额且避免轮询刷新风暴。
6. 添加组件/数据层测试，并检查桌面和移动端。

## Phase 6：验证矩阵

### 自动化命令

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm lint
```

如测试数据允许，再运行：

```bash
pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model
```

### 测试环境场景

1. 余额 14 / 15 受理边界；
2. 默认最终文本 300 / 301；
3. 自定义输入 300 / 301、超长粘贴及处理后 300 / 301；
4. 文本处理失败、TTS 余额不足、TTS 超时、存储失败；
5. 首次成功扣 15，同消息重新生成成功再扣 15；
6. 同 attempt 重放/并发收口仅扣一次；
7. 当前消息行内错误、提示消失、其他消息无影响；
8. 播放条、语音文字、自定义入口、音色、倍速回归；
9. 客户端产物、响应与日志无 API Key/私有地址。

## Phase 7：上线与回滚

1. 对账 ready、`voice_usage` ledger、credits_charged 与钱包变化。
2. 经年确认是否上线。
3. 生产顺序：migration → 兼容代码部署 → 冒烟 → 开启计费开关。
4. 异常优先关闭计费开关；不得删除已产生的财务 ledger。
5. 完成 Trellis 全量检查、spec 更新评估和提交计划，未经确认不 push。

## 高风险审查点

- migration：事务、schema、权限、幂等、rollback。
- `features/voice/generate.ts`：TTS 前闸门、失败不扣、成功原子结算。
- `features/generation/*`：不得绕过统一计费边界。
- `ChatMessageAudioRepository.ts`：并发 attempt 与状态一致性。
- `chat-message-voice.tsx`：仅当前消息提示、视觉回归和无障碍。
- 自定义页：输入法与粘贴的 300 字边界。
