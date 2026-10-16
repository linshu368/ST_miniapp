# 轻量设计与规划门禁

## 事实、复用与归属

2026-10-15 已确认当前分支 `dev_openrouter_migrate`，Supabase URL 为正式 TEST `zoqelpfhurwehlvypryl`；只读 catalog 证实 13 列和 `venice_chat_history` 实表。未读取业务行。实施前重新核对 TEST/Production schema、迁移账本与部署版本；两库不假定同构。

- 检索并复用 `ConversationHistoryRepository` 的终态/计费写入、`generation/openrouter-metadata.ts` 的唯一字段映射、`settle.ts`、`sync-job.ts`、`VeniceChatHistoryRepository` 和 `20260929_venice_chat_history.sql` 的一对一结构。扩展 OpenRouter 专属 repository/查询，不建立跨供应商通用框架，也不改 Venice 写入逻辑。
- 已检索 `current_chat_history` 视图、`start_chat_history_*` 开轮 RPC、`billing.charge_llm_usage` 计费路径、`packages/shared/src/api/conversations.ts` 消费契约及 Prisma schema。开轮与钱包事实不移入新表；当前 DTO 无元数据字段，若保持不变无需新公开 API。实施时复核所有函数/视图/管理查询依赖。
- `experience` 拥有对话调用产物；`billing` 仍拥有扣费流水，新表不成为第二套计费事实。`chat_history_id` 唯一 + FK cascade；provider 身份固定为 OpenRouter，底层 `llm_provider_name` 另存。仿 Venice 采用最小权限和字段约束，但应按 TEST 当前暴露/RLS 配置重新验证，不机械复制。

2026-10-15 T3 归属补充：用户确认当前只有 OpenRouter 和 Venice 两条调用路径，且每次 Venice 调用均有 `experience.venice_chat_history.chat_history_id`。因此，对已有 `llm_generation_id`、且没有 Venice 明细的主表行，按排除法归属 OpenRouter。TEST 聚合审计未发现明细重叠或快照标记 Venice 却缺 Venice 明细的冲突。迁移增加冲突守卫，保留主表与原始 JSON 不动；无 generation ID 的行没有可转移的调用键，不在这次补迁移内。`llm_provider_name` 实际是 OpenRouter 路由厂商，不能约束为调用方常量；用 forward migration 放宽这一列，同时改 Backend 占位写入。若后续发现 Venice 明细滞后，应停止清理、审计冲突并另做 forward-fix。

## 写入与读取边界

同步终态写主表业务结束原因；OpenRouter generation ID 应在拿到时落入新表占位行，供回捞定位。`/generation` 返回后 upsert 原始明细，只有成功态且上游给出合法原因才更新主表业务原因；取消/超时不可被晚到 `stop` 覆盖。计费快照、实际扣费和结算时间继续写主表。新表 `llm_generation_data` 新写入采用有界、安全字段；旧原始 JSON 回填须先审计内容并确定保留策略。

回捞仍以 24 小时、有限批次扫描，以新表 ID/完成字段及主表结算状态共同判断。`usage_cache` 是可选字段，不作为回捞完成条件；原有“OpenRouter 从不返回该字段”的注释不准确，2026-10-16 已按用户确认保留厂商原名并统一完整性口径。当前视图投影主表旧列，必须在删列前重建受影响投影及消费者。

## 可靠性、发布与恢复

### 2026-10-16 已审核原始字段名调整

- 复用 OpenRouter mapper、repository、settle/sync 和主表计费仓储；将 11 个 OpenRouter 字段改用原名，保留 `llm_generation_id`、`llm_generation_data`。不新增公开 DTO、跨 provider 框架或依赖。
- 新增原名列的 expand migration，保留类型/数值约束与旧别名，按同一行复制已有值；保留 FK/唯一/权限。旧 Backend 可继续写旧列，新 Backend 仅写/查原名。迁移前不得部署新 Backend；切换期间旧 writer 产生的记录由新字段缺失扫描再次回捞，窗口结束需补核并做一次受审查 catch-up，再在无旧消费者后单独 contract。当前不交付删除旧别名的 SQL，也不清理主表。
- Backend 使用单一原名 OpenRouter 元数据类型；计费函数单独返回金额/结算结果，主表仓储显式接收 business finish reason 与计费结果，防止原始 `stop` 覆盖取消/超时。Venice mapper/repository 不改，公共计费接线只做等价参数调整并回归验证。
- `usage_cache` 允许缺失，不把它设为回捞完成的必要条件；缺失不等于零，也不换成 `cache_discount`。
- migration 设置锁等待/语句超时、事务与 shape 检查；本次约两千行规模用单事务回填，超出该规模应重新评估。失败整笔回滚；成功后保留 additive schema 可回退旧 Backend，但新列期间的数据不能靠旧应用回退自动反写到旧别名，恢复时先保留新数据并 forward-fix。
- 必要专项验证：本地隔离 PostgreSQL 执行前序/新迁移并核对所有 11 列值、零值/NULL、重复执行、FK/权限/约束；既有 mapper/结算/回捞/取消测试扩展锁定原名、计费不污染元数据及终态保护。发布后的 TEST 真机验收单列，不以本地结果替代。

- **超时/重试/限流**：沿用有限 24 小时回捞及批次上限；补齐外部请求必须设置明确超时，仅安全读取可重试并退避。无新无限重试或新队列。
- **幂等/并发/事务**：`chat_history_id` 唯一 upsert；结算仍由既有 `charge_id` 幂等。主表业务终态与原始元数据分写，失败可回捞，不把跨网络调用包进 DB 事务。验证取消与晚到上游结果竞争，以及双实例重复回捞。
- **降级/补偿/容量/观测**：元数据写失败不改变已交付回复，保留可回捞的 ID 和计费快照；按现有 pino 记录 ID、阶段、耗时和错误，禁止正文/密钥/完整原始 JSON。回填分批并核对数量、空值和尺寸；索引仅服务 generation ID 与回捞查询，先看查询计划和锁影响。
- **发布顺序**：新增表/权限 → Backend 兼容读写 → 安全回填与核对 → 新读路径/视图 → 停旧写并证明无引用 → 单独清理旧列。若任一步校验失败，停止清理、保留旧列并 forward-fix；删列后不以回滚旧 Backend 作为恢复手段。每个 migration 单文件经手工 workflow 先 TEST 后 Production，Production 需另行审批与验收。
