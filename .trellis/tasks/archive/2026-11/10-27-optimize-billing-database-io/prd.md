# 降低计费链路数据库 IO 并稳定服务

## Goal

基于 2026-10-27 02:12—05:02（北京时间）的生产证据，消除计费资格查询的无界扫描，降低会话准备、取消轮询和 30 秒补偿任务的数据库 I/O，并确认修复已安全进入 TEST、Production 与 Railway 主服务。第二阶段继续把已降至约 12—18 秒的 sync job 压缩为有界、可退避的恢复任务。

## Requirements

- 只处理有生产查询计划和日志证据支持的瓶颈，不把 Grafana、模型供应商或普通 CPU 使用率写成唯一根因。
- `billing.chat_delivery_billing_gate` 按 `experience.chat_history.llm_charge_id` 查找时必须使用有效、ready 的部分 B-tree 索引。
- 大表建索引不得阻塞正常写流量；失败、无效索引、账本结果未知时必须停止并先对账，禁止盲目重跑或自动删除。
- 不改变首字、计费、免费额度、取消、恢复与请求身份语义；不新增周期任务、缓存真相源或公开 API。
- TEST 与 Production 分别核对 shape、账本和查询计划；Railway 发布须核对目标 commit、健康状态和发布后错误。
- 当前分支若落后于已经合并、已上线的同一修复，不重复实现或创建第二个索引；只记录权威上游版本及验证结果。
- sync job 必须消除逐行读取 OpenRouter 已存元数据的 N+1，单次批量读取最多 50 行；记录处理最多 3 路并发，每轮最多发起 9 次 provider 查询，不能占满共享连接池或在冷积压时无限延长。
- 对上游仍未就绪且本地业务指纹未变化的记录采用进程内指数退避，30 秒起步、最多 4 分钟；缓存必须有 24 小时 TTL 和 2,000 条硬上限，重启丢失不影响正确性。
- stale streaming 恢复不能被退避；记录的 provider、generation、状态、结束原因或 charge 变化时必须立即恢复处理。
- 不完整上游数据未变化时不得重复写观测、计费结果或 OpenRouter 明细；逐行成功/不完整 info 日志改为单轮汇总，错误仍保留 `{ err }` 和安全链路 ID。
- 不新增数据库对象、环境变量、队列或持久化缓存；不改变计费幂等、免费额度、业务 finish reason 与 24 小时回捞窗口。

## Acceptance Criteria

- [x] TEST 与 Production 的 `idx_chat_history_llm_charge_id` 均为 `indisvalid=true`、`indisready=true`，定义为非空部分 B-tree。
- [x] Production 等值查询计划从全表/逐行回表路径变成 `idx_chat_history_llm_charge_id` Index Scan，并记录计划成本变化。
- [x] migration 文件 SHA-256 与 Production `repo_migrations` checksum 一致，避免仓库/账本漂移。
- [x] Railway `stminiapp` 发布包含聊天准备阶段降压修复并进入 SUCCESS；启动和短窗口日志无新增结构性错误。
- [x] 记录发布后短窗口慢查询情况；明确短窗口不能代替业务高峰复测。
- [x] 不在当前分支重复复制已合并的产品代码；如需同步分支，交由后续独立 merge/rebase 处理。
- [x] sync job 批量读取 OpenRouter 已存元数据，50 条候选不再产生 50 次读取。
- [x] 冷启动单轮采用最多 3 路记录并发和 9 次 provider 查询预算；同一批不完整记录的后续轮次被指数退避，业务指纹变化可提前解除，预算外候选留给下一 tick。
- [x] 未取得 finish reason 时不再查询/写回计费结果；相同不完整 provider payload 不重复 upsert 或补写观测。
- [x] 现有 sync/repository 测试覆盖批量读取、并发上限、退避、状态变化解锁和 stale streaming 例外；backend typecheck、全量测试及适用 lint/format 通过；backend 无独立 build 脚本。
- [x] 本轮仅交付本地代码和验证证据；Production 发布与发布后时长/I/O 复测需单独确认。
