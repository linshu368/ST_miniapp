# 事故与发布证据（2026-10-27，Asia/Shanghai）

## 事故窗口

- 数据库图中高位曲线是 I/O wait；user/system CPU 很低。
- 02:12—05:02 的 `charge_llm_usage` 有 190 条 >10s 慢计划，135 条 >=30s，p50 约 39.39s、p95 约 73.33s、最大约 101.25s。
- 截至约 14:48 的累计统计：327,646 次、总执行约 33,043,400.6ms、shared reads 143,872,587 blocks（约 1.10 TiB）。
- 原查询计划由 `chat_generation_requests` 扫描约 5,559 行并逐行按 `chat_history_pkey` 回表过滤 `llm_charge_id`，总成本约 10,737.9。
- sync job 每 30 秒触发；窗口内约 85.77% 时间处于 active，302 个 tick 因前轮未完成跳过，255 次 reconcile 失败。它是主要放大器，但不是唯一后台负载。
- 关联请求 `85a0442a-55b3-4ad9-a653-b09e4723639d` 对应 02:25:28 左右 regenerate，服务端约 12 秒，并与一轮约 39.5 秒的同步计费慢调用重叠。

## 已复用发布

- upstream commit `d0fdddcc` / `e4a4c576`：部分索引、窄取消轮询、准备阶段依赖内并行。
- follow-up `ebabfec7`：失败清理前 join 准备写，避免失败事实被晚到写覆盖。
- Production Railway 目标 main commit：`88cd811b46c2e9421875a1e9182c5efc6b7ab0eb`。
- migration Git blob SHA-256：`f17a16da5cb504a2b41515a74bb8709110eecf25336ee561960db3b14f68bd18`。

## 15:04 只读 postflight

- TEST ref：`zoqelpfhurwehlvypryl`；索引 `experience.idx_chat_history_llm_charge_id`，valid/ready/live 均为 true，部分谓词为 `llm_charge_id IS NOT NULL`，当时大小约 80 KiB。
- Production ref：`wbtsfzozlmurljvglhpn`；账本记录 `20261027_chat_charge_lookup_index.sql`，applied_at `2026-10-27 14:56:16.535566+08`，checksum 与 Git blob一致。
- Production EXPLAIN：先走 `idx_chat_history_llm_charge_id`，再走 `chat_generation_requests_pkey`，总成本约 5.15；相比事故前约 10,737.9，计划成本下降约 99.95%。
- 14:56:39 完成的三条旧慢调用（约 31.6s/62.1s/114.4s）是在索引完成附近结束的在途请求，不能归为发布后新请求。14:57—15:05 尚未观察到新的 >10s 同类慢计划；窗口过短，仍需高峰复测。

## 15:07—15:10 发布后短窗口

- Railway `stminiapp` deployment `972a294f-a497-4f52-b2a7-684a84518889`、main commit `88cd811b46c2e9421875a1e9182c5efc6b7ab0eb` 于 15:07:15+08 SUCCESS；其余四个任务服务同批 SUCCESS，无 pending work。
- 新容器 15:07:16 监听 8080，`/health` 15:07:49 返回 200/5ms。切换瞬间出现一次旧实例 connection refused 502，随后同一路径 230ms 恢复；另有未授权 Vercel preview origin 的 CORS 500，与数据库修复无关。
- Production 索引大小约 10 MiB；`pg_stat_user_indexes` 已记录 1,162 次扫描、1,289 tuples read，证明不是仅创建未使用。
- 15:04 基线到 15:09：`charge_llm_usage` 增加 263 calls、660.62ms，总体约 2.51ms/次；shared reads 增加 153 blocks，约 0.58 block/次。事故累计均值约 102.8ms；该短增量下降约 97.6%。
- 14:57—15:10 的 Postgres 日志中没有新的 `charge_llm_usage` duration 慢计划。
- 新容器最近四个完整 sync run 约 18.4s、14.8s、17.8s、16.1s（p50 约 17s），事故窗口 p50 约 152s；39 条 not-ready 仍被重复扫描，作为下一次高峰复测的候选降压项，不在当前发布继续叠加调度变更。
- Supabase performance advisor 未将新索引列为 unused；其余既有缺索引 FK/unused index 建议是全库存量，不能据此批量加删索引。

限制：TEST MCP 角色无权对 `chat_generation_requests` 执行 EXPLAIN；TEST 仅完成 catalog shape/valid/ready 核验。Production EXPLAIN 与真实索引扫描计数提供运行证据，上游发布任务另记录本地 PG17 30 万虚构行回归。

## 第二阶段 sync job 深度优化（本地，未部署）

- 发布后每轮约 44—45 条，约 39 条为 provider not-ready；逐条串行导致完整轮次约 12—18 秒，并每 30 秒重复同一批工作。
- Production 只读 EXPLAIN 显示：待结算主表扫描走 `idx_chat_history_created_at`，计划成本约 260；OpenRouter 待补元数据扫描走 `openrouter_chat_history_created_at_idx`，计划成本约 85。两者均为有界 24h/limit 50 扫描，没有证据支持继续增加索引。
- 旧路径对每条 OpenRouter 记录先单独读专表，再请求 provider；即使没有 finish reason，仍进入 charge lookup、空计费回写，并通过通用 upsert 重走 placeholder/CAS/read-back。长期 not-ready 行因此同时放大数据库读写、provider 调用和 Railway 日志。
- 本地修复改为每 50 个 ID 一次批量读取；记录最多 3 路并发，每轮最多 9 次 provider fetch。预算外候选不算失败、不增加退避，下一 tick 继续。
- provider 未就绪采用业务指纹退避：30/60/120/240 秒，状态/provider/generation/finish/charge 变化立即解锁；stale streaming 永远不退避。Map 只作 advisory throttle，24h TTL、2,000 条上限，进程重启丢失只会多尝试一次。
- provider payload 与已存事实相同则不补写 observation/明细；没有终态 finish reason 时不读取 charge、不空写主表。已知 generation 的 metadata 用双 ID 守卫单次 update，避免每次重复身份 CAS/read-back。
- 单条 success/not-ready info 日志合并为 `chathistory_sync.finished`，记录 scanned/eligible/deferred/provider-budget/completed/not-ready/failed/retry-state/duration；原始异常仍按 `{ err }` 记录。
- 本地验证：sync/repository 定向 43 tests、backend 全量 102 files / 924 tests、backend typecheck、定向 ESLint、Prettier、migration lint 和 diff check 通过。根 `lint:imports` 脚本因当前 ESLint 将 `--rule '{}'` 解析为字符串而退出 2，属于既有工具命令问题；本轮未修改工具链。Backend 无独立 build 脚本。
- 预期而非线上事实：相同 39 条 not-ready 记录在稳定退避阶段，provider 轮询频率最多由每 30 秒一次降到每 4 分钟一次（约 8 倍）；逐行专表读取由最多 50 次降为 1 次。实际 duration/I/O 必须在后续独立 Railway 发布后复测。

## 官方参考

Supabase《Managing Indexes in Postgres》说明普通 CREATE INDEX 会阻塞表写入；大表在线构建应使用 `CREATE INDEX CONCURRENTLY`，代价是构建更久。部分索引适用于只查询行子集的模式。本任务等值条件天然排除 NULL，故采用非空部分索引。
