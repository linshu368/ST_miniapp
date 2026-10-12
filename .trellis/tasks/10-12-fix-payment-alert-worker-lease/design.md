# 技术设计

## 最小方案

新增 Backend 内部 lease helper，使用现有 `pg` 依赖的单一 `Client`。同一 client 连接后执行
`pg_try_advisory_lock(key)`；只有成功持锁才执行一轮监控与投递。在 `finally` 中由该 client
执行 `pg_advisory_unlock(key)` 并 `end()`。连接意外断开时 PostgreSQL 自动释放 session lock。

不使用 Prisma pool 管理 session lock：pool 无法保证 unlock 回到 acquire 的连接。不使用
transaction lock：当前轮包含 Supabase REST 与飞书 HTTP，不能将外部 I/O 包入长事务，且 Publisher
使用独立 Prisma 事务。

## 可靠性与恢复

- 连接建立和 acquire 有明确超时；未持锁是正常跳过。
- 执行业务回调、unlock 或 close 任一失败均优先保留原错误并记录安全摘要；close 总会尝试。
- 单轮仍保持既有订单扫描、飞书 timeout、outbox 幂等和 60 秒循环；锁 helper 不接触支付写路径。
- 回滚为部署前一 Worker 版本，但该版本可能重新出现连接池耗尽；优先 forward-fix。

## 验证

对 fake pg client 断言 acquire/unlock 使用同一对象，callback 异常仍 unlock/close，未获锁不执行
callback，连接失败不执行 callback。运行 Backend typecheck、相关测试和 diff check。生产部署后只观察
心跳、`payment.alert_monitor.failed`、`payment.alert_monitor.overlap` 与 delivery/outbox 结果。
