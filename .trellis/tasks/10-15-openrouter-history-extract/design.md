# 轻量设计与规划门禁

## 事实、复用与归属

2026-10-15 已确认当前分支 `dev_openrouter_migrate`，Supabase URL 为正式 TEST `zoqelpfhurwehlvypryl`；只读 catalog 证实 13 列和 `venice_chat_history` 实表。未读取业务行。实施前重新核对 TEST/Production schema、迁移账本与部署版本；两库不假定同构。

- 检索并复用 `ConversationHistoryRepository` 的终态/计费写入、`generation/openrouter-metadata.ts` 的唯一字段映射、`settle.ts`、`sync-job.ts`、`VeniceChatHistoryRepository` 和 `20260929_venice_chat_history.sql` 的一对一结构。扩展 OpenRouter 专属 repository/查询，不建立跨供应商通用框架，也不改 Venice 写入逻辑。
- 已检索 `current_chat_history` 视图、`start_chat_history_*` 开轮 RPC、`billing.charge_llm_usage` 计费路径、`packages/shared/src/api/conversations.ts` 消费契约及 Prisma schema。开轮与钱包事实不移入新表；当前 DTO 无元数据字段，若保持不变无需新公开 API。实施时复核所有函数/视图/管理查询依赖。
- `experience` 拥有对话调用产物；`billing` 仍拥有扣费流水，新表不成为第二套计费事实。`chat_history_id` 唯一 + FK cascade；provider 身份固定为 OpenRouter，底层 `llm_provider_name` 另存。仿 Venice 采用最小权限和字段约束，但应按 TEST 当前暴露/RLS 配置重新验证，不机械复制。

## 写入与读取边界

同步终态写主表业务结束原因；OpenRouter generation ID 应在拿到时落入新表占位行，供回捞定位。`/generation` 返回后 upsert 原始明细，只有成功态且上游给出合法原因才更新主表业务原因；取消/超时不可被晚到 `stop` 覆盖。计费快照、实际扣费和结算时间继续写主表。新表 `llm_generation_data` 新写入采用有界、安全字段；旧原始 JSON 回填须先审计内容并确定保留策略。

回捞仍以 24 小时、有限批次扫描，以新表 ID/完成字段及主表结算状态共同判断。`llm_usage_cache` 不作为回捞完成条件；现有 `isCompleteGenerationData` 把它列为“完整”条件，与仓库注明 OpenRouter 不返回该字段相冲突，实施时统一口径并用回归验证。当前视图投影旧列，必须在删列前重建受影响投影及消费者。

## 可靠性、发布与恢复

- **超时/重试/限流**：沿用有限 24 小时回捞及批次上限；补齐外部请求必须设置明确超时，仅安全读取可重试并退避。无新无限重试或新队列。
- **幂等/并发/事务**：`chat_history_id` 唯一 upsert；结算仍由既有 `charge_id` 幂等。主表业务终态与原始元数据分写，失败可回捞，不把跨网络调用包进 DB 事务。验证取消与晚到上游结果竞争，以及双实例重复回捞。
- **降级/补偿/容量/观测**：元数据写失败不改变已交付回复，保留可回捞的 ID 和计费快照；按现有 pino 记录 ID、阶段、耗时和错误，禁止正文/密钥/完整原始 JSON。回填分批并核对数量、空值和尺寸；索引仅服务 generation ID 与回捞查询，先看查询计划和锁影响。
- **发布顺序**：新增表/权限 → Backend 兼容读写 → 安全回填与核对 → 新读路径/视图 → 停旧写并证明无引用 → 单独清理旧列。若任一步校验失败，停止清理、保留旧列并 forward-fix；删列后不以回滚旧 Backend 作为恢复手段。每个 migration 单文件经手工 workflow 先 TEST 后 Production，Production 需另行审批与验收。
