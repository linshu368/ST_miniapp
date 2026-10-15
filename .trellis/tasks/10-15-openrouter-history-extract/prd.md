# OpenRouter 元数据从 chat_history 拆表

## 目标与范围

TEST `zoqelpfhurwehlvypryl` 的 `experience.chat_history` 现存 13 个 OpenRouter 调用元数据列：`llm_provider_name`、`llm_finish_reason`、`llm_usage`、`llm_usage_cache`、四个 `llm_native_tokens_*`、`llm_latency`、`llm_generation_time`、`llm_model`、`llm_generation_id`、`llm_generation_data`。建立一张 `experience.openrouter_chat_history` 一对一明细表，参考 `experience.venice_chat_history`；将 OpenRouter 原始调用事实与主对话、计费事实分开。

## 要求与约束

- `experience.chat_history` 继续拥有会话、回复、终态、取消/超时裁决和计费结果；新表由 Backend 生成/结算/回捞路径写入，按 `chat_history_id` 至多一行，可重复补齐。免费、失败、用量尚未返回的 OpenRouter 调用也应能保留 generation ID。
- 新表保存 OpenRouter 13 列对应的原始调用信息；不复制用户输入、上下文或回复正文。`llm_provider_name` 是 OpenRouter 实际路由的底层厂商，不能用来判定是否走 OpenRouter。历史归属证据不足的行不得猜测迁入。
- 主表 `llm_finish_reason` 继续表示用户可见且参与取消/计费的业务终态；新表对应字段表示上游原始结束原因。保留取消/超时优先级和成功态的权威原因补齐。主表 `llm_generation_id` 只在回捞改用新表且旧消费者清零后删除。
- `model`、`llm_charge_id`、`llm_billing_snapshot`、`llm_billing_settled_at`、`deduction_rate`、`llm_intended_deduction` 属于主表业务或计费事实，不纳入拆表。
- 新表归 `experience`：业务不变量是“一条对话 revision 对应一次 OpenRouter 调用明细”；不随运营后台单独存续。权威写入方为 Backend；运行时消费者为结算、24 小时回捞和排障查询。新表以 `experience.chat_history(id)` 为父外键；视图、回捞与计费的既有依赖仍须核对，不新增跨 schema API。
- 迁移只新增到 `packages/shared/migrations/`，不修改历史 migration；TEST 和 Production 分开验收。旧数据、兼容窗口、权限/RLS、容量/锁与回滚均须明确。原始 JSON 不应新增 prompt、回复正文、凭证或个人敏感数据。
- 本轮仅规划，等待人工审阅；审阅前不执行 `task.py start`、产品代码、DB 写入、提交或推送。

## 验收标准

- [ ] TEST 上新表结构、唯一/FK/级联、索引、约束、授权和回填一致性经过前后核验；无法归属的历史行单独计数，不误迁移。
- [ ] OpenRouter 新发送、重生成、免费/付费、成功/取消/超时/上游错误及用量迟到均保持原对话和计费行为；重复结算/回捞不产生重复明细或扣费。
- [ ] 回捞扫描、`current_chat_history` 视图及所有消费者已切到新位置；主表旧列仅在应用和数据库无引用、目标环境无读写证据后清理。旧 Backend 的兼容边界和停止条件已记录。
- [ ] 受影响包 typecheck、既有相关测试、lint/静态检查、跨包 build 与 `pnpm -r typecheck` 通过；TEST 手工验证和 migration 回滚/forward-fix 证据齐全。Production 不以 TEST 结果代替。
