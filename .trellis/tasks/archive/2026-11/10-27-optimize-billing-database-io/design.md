# 设计

## 证据、复用与边界

生产事故窗口的高占比是 I/O wait，不是 user/system CPU。`billing.charge_llm_usage` 累计读取约 1.1 TiB；其交付资格函数按 `chat_history.llm_charge_id` 过滤，但事故时该列无索引，EXPLAIN 需要扫描约 5,559 个请求并逐行回查 `chat_history`。同期 30 秒补偿任务长期运行，反复放大这条缺索引路径。

复用已经完成并发布的上游修复 `fix(chat): bound billing lookups and reduce preparation waits`，以及其失败清理 follow-up；不在当前落后分支复制第二份实现。权威 migration 是 `20261027_chat_charge_lookup_index.sql`，生产账本 checksum 必须与 Git blob 一致。

## 最小充分方案

1. `experience.chat_history(llm_charge_id) WHERE llm_charge_id IS NOT NULL` 使用非唯一部分 B-tree，直接服务等值过滤；不增加 `INCLUDE` 或复合列，避免不必要写放大。
2. 使用 `CREATE INDEX CONCURRENTLY`，不包事务；设置 5 秒锁等待、5 分钟语句预算、32 MiB maintenance memory，并关闭并行维护以限制构建尖峰。
3. 取消轮询只读取 `status,llm_finish_reason`，避免每秒读取/解 TOAST prompt 与回复。
4. 会话准备只并行真正独立的上下文读取与身份/观测写；prompt 持久化仍在派发前强制 await，失败清理必须 join 所有准备写入。

第二阶段生产发布后数据表明：索引修复已把计费 RPC 降至约 2.51ms/次，但 sync job 每轮仍扫描约 44—45 条，其中约 39 条不完整记录被串行重复处理，完整轮次约 12—18 秒。生产只读 EXPLAIN 显示待结算扫描成本约 260、OpenRouter 元数据扫描成本约 85，均使用 `created_at` 索引；没有证据支持继续增加索引。热点已转为应用层 N+1、重复上游请求和无变化写入。

第二阶段最小方案：

1. `OpenRouterChatHistoryRepository` 增加最多 50 个 ID 的批量元数据读取，一轮一条 PostgREST 查询替代逐行读取。
2. 记录处理抽成独立结果，复用既有 `runSettledWithConcurrency`，并发固定为 3；每轮 provider fetch 预算固定为 9，使单次 5 秒上游超时的冷积压仍受控在一个调度周期内。扫描仍固定为 2，两个阶段不重叠占池；预算外记录不计失败、不增加退避次数，下一 tick 优先继续。
3. 对 `not_ready` / provider error 记录保存进程内 advisory backoff。指纹仅含 provider、generation ID、业务 status、finish reason、charge ID；字段变化立即绕过旧退避。30s/60s/120s/240s 后重试，24h 清理，最多 2,000 条。
4. stale streaming 永远直接恢复。OpenRouter 无 finish reason 时不进入 `reconcileCharge`，避免无意义 charge lookup 与空 update；只有新 provider payload 才 enrich/upsert。
5. 单轮日志汇总 scanned/eligible/deferred/completed/error/notReady/failed/duration，不再为每条未就绪记录写 info。

拒绝方案：不新增队列、表、持久化重试状态、环境变量或通用调度框架；不扩大连接池或超时；不对低成本扫描凭猜测加索引；不把 45 条全并发，以免用更短墙钟时间换数据库/供应商尖峰。

## 可靠性

- 超时/锁：并发索引只持有短 catalog lock；锁等待或 5 分钟预算失败即停止。
- 幂等/结果未知：同名有效索引允许重入；postflight 验证 valid/ready、单列 B-tree 与谓词。无效或异常 shape 阻断记账，先人工核对。
- 并发/事务：不改变收费 RPC、行锁和幂等键；并发准备 promise 均被 await/回收，不能产生未处理拒绝或失败后晚写。
- 降级/恢复：应用回退时保留兼容索引。确需移除时另审 `DROP INDEX CONCURRENTLY`；不因应用回滚删除索引。
- 容量/可观测：用 EXPLAIN、pg_stat_statements 增量、慢日志和 Railway 请求耗时验证；累计统计不能冒充发布后窗口。
- 超时/有限重试：单次 provider/DB 超时沿用现有 5 秒；job 不在单轮内部重试，上游未就绪通过跨轮指数退避处理。
- 幂等/并发：收费仍由 charge ID 与现有 RPC 保证幂等；同进程 `isRunning` 防重入，3 路 worker 只处理不同 history ID。多副本各自退避最多带来重复尝试，不成为正确性来源。
- 降级/恢复：内存状态在重启时丢失只会提前多尝试一次；达到上限按最旧访问淘汰。stale streaming 不进退避，避免持久预留无人回收。
- 补偿/限流：24h 窗口和 30 秒扫描频率不变；指数退避把长期未就绪记录的 provider/DB 请求频率从每 30 秒降到稳定每 4 分钟。
- 失败隔离：批量读取失败只影响 OpenRouter 记录并记录原始错误；单行失败不取消同批其他记录，下一轮按未退避路径重试。

## 演进与发布

第一阶段顺序为 TEST 单文件迁移与查询计划 → dev/main 应用发布 → Production 单文件迁移 → Railway 健康与短窗口观测，已经完成。第二阶段在当前分支实现 sync job 应用层降压，不含 migration；先跑本地既有测试/typecheck/build，再由后续独立发布门禁决定是否同步 main 和部署。上线后以 `chathistory_sync.finished` 的 duration、eligible/deferred、provider fetch 数和 Supabase I/O 增量复测；若冷启动仍超 10 秒或前台延迟回升则停止放大并发并 forward-fix。
