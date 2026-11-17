# 聊天历史读取优化与发布恢复

本实现保留全部历史、原始 prompt、生成身份与账务。只将页面需要的精确 request 字符串、开场白保存为可重建投影；分页先按现有索引选择 K+1 个逻辑轮次及其最新 revision，再加载正文、编辑/删除、点赞与继承覆盖。UI 游标及 shared DTO 不变，不使用 OFFSET、总数查询或历史截断。

## 数据与读写约束

- `experience.chat_history_display_metadata` 以 history ID 为主键，随原记录硬删除；`projection_version=1` 包含已知 NULL，0 表示失效。原记录仍是唯一事实来源。
- 原 `begin_chat_generation_observation` RPC 在同一事务中，从**实际接受的输入**维护投影。保持原身份、charge、快照校验及 SECURITY INVOKER；service_role 因此需要小表 SELECT/INSERT/UPDATE，不能只授予 SELECT，也不能为方便改成 SECURITY DEFINER。不合成 generation request，不改写原 request 字符串。
- 旧 writer 的 `UPDATE history` 只使已有投影失效，不比较或解析 OLD/NEW JSON。新 writer 随后原子刷新；初始请求重放不赋值 history，因此不抹掉已冻结开场白。
- 正常投影读取不计算 history JSON；缺失/失效时在同一语句中解析原前两个元素，保持历史语义。兼容读取保证正确性，**未回填范围仍有解压成本**，不能当作最终性能状态。
- 页面 RPC 校验 owner/软删除，限制每页 1–100 轮；session overlay 保持原分支冻结 ID、最大 revision、覆盖/点赞/预览规则。上下文窗口仍只影响入模，不影响用户翻看历史。
- recover/require/finalize 去掉无 consumer 的 history 返回；账务快照与原恢复状态机保留。取消使用投影读取身份；真正的 prompt 与入模内容不裁剪。
- 只读页请求总预算 8 秒，最多两次、每次最多 5 秒；仅明确连接重置等传输故障重读，SQL 超时、未知 abort、鉴权/业务错误不重试。客户端断开取消页读取。identity/owner/settings/recover/opening/page 各阶段记录耗时，不记录正文。

## 手动发布顺序

所有远端 SQL 按 `packages/shared/migrations/README.md` 的逐文件 TEST → production 流程；本地 PostgreSQL 不代替正式 TEST。连接目标必须核对，禁止通过 Supabase MCP 读取业务行或写数据库。

1. 记录目标版本、原 admission 定义、权限/RLS、现有 writer 与容量；生产旧表 RLS/ACL 的既有差异单独评估，不在本次隐式更改。
2. 先执行 `20261111_chat_history_display_metadata.sql`，再执行 `20261111_chat_history_display_reads.sql`。迁移设置 lock/statement timeout；未知 admission 锚点会失败回滚，不能强行覆盖。
3. 在正式 TEST 验证原 admission、首字准备、账务、取消/恢复与权限，再批准生产扩展。小表有额外写入成本，必须观测准备/写入 P95。
4. 批准容量和时间窗口后，运行同一 migration 来源目录中的 `maintenance/chat_history_display_backfill.sql`。这是有限人工维护文件，不是后台任务，也不由 schema ledger 自动执行。每次至多 100 批 × 100 行，每批独立事务、3 秒 statement / 500 ms lock 预算；锁住原行后解析，SKIP LOCKED 不阻塞活跃写入，不 UPDATE history、不触发会话统计。
5. 每次只打印 attempted/completed/skipped 聚合。失败立即停止，已提交批次保留；再次批准执行时从未覆盖记录重新扫描，重访跳锁记录，不把跳过视为完成。大于 10,000 行的剩余数据分次处理，无一次性大事务或 100 行一个永久文件。
6. 用获准的运维连接核验普通/深页/最早页覆盖、旧 writer、缺口数量及容量。发布 cohort 要求有效覆盖且 fallback=0；无样本保持 NULL。移动 Android/iOS 页面/接口及生成准备的成对基线均不退化后，才切换 Backend 读路径。
7. Frontend 的引导按需加载、旧 WebView 查找兼容、身份捕获与错误恢复可独立发布。`FRONTEND_ALLOWED_ORIGINS` 是逗号分隔的**精确 origin**；正式 Vercel 前端域名须在现有 FRONTEND_URL 或此列表中。部署配置本身不由代码修改自动生效。

## 恢复

只读异常：恢复旧 Backend、停止回填，保留原历史及小表。旧 Backend 的 admission 仍可能使用新数据库函数，所以这不等于撤回写维护。

写维护异常：先确保全部实例使用旧读取、停止回填，再按审批执行 `maintenance/chat_history_display_write_recovery.sql`。它锁定 history 防止并发穿透，精确撤回新增 admission 分支、移除失效 trigger、把投影标记为无效并撤销新读取权限；原 history、计费、generation observations 和投影字符串保留。未知锚点、拿不到锁或大表失效更新超过 30 秒均整笔回滚；应先核验容量，不能反复重试抢锁。

恢复后重新启用：重新审核并应用两份扩展迁移，有限重建失效投影，重新验证全覆盖及读写 P95，最后部署新读取。不要只恢复 SELECT 权限就信任停止维护期间的投影。

## 可重复本地检查

`bash scripts/test-conversation-branches-migration.sh` 使用一次性 PG17（默认 Docker、无网络）。Windows 可显式设置本地 `ST_CHAT_PG_BIN`、`ST_CHAT_PG_PORT`，脚本固定连接 127.0.0.1，创建随机数据库并在结束时删除，不读取仓库连接配置。`ST_CHAT_BENCHMARK=1` 增加虚构长历史基准；结果不能当作生产 P95。

该 harness 覆盖原分支/编辑/点赞、字段等价、完整游标、失效/已知 NULL、真实 admission 与初始重放、权限、有限回填、数据库写恢复和重新启用。`pnpm test:ui --grep '@chat|@roleplay'` 复用既有移动端验收；新增 `@chat-history` 覆盖无 findLast 的 200 轮完整翻页及草稿保留。真实 Telegram 键盘、供应商/账务与 Android/iOS 生产性能仍需正式环境验收。
