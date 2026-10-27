# 发布后核对

## 结论

第一阶段针对性优化已生产生效：计费资格按 charge identity 的无界访问已变为 10 MiB 部分 B-tree 索引查找；会话取消轮询和准备阶段 I/O/串行等待也随 main `88cd811` 发布。发布后证据进一步确认 sync job 长期重复处理约 39 条 not-ready 记录，因此第二阶段已完成本地代码优化，但尚未部署。

## 验证

- TEST/Production index：valid/ready/live=true，单列非唯一 B-tree，谓词 `llm_charge_id IS NOT NULL`。
- Migration：Production ledger 文件名、checksum、Git blob 三方一致。
- Production plan：总成本约 10,737.9 → 5.15，Index Scan 命中目标索引。
- 真实增量：263 次计费调用约 2.51ms/次、0.58 shared read block/次；目标索引已有 1,162 scans。
- 慢日志：索引完成后 14:57—15:10 无新增同类 duration 记录。
- Railway：主服务和四个任务服务 SUCCESS；健康检查 200/5ms；最近 sync run 约 12—18s。

## 发布/恢复

索引和应用均已生产发布。应用回退可保留兼容索引；若索引出现损坏或异常写放大，先核对 `indisvalid/indisready`、账本和查询计划，再以单独受审迁移 `DROP INDEX CONCURRENTLY` 或 forward-fix，禁止在事故中直接删除。当前无需回滚。

## 剩余观察

短窗口不代表凌晨高峰。第二阶段发布需独立确认；发布后重点观察 `chathistory_sync.finished` 的 duration、eligible/deferred/providerBudgetDeferred、skip ticks，及 Supabase I/O wait、`charge_llm_usage` 增量 reads/mean。若冷启动仍超过 30 秒或前台延迟回升，停止提高并发并 forward-fix；当前不引入持久化重试表。

## 第二阶段本地交付

- OpenRouter 已存事实按 50 个 ID 批量读取，移除逐行读取入口。
- 记录最多 3 路并发；每轮最多 9 次 provider fetch，预算外候选下一 tick 继续。
- not-ready 按业务指纹 30/60/120/240 秒退避，24h TTL、2,000 条上限；状态变化立即解锁，stale streaming 永不延迟。
- 无 finish reason 不再读取 charge 或空写计费结果；相同 provider payload 不重复写 observation/明细。
- 定向 43 tests、backend 全量 924 tests、backend typecheck、定向 ESLint/Prettier、migration lint 通过。根 `lint:imports` 存在既有空 rule 参数兼容问题；backend 无 build 脚本。
